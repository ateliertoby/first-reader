// Agent daily report pipeline — B2 of the agent loop

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentDB } from './db.js';
import { loadAgentConfig } from './config.js';
import { loadRules, classify } from '../sorter/rules.js';
import { SortLogDB } from '../sorter/db.js';
import { groupMoved, groupKept, markNovelty } from '../commands/report.js';
import { graphGet, graphPost, buildGraphUrl } from '../graph.js';
import { renderReport } from './llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  statePath: path.join(__dirname, '..', '..', 'data', 'sort-state.json'),
  sortDbPath: path.join(__dirname, '..', '..', 'data', 'transactions.db'),
  agentDbPath: path.join(__dirname, '..', '..', 'data', 'agent.db'),
  notesPath: path.join(__dirname, '..', '..', 'config', 'agent-notes.md'),
  outboxDir: path.join(__dirname, '..', '..', 'data', 'agent-outbox'),
};

function loadSortState(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function loadNotes(p) {
  try { return fs.readFileSync(p, 'utf8'); }
  catch { return ''; }
}

function ageDays(isoDate, now) {
  return Math.floor((new Date(now) - new Date(isoDate)) / 86_400_000);
}

// Window is wall-clock over sort_log run_at — the log only ever contains what
// sort has processed, so no processedThrough coupling is needed. The 15min end
// buffer keeps a sort run that is mid-flight (rows share its start timestamp)
// entirely out of this window; it lands whole in the next one.
function computeWindow(agentDb, sortState, now) {
  if (!sortState || !sortState.processedThrough) {
    return { degraded: true, reason: 'sort has never run — no processedThrough in sort-state.json' };
  }
  const d = new Date(now);
  d.setTime(d.getTime() - 15 * 60_000);
  const windowEnd = d.toISOString();
  const last = agentDb.lastRun('report');
  let windowStart;
  if (last && last.window_end) {
    windowStart = last.window_end;
  } else {
    const f = new Date(now);
    f.setTime(f.getTime() - 24 * 3_600_000);
    windowStart = f.toISOString();
  }
  return { windowStart, windowEnd };
}

async function fetchJunkMessages(windowStart) {
  const params = {
    top: 100,
    orderby: 'receivedDateTime desc',
    select: 'id,subject,from,receivedDateTime',
    filter: `receivedDateTime ge ${windowStart}`
  };
  const url = buildGraphUrl('/me/mailFolders/junkemail/messages', params);
  let result = await graphGet(url);
  let messages = [...result.value];
  while (result['@odata.nextLink']) {
    result = await graphGet(result['@odata.nextLink']);
    messages.push(...result.value);
  }
  return messages;
}

function buildDegradedMessage(reportJson) {
  const parts = ['[degraded]'];
  const { sort } = reportJson;
  if (sort.moved.length > 0) {
    const total = sort.moved.reduce((s, g) => s + g.count, 0);
    const items = sort.moved.map(g => `${g.ruleId} ${g.count}`).join(', ');
    parts.push(`sort: ${total} moved (${items})`);
  } else {
    parts.push('sort: 0 moved');
  }
  if (sort.guardBlocked.length > 0) {
    parts.push(`${sort.guardBlocked.length} guard-blocked`);
  }

  const openR = reportJson.reminders.filter(r => r.status === 'open');
  if (openR.length > 0) {
    parts.push('reminders: ' + openR.map(r => `${r.kind} ${r.age_days}日`).join(', '));
  }

  const pending = reportJson.junk.filter(j => j.flag !== 'rescued-rule');
  if (pending.length > 0) parts.push(`junk: ${pending.length} pending`);
  const rescued = reportJson.junk.filter(j => j.flag === 'rescued-rule');
  if (rescued.length > 0) parts.push(`junk rescued: ${rescued.length}`);
  if (reportJson.questions.length > 0) parts.push(`questions: ${reportJson.questions.length} open`);
  parts.push('LLM 唔喺度，建議缺席');
  return parts.join(' / ');
}

export async function runAgentReport({
  dry = false,
  // Test injection points (underscore = internal)
  _agentDbPath, _sortDbPath, _statePath, _notesPath,
  _outboxDir, _rulesPath, _agentConfigPath, _now
} = {}) {
  const now = _now ?? new Date().toISOString();
  const statePath = _statePath ?? DEFAULTS.statePath;
  const sortDbPath = _sortDbPath ?? DEFAULTS.sortDbPath;
  const agentDbPath = _agentDbPath ?? DEFAULTS.agentDbPath;
  const notesPath = _notesPath ?? DEFAULTS.notesPath;
  const outboxDir = _outboxDir ?? DEFAULTS.outboxDir;

  const sortState = loadSortState(statePath);
  const agentDb = new AgentDB(agentDbPath);

  try {
    const win = computeWindow(agentDb, sortState, now);

    if (win.degraded) {
      if (dry) {
        console.log(`Degraded: ${win.reason}`);
      } else {
        agentDb.logRun({
          run_at: now, kind: 'report',
          window_start: null, window_end: null,
          status: 'degraded', detail: win.reason
        });
      }
      return { status: 'degraded', reason: win.reason };
    }

    const { windowStart, windowEnd } = win;
    const config = loadRules(_rulesPath);

    // --- Sort section ---
    const logDb = new SortLogDB(sortDbPath);
    const sortRows = logDb.db.prepare(
      'SELECT * FROM sort_log WHERE run_at >= ? AND run_at <= ?'
    ).all(windowStart, windowEnd);

    const moved = groupMoved(sortRows, config, now);
    markNovelty(moved, logDb, windowStart);
    for (const g of moved) delete g._rows;

    const guardBlocked = sortRows.filter(r => r.action === 'guard-blocked');
    const noparse = sortRows.filter(r => r.action === 'moved' && r.parsed === 0);
    const unsorted = sortRows.filter(r => r.action === 'unsorted');
    const runErrors = sortRows.filter(r => r.action === 'run-error');
    const kept = groupKept(sortRows);
    for (const g of kept) g.historicalCount = logDb.domainHistory(g.domain);

    const keptRuleCount = sortRows.filter(r => r.action === 'kept-rule').length;
    const pinnedCount = sortRows.filter(r => r.action === 'pinned').length;
    logDb.close();

    // --- Reminders ---
    const reminderRuleIds = new Set();
    for (const rule of config.rules) {
      if (rule.note && rule.note.includes('reminder-class')) {
        reminderRuleIds.add(rule.id);
      }
    }

    if (!dry) {
      for (const row of sortRows) {
        if (row.action === 'moved' && reminderRuleIds.has(row.rule_id)) {
          agentDb.addReminder({
            kind: row.rule_id,
            source_email_id: row.email_id,
            subject: row.subject,
            now
          });
        }
      }
    }

    // Expire reminders (read-only peek in dry mode)
    let expiredReminders = [];
    if (!dry) {
      expiredReminders = agentDb.expireReminders(now);
    } else {
      const cutoff = new Date(now);
      cutoff.setUTCDate(cutoff.getUTCDate() - 14);
      const cutoffIso = cutoff.toISOString();
      expiredReminders = agentDb.openReminders().filter(r => r.created_at <= cutoffIso);
    }

    const openReminders = agentDb.openReminders();
    const remindersForJson = [
      ...openReminders.map(r => ({
        id: r.id, kind: r.kind, subject: r.subject,
        created_at: r.created_at, age_days: ageDays(r.created_at, now), status: 'open'
      })),
      ...expiredReminders.map(r => ({
        id: r.id, kind: r.kind, subject: r.subject,
        created_at: r.created_at, age_days: ageDays(r.created_at, now), status: 'expired'
      }))
    ];

    // --- Questions ---
    if (!dry) agentDb.expireQuestions(now);
    const openQuestions = agentDb.openQuestions().map(q => ({
      id: q.id, domain: q.domain, question: q.question, asked_at: q.asked_at
    }));

    // --- Junk patrol ---
    const junkItems = [];
    const dryRescueLog = [];
    try {
      const junkMsgs = await fetchJunkMessages(windowStart);
      for (const msg of junkMsgs) {
        if (agentDb.isJunkDismissed(msg.id)) continue;
        const sender = msg.from?.emailAddress?.address || '';
        const subject = msg.subject || '';
        const received = msg.receivedDateTime || '';
        const age = ageDays(received, now);
        const cr = classify(sender, subject, config);

        if (cr.bucket && !cr.guarded) {
          // Auto-rescue on ANY unguarded rule match (keep included — a keep rule
          // is Toby's standing "I read these" order): deterministic, not an LLM op.
          // Move lands in inbox; the re-entry watermark files folder-bound ones.
          if (!dry) {
            await graphPost(`/me/messages/${msg.id}/move`, { destinationId: 'inbox' });
          } else {
            dryRescueLog.push(`  [would-rescue] ${sender} — ${subject} (rule: ${cr.ruleId})`);
          }
          junkItems.push({
            id: msg.id, sender, subject, received,
            flag: 'rescued-rule', rule_id: cr.ruleId, age_days: age
          });
        } else {
          junkItems.push({
            id: msg.id, sender, subject, received,
            flag: 'pending', age_days: age
          });
        }
      }
    } catch (err) {
      // Junk fetch failure is non-fatal — report still goes out
      console.error(`Junk patrol error: ${err.message}`);
    }

    if (dry) {
      for (const line of dryRescueLog) console.log(line);
    }

    // --- Report JSON ---
    const reportJson = {
      window: { start: windowStart, end: windowEnd },
      sort: { moved, guardBlocked, noparse, unsorted, runErrors, kept, summary: { keptRuleCount, pinnedCount } },
      reminders: remindersForJson,
      questions: openQuestions,
      junk: junkItems
    };

    // Persist for handler context (handler reads this for intent parsing)
    if (!dry) {
      const lrp = path.join(path.dirname(outboxDir), 'agent-last-report.json');
      fs.writeFileSync(lrp, JSON.stringify(reportJson, null, 2));
    }

    // --- Notes check ---
    const notesContent = loadNotes(notesPath);
    const lineCount = notesContent.split('\n').length;
    const notesWarning = lineCount > 60 ? `agent-notes.md 有 ${lineCount} 行，清理時間` : null;

    // --- LLM render ---
    let message;
    let status = 'ok';
    let degradedDetail = null;
    try {
      const agentConfig = loadAgentConfig(_agentConfigPath);
      const llmResult = await renderReport({ model: agentConfig.model, reportJson, notesContent });
      message = llmResult.message_text;

      // Apply LLM output (non-dry only)
      if (!dry) {
        for (const q of llmResult.new_questions || []) {
          agentDb.addQuestion({ domain: q.domain || null, question: q.question, now });
        }
        for (const r of llmResult.auto_resolved_reminders || []) {
          agentDb.resolveReminder(r.id, 'auto', now);
        }
      }

      // Merge LLM junk flags into items (advisory only — NO moves, iron rule)
      const VALID_JUNK_FLAGS = new Set(['pending-normal', 'pending-danger']);
      for (const f of llmResult.junk_flags || []) {
        const item = junkItems.find(j => j.id === f.id);
        if (item && item.flag === 'pending' && VALID_JUNK_FLAGS.has(f.flag)) {
          item.flag = f.flag;
          if (f.reason) item.reason = f.reason;
        }
      }

      if (notesWarning) message += `\n\n${notesWarning}`;
    } catch (err) {
      status = 'degraded';
      degradedDetail = err?.message || 'LLM failure';
      message = buildDegradedMessage(reportJson);
      if (notesWarning) message += ` / ${notesWarning}`;
    }

    // --- Delivery ---
    if (dry) {
      console.log(message);
    } else {
      if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir, { recursive: true });
      const safeTs = now.replace(/[:.]/g, '-');
      fs.writeFileSync(
        path.join(outboxDir, `${safeTs}.json`),
        JSON.stringify({ ts: now, text: message }, null, 2)
      );
      agentDb.logRun({
        run_at: now, kind: 'report',
        window_start: windowStart, window_end: windowEnd,
        status, detail: degradedDetail
      });
    }

    return { status, message, reportJson };
  } finally {
    agentDb.close();
  }
}

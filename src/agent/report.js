// Agent report pipeline — assemble phase (non-dry returns immediately, LLM
// render is async via pending_renders + sweep).  Dry mode keeps the synchronous
// callCliLLM path for shell use.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentDB } from './db.js';
import { loadAgentConfig } from './config.js';
import { loadRules, classify } from '../sorter/rules.js';
import { SortLogDB } from '../sorter/db.js';
import { groupMoved, groupKept, markNovelty } from '../commands/report.js';
import { graphGet, graphPost, buildGraphUrl } from '../graph.js';
import { renderReport, buildRenderPrompt } from './llm.js';
import { enqueueCliLLM } from './cli-transport.js';

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

// Write a single outbox message file.  Shared with render-sweep.
export function writeOutbox(outboxDir, text, now) {
  if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir, { recursive: true });
  const safeTs = now.replace(/[:.]/g, '-');
  fs.writeFileSync(
    path.join(outboxDir, `${safeTs}.json`),
    JSON.stringify({ ts: now, text }, null, 2)
  );
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

export function buildDegradedMessage(reportJson) {
  const summaryParts = ['[degraded]'];
  const { sort } = reportJson;
  if (sort.moved.length > 0) {
    const total = sort.moved.reduce((s, g) => s + g.count, 0);
    const items = sort.moved.map(g => `${g.ruleId} ${g.count}`).join(', ');
    summaryParts.push(`sort: ${total} moved (${items})`);
  } else {
    summaryParts.push('sort: 0 moved');
  }
  if (sort.guardBlocked.length > 0) {
    summaryParts.push(`${sort.guardBlocked.length} guard-blocked`);
  }

  const openR = reportJson.reminders.filter(r => r.status === 'open');
  if (openR.length > 0) {
    summaryParts.push('reminders: ' + openR.map(r => `${r.kind} ${r.age_days}日`).join(', '));
  }

  const pending = reportJson.junk.filter(j => j.flag !== 'rescued-rule');
  if (pending.length > 0) summaryParts.push(`junk: ${pending.length} pending`);
  const rescued = reportJson.junk.filter(j => j.flag === 'rescued-rule');
  if (rescued.length > 0) summaryParts.push(`junk rescued: ${rescued.length}`);
  if (reportJson.questions.length > 0) summaryParts.push(`questions: ${reportJson.questions.length} open`);

  const sections = [summaryParts.join(' / ')];

  // Deterministic subject list — best output when LLM is unavailable
  const subjectLines = [];
  for (const g of (sort.kept || [])) {
    for (const s of g.samples) {
      subjectLines.push(`${s.subject} (${g.domain})`);
    }
  }
  for (const f of (reportJson.fresh || [])) {
    subjectLines.push(`${f.subject} (${f.sender})`);
  }
  if (subjectLines.length > 0) {
    const cap = 15;
    const shown = subjectLines.slice(0, cap);
    let block = shown.join('\n');
    if (subjectLines.length > cap) block += `\n+${subjectLines.length - cap} more`;
    sections.push(block);
  }

  sections.push('LLM 唔喺度');
  return sections.join('\n\n');
}

export async function runAgentReport({
  dry = false,
  origin = 'check',
  // Test injection points (underscore = internal)
  _agentDbPath, _sortDbPath, _statePath, _notesPath,
  _outboxDir, _rulesPath, _agentConfigPath, _queueDir, _now
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
    // Single-open rule — only one render may be in flight at a time
    if (!dry) {
      const openPendings = agentDb.openPendings();
      if (openPendings.length > 0) {
        writeOutbox(outboxDir, '上一份報告整緊中，就嚟到', now);
        return { status: 'single-open' };
      }
    }

    const win = computeWindow(agentDb, sortState, now);

    if (win.degraded) {
      if (dry) {
        console.log(`Degraded: ${win.reason}`);
      } else {
        writeOutbox(outboxDir, `[degraded] ${win.reason}`, now);
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

    // --- Fresh peek — recent inbox emails not yet covered by sort window ---
    const freshItems = [];
    try {
      const agentConfig = loadAgentConfig(_agentConfigPath);
      const freshLookback = agentConfig.freshLookbackHours || 12;
      const freshSince = new Date(new Date(now).getTime() - freshLookback * 3_600_000).toISOString();

      const params = {
        top: 100,
        orderby: 'receivedDateTime desc',
        select: 'id,subject,from,receivedDateTime',
        filter: `receivedDateTime ge ${freshSince}`
      };
      const url = buildGraphUrl('/me/mailFolders/inbox/messages', params);
      let inboxResult = await graphGet(url);
      let inboxMessages = [...inboxResult.value];
      while (inboxResult['@odata.nextLink']) {
        inboxResult = await graphGet(inboxResult['@odata.nextLink']);
        inboxMessages.push(...inboxResult.value);
      }

      const sortRowIds = new Set(sortRows.map(r => r.email_id));

      for (const msg of inboxMessages) {
        if (sortRowIds.has(msg.id)) continue;

        const sender = msg.from?.emailAddress?.address || '';
        const subject = msg.subject || '';
        const cr = classify(sender, subject, config);

        // Ruled (any bucket, guarded or not) — completely invisible
        if (cr.bucket) continue;

        freshItems.push({
          id: msg.id,
          sender,
          domain: sender.toLowerCase().split('@').pop() || '',
          subject,
          received: msg.receivedDateTime || ''
        });
      }
    } catch (err) {
      // Graph fetch failure non-fatal — report proceeds without fresh data
      console.error(`Fresh peek error: ${err.message}`);
    }

    // --- Body fetch (recon-grade: report shows WHAT emails say, not just THAT they exist) ---
    // Targets: kept (unruled, inbox ids — valid), noparse (post-move ids — valid in Accounting),
    // junk pending items, fresh items. Cap: 25 bodies total, newest first.
    // Fetch failures per-item are non-fatal. Dry mode fetches too (read-only — no writes).
    const BODY_CAP = 25;
    const bodyTargets = [];

    // kept rows — use raw sortRows (email_id is inbox id, valid for unruled kept)
    const keptRows = sortRows.filter(r => r.action === 'kept');
    for (const row of keptRows) {
      if (row.email_id) bodyTargets.push({ id: row.email_id, received: row.received_at, source: 'kept' });
    }
    // noparse — post-move ids, valid in Accounting folder
    for (const row of noparse) {
      if (row.email_id) bodyTargets.push({ id: row.email_id, received: row.received_at, source: 'noparse', ref: row });
    }
    // junk pending (not rescued)
    for (const item of junkItems) {
      if (item.flag !== 'rescued-rule' && item.id) {
        bodyTargets.push({ id: item.id, received: item.received, source: 'junk', ref: item });
      }
    }
    // fresh items
    for (const item of freshItems) {
      if (item.id) {
        bodyTargets.push({ id: item.id, received: item.received, source: 'fresh', ref: item });
      }
    }
    // Sort newest first, then cap
    bodyTargets.sort((a, b) => (b.received || '').localeCompare(a.received || ''));
    const bodiesToFetch = bodyTargets.slice(0, BODY_CAP);
    const bodiesTruncated = bodyTargets.length > BODY_CAP ? bodyTargets.length - BODY_CAP : 0;

    // Map for kept rows (need to inject into kept groups post-hoc since groupKept creates new objects)
    const keptExcerpts = new Map();

    for (const target of bodiesToFetch) {
      try {
        const msgData = await graphGet(
          buildGraphUrl(`/me/messages/${target.id}`, { select: 'body,subject' })
        );
        let bodyText = msgData?.body?.content || '';
        if (msgData?.body?.contentType === 'html') {
          bodyText = bodyText.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
        }
        // Collapse whitespace and truncate
        bodyText = bodyText.replace(/\s+/g, ' ').trim();
        if (bodyText.length > 1200) bodyText = bodyText.slice(0, 1200);

        if (target.source === 'kept') {
          keptExcerpts.set(target.id, bodyText);
        } else {
          target.ref.body_excerpt = bodyText;
        }
      } catch {
        // Non-fatal — skip this item, no excerpt attached
      }
    }

    // Inject kept excerpts into kept group samples (match by subject+received since
    // groupKept samples don't carry email_id — rebuild via row lookup)
    if (keptExcerpts.size > 0) {
      const keptRowMap = new Map(keptRows.map(r => [r.email_id, r]));
      for (const [emailId, excerpt] of keptExcerpts) {
        const row = keptRowMap.get(emailId);
        if (!row) continue;
        for (const g of kept) {
          if (g.domain !== row.domain) continue;
          for (const sample of g.samples) {
            if (sample.subject === row.subject && sample.received === row.received_at) {
              sample.body_excerpt = excerpt;
            }
          }
        }
      }
    }

    // --- Report JSON ---
    const reportJson = {
      window: { start: windowStart, end: windowEnd },
      sort: { moved, guardBlocked, noparse, unsorted, runErrors, kept, summary: { keptRuleCount, pinnedCount } },
      reminders: remindersForJson,
      questions: openQuestions,
      junk: junkItems,
      fresh: freshItems,
      ...(bodiesTruncated > 0 ? { bodiesTruncated } : {}),
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
    if (dry) {
      // Synchronous path for CLI --dry use (blocking is fine in a shell)
      let message;
      let status = 'ok';
      let degradedDetail = null;
      try {
        const agentConfig = loadAgentConfig(_agentConfigPath);
        const llmResult = await renderReport({ model: agentConfig.model, reportJson, notesContent });
        message = llmResult.message_text;

        // Apply LLM output (display only in dry mode — no DB writes)
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

      console.log(message);
      return { status, message, reportJson };
    }

    // --- Async enqueue path (non-dry) — hand off to sweep ---
    const agentConfig = loadAgentConfig(_agentConfigPath);
    const { system, user } = buildRenderPrompt({ reportJson, notesContent });
    const requestId = enqueueCliLLM({
      kind: 'render', system, user,
      model: agentConfig.model,
      _queueDir,
    });

    agentDb.insertPending({
      created_at: now,
      origin,
      window_start: windowStart,
      window_end: windowEnd,
      request_id: requestId,
      report_json: JSON.stringify(reportJson),
      status: 'open',
    });

    return { status: 'pending', requestId };
  } finally {
    agentDb.close();
  }
}

// Agent report pipeline — assemble phase (non-dry returns immediately, LLM
// render is async via pending_renders + sweep).  Dry mode keeps the synchronous
// callCliLLM path for shell use.
//
// R1: mailbox-centric read stream.  The agent reads ALL new mail from every
// folder (except sent/deleted/drafts/outbox) via its own read_watermark,
// dedupes by internetMessageId, attaches dry classify attribution, and fetches
// bodies with priority ordering.  Sort activity from sort_log is supplementary.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentDB } from './db.js';
import { loadAgentConfig } from './config.js';
import { loadRules, classify } from '../sorter/rules.js';
import { SortLogDB } from '../sorter/db.js';
import { htmlToText } from '../sorter/html-text.js';
import { groupMoved, markNovelty } from '../commands/report.js';
import { graphGet, graphPost, buildGraphUrl } from '../graph.js';
import { renderReport, buildRenderPrompt } from './llm.js';
import { enqueueCliLLM } from './cli-transport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  sortDbPath: path.join(__dirname, '..', '..', 'data', 'transactions.db'),
  agentDbPath: path.join(__dirname, '..', '..', 'data', 'agent.db'),
  notesPath: path.join(__dirname, '..', '..', 'config', 'agent-notes.md'),
  outboxDir: path.join(__dirname, '..', '..', 'data', 'agent-outbox'),
};

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

// --- Read window from agent-owned watermark (not sort_log) ---

function computeReadWindow(agentDb, now) {
  const d = new Date(now);
  d.setTime(d.getTime() - 15 * 60_000);
  const windowEnd = d.toISOString();

  const watermark = agentDb.getState('read_watermark');
  let windowStart;
  if (watermark) {
    const wm = new Date(watermark);
    wm.setTime(wm.getTime() - 10 * 60_000); // 10min overlap for late arrivals
    windowStart = wm.toISOString();
  } else {
    // Bootstrap: look back 24h on first run
    const f = new Date(now);
    f.setTime(f.getTime() - 24 * 3_600_000);
    windowStart = f.toISOString();
  }
  return { windowStart, windowEnd };
}

// --- Graph helpers for folder scan ---

const EXCLUDED_WELL_KNOWN = ['sentitems', 'deleteditems', 'drafts', 'outbox'];

async function resolveWellKnownFolders() {
  const ids = new Map();
  const names = [...EXCLUDED_WELL_KNOWN, 'junkemail'];
  for (const name of names) {
    try {
      const f = await graphGet(buildGraphUrl(`/me/mailFolders/${name}`, { select: 'id' }));
      if (f && f.id) ids.set(name, f.id);
    } catch { /* folder may not exist — skip */ }
  }
  return ids;
}

async function fetchFolderMessages(folderId, startIso) {
  const params = {
    top: 100,
    orderby: 'receivedDateTime desc',
    select: 'id,subject,from,receivedDateTime,internetMessageId',
    filter: `receivedDateTime ge ${startIso}`
  };
  const url = buildGraphUrl(`/me/mailFolders/${folderId}/messages`, params);
  let result = await graphGet(url);
  let messages = [...result.value];
  while (result['@odata.nextLink']) {
    result = await graphGet(result['@odata.nextLink']);
    messages.push(...result.value);
  }
  return messages;
}

// --- Degraded template (LLM unavailable fallback) ---

export function buildDegradedMessage(reportJson) {
  const summaryParts = ['[degraded]'];

  // Sort activity stats
  const sa = reportJson.sortActivity;
  if (sa) {
    if (sa.moved && sa.moved.length > 0) {
      const total = sa.moved.reduce((s, g) => s + g.count, 0);
      const items = sa.moved.map(g => `${g.ruleId} ${g.count}`).join(', ');
      summaryParts.push(`sort: ${total} moved (${items})`);
    } else {
      summaryParts.push('sort: 0 moved');
    }
    if (sa.guardBlocked && sa.guardBlocked.length > 0) {
      summaryParts.push(`${sa.guardBlocked.length} guard-blocked`);
    }
  } else {
    summaryParts.push('sort: 0 moved');
  }

  const openR = (reportJson.reminders || []).filter(r => r.status === 'open');
  if (openR.length > 0) {
    summaryParts.push('reminders: ' + openR.map(r => `${r.kind} ${r.age_days}日`).join(', '));
  }

  // Junk stats (compat array)
  const pending = (reportJson.junk || []).filter(j => j.flag !== 'rescued-rule');
  if (pending.length > 0) summaryParts.push(`junk: ${pending.length} pending`);
  const rescued = (reportJson.junk || []).filter(j => j.flag === 'rescued-rule');
  if (rescued.length > 0) summaryParts.push(`junk rescued: ${rescued.length}`);
  if ((reportJson.questions || []).length > 0) summaryParts.push(`questions: ${reportJson.questions.length} open`);

  const sections = [summaryParts.join(' / ')];

  // Deterministic subject list from emails[]
  const emails = reportJson.emails || [];
  const subjectLines = emails
    .filter(e => !(e.junked && e.rescued)) // skip rescued junk
    .map(e => `${e.subject} (${e.sender})`);

  if (subjectLines.length > 0) {
    const cap = 15;
    const shown = subjectLines.slice(0, cap);
    let block = shown.join('\n');
    if (subjectLines.length > cap) block += `\n+${subjectLines.length - cap} more`;
    sections.push(block);
  }

  if (reportJson.scanIncomplete?.length) {
    sections.push(`scan incomplete: ${reportJson.scanIncomplete.join(', ')} — 嗰邊嘅新信下次補`);
  }

  sections.push('LLM 唔喺度');
  return sections.join('\n\n');
}

// --- Main entry point ---

export async function runAgentReport({
  dry = false,
  origin = 'check',
  // Test injection points (underscore = internal)
  _agentDbPath, _sortDbPath, _notesPath,
  _outboxDir, _rulesPath, _agentConfigPath, _queueDir, _now
} = {}) {
  const now = _now ?? new Date().toISOString();
  const sortDbPath = _sortDbPath ?? DEFAULTS.sortDbPath;
  const agentDbPath = _agentDbPath ?? DEFAULTS.agentDbPath;
  const notesPath = _notesPath ?? DEFAULTS.notesPath;
  const outboxDir = _outboxDir ?? DEFAULTS.outboxDir;

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

    const { windowStart, windowEnd } = computeReadWindow(agentDb, now);
    const config = loadRules(_rulesPath);
    const agentConfig = loadAgentConfig(_agentConfigPath);

    // Prune old seen entries (non-dry only)
    if (!dry) agentDb.pruneSeen(now);

    // ==================================================================
    // Read sweep: folder-independent mailbox scan
    // ==================================================================
    const emails = [];
    const junkCompat = [];     // backward-compat junk[] for handler + render-sweep
    const dryRescueLog = [];
    const localSeen = new Set(); // within-run dedupe
    const seenToInsert = [];     // batch into atomic transaction
    const scanFailures = [];     // folders that failed — blocks watermark advance

    const wellKnown = await resolveWellKnownFolders();
    const excludeIds = new Set();
    for (const name of EXCLUDED_WELL_KNOWN) {
      if (wellKnown.has(name)) excludeIds.add(wellKnown.get(name));
    }
    const junkFolderId = wellKnown.get('junkemail') ?? null;

    // List all top-level folders (no child-folder recursion in v1).
    // A list failure throws out of the assemble: nothing was read, so nothing
    // may be consumed — the trigger/idle error path reports it and the
    // watermark stays put for a full retry.
    const folderListResult = await graphGet(
      buildGraphUrl('/me/mailFolders', { top: 50, select: 'id,displayName' })
    );
    const folders = (folderListResult?.value || []).filter(f => !excludeIds.has(f.id));

    for (const folder of folders) {
      try {
        const isJunk = junkFolderId != null && folder.id === junkFolderId;
        const msgs = await fetchFolderMessages(folder.id, windowStart);

        for (const msg of msgs) {
          const internetMsgId = msg.internetMessageId || msg.id;

          // Dedupe — internetMessageId is stable across folder moves
          if (localSeen.has(internetMsgId)) continue;
          if (agentDb.isSeen(internetMsgId)) continue;
          localSeen.add(internetMsgId);

          const sender = msg.from?.emailAddress?.address || '';
          const subject = msg.subject || '';
          const received = msg.receivedDateTime || '';
          const domain = sender.toLowerCase().split('@').pop() || '';

          if (isJunk) {
            // Skip dismissed junk
            if (agentDb.isJunkDismissed(msg.id)) continue;

            const cr = classify(sender, subject, config);
            if (cr.bucket && !cr.guarded) {
              // Auto-rescue: unguarded rule match → move to inbox.  The move
              // changes the Graph id — capture the new one so body fetch and
              // later ops (inspect) reference a live message.
              let liveId = msg.id;
              if (!dry) {
                const movedMsg = await graphPost(`/me/messages/${msg.id}/move`, { destinationId: 'inbox' });
                if (movedMsg?.id) liveId = movedMsg.id;
              } else {
                dryRescueLog.push(`  [would-rescue] ${sender} — ${subject} (rule: ${cr.ruleId})`);
              }
              emails.push({
                id: liveId, sender, domain, subject, received,
                folder: folder.displayName, junked: true, rescued: true,
                classify: { bucket: cr.bucket, ruleId: cr.ruleId, guarded: false }
              });
              junkCompat.push({
                id: liveId, sender, subject, received,
                flag: 'rescued-rule', rule_id: cr.ruleId,
                age_days: ageDays(received, now)
              });
            } else {
              emails.push({
                id: msg.id, sender, domain, subject, received,
                folder: folder.displayName, junked: true,
                classify: cr.bucket
                  ? { bucket: cr.bucket, ruleId: cr.ruleId, guarded: cr.guarded }
                  : null
              });
              junkCompat.push({
                id: msg.id, sender, subject, received,
                flag: 'pending', age_days: ageDays(received, now)
              });
            }
          } else {
            // Non-junk folder — dry classify for attribution
            const cr = classify(sender, subject, config);
            emails.push({
              id: msg.id, sender, domain, subject, received,
              folder: folder.displayName, junked: false,
              classify: cr.bucket
                ? { bucket: cr.bucket, ruleId: cr.ruleId, guarded: cr.guarded }
                : null
            });
          }

          seenToInsert.push({ id: internetMsgId, ts: now });
        }
      } catch (err) {
        // A folder that failed to scan holds unread mail — record it so the
        // watermark does not advance past this window (completeness clause);
        // other folders still process.
        scanFailures.push(folder.displayName);
        console.error(`Folder scan error (${folder.displayName}): ${err.message}`);
      }
    }

    if (dry) {
      for (const line of dryRescueLog) console.log(line);
    }

    // ==================================================================
    // Body fetch — priority: junk pending → unruled → ruled, newest first
    // ==================================================================
    const readBodyCap = agentConfig.readBodyCap || 40;

    const junkPending = emails.filter(e => e.junked && !e.rescued);
    const unruled = emails.filter(e => !e.junked && !e.classify);
    // Rescued junk rejoins the ruled tier — its id was refreshed post-move
    const ruled = emails.filter(e => e.classify && (!e.junked || e.rescued));
    const cmpNewest = (a, b) => (b.received || '').localeCompare(a.received || '');
    const byPriority = [
      ...junkPending.sort(cmpNewest),
      ...unruled.sort(cmpNewest),
      ...ruled.sort(cmpNewest),
    ];
    const bodiesToFetch = byPriority.slice(0, readBodyCap);
    const bodyOverflow = Math.max(0, byPriority.length - readBodyCap);

    for (const email of bodiesToFetch) {
      try {
        const msgData = await graphGet(
          buildGraphUrl(`/me/messages/${email.id}`, { select: 'body,subject' })
        );
        let bodyText = htmlToText(msgData?.body?.content, msgData?.body?.contentType);
        if (bodyText.length > 1200) bodyText = bodyText.slice(0, 1200);
        email.body_excerpt = bodyText;
      } catch { /* non-fatal — email keeps subject only */ }
    }

    // ==================================================================
    // Sort activity (sort_log over same window — supplementary)
    // ==================================================================
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

    const keptRuleCount = sortRows.filter(r => r.action === 'kept-rule').length;
    const pinnedCount = sortRows.filter(r => r.action === 'pinned').length;
    logDb.close();

    // ==================================================================
    // Reminders — driven by sort activity (reminder-class rules)
    // ==================================================================
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

    // ==================================================================
    // Questions
    // ==================================================================
    if (!dry) agentDb.expireQuestions(now);
    const openQuestions = agentDb.openQuestions().map(q => ({
      id: q.id, domain: q.domain, question: q.question, asked_at: q.asked_at
    }));

    // ==================================================================
    // Report JSON — new contract (§2)
    // ==================================================================
    const reportJson = {
      window: { start: windowStart, end: windowEnd },
      emails,
      ...(bodyOverflow > 0 ? { bodyOverflow } : {}),
      ...(scanFailures.length > 0 ? { scanIncomplete: scanFailures } : {}),
      sortActivity: {
        moved, guardBlocked, noparse, unsorted, runErrors,
        summary: { keptRuleCount, pinnedCount }
      },
      reminders: remindersForJson,
      questions: openQuestions,
      // Backward-compat junk array — handler.js and render-sweep read this
      junk: junkCompat,
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

    // ==================================================================
    // LLM render
    // ==================================================================
    if (dry) {
      // Synchronous path for CLI --dry use (blocking is fine in a shell)
      let message;
      let status = 'ok';
      try {
        const llmResult = await renderReport({ model: agentConfig.renderModel ?? agentConfig.model, reportJson, notesContent });
        message = llmResult.message_text;

        // Apply LLM junk flags (display only — no DB writes in dry mode)
        const VALID_JUNK_FLAGS = new Set(['pending-normal', 'pending-danger']);
        for (const f of llmResult.junk_flags || []) {
          const item = junkCompat.find(j => j.id === f.id);
          if (item && item.flag === 'pending' && VALID_JUNK_FLAGS.has(f.flag)) {
            item.flag = f.flag;
            if (f.reason) item.reason = f.reason;
          }
        }

        if (notesWarning) message += `\n\n${notesWarning}`;
      } catch (err) {
        status = 'degraded';
        message = buildDegradedMessage(reportJson);
        if (notesWarning) message += ` / ${notesWarning}`;
      }

      console.log(message);
      return { status, message, reportJson };
    }

    // --- Async enqueue path (non-dry) — hand off to sweep ---
    const { system, user } = buildRenderPrompt({ reportJson, notesContent });
    const requestId = enqueueCliLLM({
      kind: 'render', system, user,
      model: agentConfig.renderModel ?? agentConfig.model,
      _queueDir,
    });

    // Atomic: advance watermark + insert pending + record seen entries.
    // If this throws the watermark stays put — next assemble re-fetches.
    // A partial scan (scanFailures) must not consume the window either —
    // unread mail in a failed folder would be skipped forever; seen entries
    // still land, so the re-read only surfaces what this report missed.
    agentDb.insertPendingWithWatermark({
      pending: {
        created_at: now,
        origin,
        window_start: windowStart,
        window_end: windowEnd,
        request_id: requestId,
        report_json: JSON.stringify(reportJson),
        status: 'open',
      },
      watermark: scanFailures.length > 0 ? null : windowEnd,
      seen: seenToInsert,
    });

    return { status: 'pending', requestId };
  } finally {
    agentDb.close();
  }
}

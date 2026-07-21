// Render sweep — processes pending_renders rows each loop iteration.
// Picks up LLM results, validates, applies completion logic, handles
// retries and deadlines.  The assemble side (report.js) enqueues;
// this module completes.

import fs from 'node:fs';
import path from 'node:path';
import { parseAndValidate, enqueueCliLLM, RETRY_PREAMBLE } from './cli-transport.js';
import { buildRenderPrompt } from './llm.js';
import { buildDegradedMessage, writeOutbox } from './report.js';

const MAX_ENQUEUE = 3;

function loadNotes(p) {
  try { return fs.readFileSync(p, 'utf8'); }
  catch { return ''; }
}

function cleanupQueueFiles(requestId, queueDir) {
  for (const sub of ['requests', 'results']) {
    const fp = path.join(queueDir, sub, `${requestId}.json`);
    try { fs.unlinkSync(fp); } catch { /* may already be gone */ }
  }
}

// Keep a copy of every delivered report. The outbox deletes messages on
// send, so without this archive there is no record of what the owner actually
// received — which blocks iterating on report quality. Best-effort: an
// archive failure must never block delivery.
function archiveSent(outboxDir, text, now, meta) {
  try {
    const dir = path.join(path.dirname(outboxDir), 'sent-reports');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const safeTs = now.replace(/[:.]/g, '-');
    fs.writeFileSync(
      path.join(dir, `${safeTs}.json`),
      JSON.stringify({ ts: now, ...meta, text }, null, 2)
    );
  } catch { /* best effort */ }
}

// Re-enqueue a render request from stored report_json + current notes.
// Returns the new request ID.
function reEnqueue(row, { notesPath, queueDir, model, retry, ownerName, replyLanguage }) {
  const reportJson = JSON.parse(row.report_json);
  const notesContent = loadNotes(notesPath);
  let { system, user } = buildRenderPrompt({ reportJson, notesContent, ownerName, replyLanguage });
  if (retry) {
    system = `${RETRY_PREAMBLE}\n\n${system}`;
  }
  return enqueueCliLLM({
    kind: 'render', system, user, model, _queueDir: queueDir,
  });
}

// --- Completion paths ---

async function doCompletion(row, llmResult, deps) {
  const { agentDb, outboxDir, notesPath, lastReportPath, drainOutbox, getNow } = deps;
  const now = getNow();
  const reportJson = JSON.parse(row.report_json);

  // Apply LLM output — questions + reminders
  for (const q of llmResult.new_questions || []) {
    agentDb.addQuestion({ domain: q.domain || null, question: q.question, now });
  }
  for (const r of llmResult.auto_resolved_reminders || []) {
    agentDb.resolveReminder(r.id, 'auto', now);
  }

  // Merge junk flags — advisory only, no moves
  const VALID_JUNK_FLAGS = new Set(['pending-normal', 'pending-danger']);
  const junkItems = reportJson.junk || [];
  for (const f of llmResult.junk_flags || []) {
    const item = junkItems.find(j => j.id === f.id);
    if (item && item.flag === 'pending' && VALID_JUNK_FLAGS.has(f.flag)) {
      item.flag = f.flag;
      if (f.reason) item.reason = f.reason;
    } else if (!item) {
      console.warn(`junk_flags: unmatched id "${f.id}" (not in junk[])`);
    }
  }

  // Build message
  let message = llmResult.message_text;

  // Notes warning (checked at completion time, not assemble time)
  const notesContent = loadNotes(notesPath);
  const lineCount = notesContent.split('\n').length;
  if (lineCount > 60) {
    message += `\n\nagent-notes.md 有 ${lineCount} 行，清理時間`;
  }

  // Deliver
  writeOutbox(outboxDir, message, now);
  archiveSent(outboxDir, message, now, { origin: row.origin, status: 'ok' });
  await drainOutbox();

  // Ledger
  agentDb.logRun({
    run_at: now, kind: 'report',
    window_start: row.window_start, window_end: row.window_end,
    status: 'ok', detail: null,
  });

  // Rewrite agent-last-report.json with merged flags
  if (lastReportPath) {
    fs.writeFileSync(lastReportPath, JSON.stringify(reportJson, null, 2));
  }

  agentDb.completePending(row.id, 'done', now);
}

async function doDegradedCompletion(row, reason, deps) {
  const { agentDb, outboxDir, drainOutbox, getNow } = deps;
  const now = getNow();

  // Degraded completion is the only exit an open row has — it must succeed
  // even when report_json is corrupt, or the row can never be retired.
  let reportJson = null;
  try { reportJson = JSON.parse(row.report_json); } catch { /* fall through */ }

  const message = reportJson
    ? buildDegradedMessage(reportJson)
    : `[degraded] ${reason}`;
  writeOutbox(outboxDir, message, now);
  archiveSent(outboxDir, message, now, { origin: row.origin, status: 'degraded', reason });
  await drainOutbox();

  agentDb.logRun({
    run_at: now, kind: 'report',
    window_start: row.window_start, window_end: row.window_end,
    status: 'degraded', detail: reason,
  });

  agentDb.completePending(row.id, 'degraded', now);
}

// --- Main sweep ---

export async function runSweep({
  agentDb,
  outboxDir,
  queueDir,
  notesPath,
  lastReportPath,
  drainOutbox,
  config,   // { model, renderDeadlineHours }
  getNow,
}) {
  const now = getNow();
  const renderModel = config.renderModel ?? config.model;
  const openPendings = agentDb.openPendings();

  for (const row of openPendings) {
    try {
      const resDir = path.join(queueDir, 'results');
      const reqDir = path.join(queueDir, 'requests');
      const resultPath = path.join(resDir, `${row.request_id}.json`);
      const requestPath = path.join(reqDir, `${row.request_id}.json`);

      const completionDeps = { agentDb, outboxDir, notesPath, lastReportPath, drainOutbox, getNow };

      // Deadline dominates everything — no open row may outlive it.  This is
      // also the exit for rows whose completion path keeps throwing (corrupt
      // report_json, persistent fs errors): degraded completion is hardened
      // to close the row regardless.
      const ageMs = new Date(now).getTime() - new Date(row.created_at).getTime();
      const deadlineMs = (config.renderDeadlineHours || 8) * 3_600_000;
      if (ageMs > deadlineMs) {
        await doDegradedCompletion(row, `Render deadline exceeded (${config.renderDeadlineHours || 8}h)`, completionDeps);
        cleanupQueueFiles(row.request_id, queueDir);
        continue;
      }

      // --- Try to read result ---
      let result = null;
      try {
        if (fs.existsSync(resultPath)) {
          result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        }
      } catch {
        // File may be mid-write — skip this sweep cycle, pick up next time
        continue;
      }

      if (result) {
        if (result.ok) {
          const pv = parseAndValidate('render', result.text);
          if (pv.ok) {
            await doCompletion(row, pv.parsed, completionDeps);
            cleanupQueueFiles(row.request_id, queueDir);
          } else {
            // Invalid JSON — re-enqueue with RETRY_PREAMBLE (cap 3)
            if (row.enqueue_count >= MAX_ENQUEUE) {
              await doDegradedCompletion(row, 'JSON validation failed after 3 attempts', completionDeps);
              cleanupQueueFiles(row.request_id, queueDir);
            } else {
              const newId = reEnqueue(row, { notesPath, queueDir, model: renderModel, retry: true, ownerName: config.ownerName, replyLanguage: config.replyLanguage });
              agentDb.updatePendingRequest(row.id, newId, row.enqueue_count + 1);
              // Clean old result
              try { fs.unlinkSync(resultPath); } catch { /* ok */ }
            }
          }
        } else {
          // ok:false
          if (result.error === 'auth_expired') {
            await doDegradedCompletion(row, 'MBA claude login 過期咗', completionDeps);
            cleanupQueueFiles(row.request_id, queueDir);
          } else {
            // Other error — re-enqueue (cap 3)
            if (row.enqueue_count >= MAX_ENQUEUE) {
              await doDegradedCompletion(row, `LLM error after 3 attempts: ${result.error}`, completionDeps);
              cleanupQueueFiles(row.request_id, queueDir);
            } else {
              const newId = reEnqueue(row, { notesPath, queueDir, model: renderModel, retry: false, ownerName: config.ownerName, replyLanguage: config.replyLanguage });
              agentDb.updatePendingRequest(row.id, newId, row.enqueue_count + 1);
              cleanupQueueFiles(row.request_id, queueDir);
            }
          }
        }
      } else {
        // --- No result yet ---
        if (!fs.existsSync(requestPath)) {
          // Request file vanished — worker died or cleanQueue removed it
          if (row.enqueue_count >= MAX_ENQUEUE) {
            await doDegradedCompletion(row, 'Request lost after 3 attempts', completionDeps);
          } else {
            const newId = reEnqueue(row, { notesPath, queueDir, model: renderModel, retry: false, ownerName: config.ownerName, replyLanguage: config.replyLanguage });
            agentDb.updatePendingRequest(row.id, newId, row.enqueue_count + 1);
          }
        } else if (ageMs > 2 * 60_000 && !row.interim_notified && row.origin === 'check') {
          // 2min interim for user-triggered checks — let the owner know the worker may be offline
          writeOutbox(outboxDir, 'LLM 未接工（MBA 可能瞓咗），醒返即補', now);
          await drainOutbox();
          agentDb.setInterimNotified(row.id);
        }
      }
    } catch (err) {
      // One bad row must not abort the sweep or crash the daemon — later rows
      // still process this cycle, and the deadline check above retires the row.
      console.error(`Sweep row ${row.id} error: ${err.message}`);
    }
  }
}

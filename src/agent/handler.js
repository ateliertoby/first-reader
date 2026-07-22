// Handler — creates the onMessage function for runLoop
// Loads context, parses intent, executes ops, composes reply

import fs from 'node:fs';
import { parseIntent, runDeepVerify } from './intent.js';
import { executeOps } from './ops.js';
import { runInspection } from './inspect.js';

function loadContext({ lastReportPath, agentDb, notesPath }) {
  let lastReport = null;
  try { lastReport = JSON.parse(fs.readFileSync(lastReportPath, 'utf8')); } catch {}

  const openReminders = agentDb.openReminders();
  const openQuestions = agentDb.openQuestions();

  // Pending junk from last report — id + sender + subject only
  let pendingJunk = [];
  if (lastReport?.junk) {
    pendingJunk = lastReport.junk
      .filter(j => j.flag !== 'rescued-rule')
      .map(j => ({ id: j.id, sender: j.sender, subject: j.subject }));
  }

  let notesContent = '';
  try { notesContent = fs.readFileSync(notesPath, 'utf8'); } catch {}

  return { lastReport, openReminders, openQuestions, pendingJunk, notesContent };
}

export function createHandler(deps) {
  const {
    agentDb, model,
    ownerName, workerName, replyLanguage,
    rulesPath, notesPath, sortDbPath, lastReportPath,
    graphGet, graphPost,
    runReport, runAudit, drainOutbox, send,
    outboxDir,
    getNow, deepVerify,
  } = deps;

  return async function onMessage(text) {
    try {
      // 1. Load context
      const context = loadContext({ lastReportPath, agentDb, notesPath });

      // 2. Parse intent
      const intent = await parseIntent({ model, userText: text, context, ownerName, replyLanguage, workerName });

      // 3. Clarification or no-ops — return reply_text only
      if (intent.needs_clarification || intent.ops.length === 0) {
        return intent.reply_text || '收到';
      }

      // 4. Execute ops
      const results = await executeOps(intent.ops, {
        rulesPath, notesPath, sortDbPath,
        agentDb, graphGet, graphPost,
        runReport, runAudit, drainOutbox, send,
        outboxDir,
        deepVerify: deepVerify ?? (async (claim, emailCtx) => {
          return runDeepVerify({ model, claim, context: emailCtx, workerName });
        }),
        runInspection: deps.runInspection ?? runInspection,
        model,
        getNow: getNow ?? (() => new Date().toISOString()),
        userText: text,
      });

      // 5. Compose reply — op results then LLM's contextual reply
      const parts = [...results];
      if (intent.reply_text) parts.push(intent.reply_text);
      return parts.join('\n');
    } catch (err) {
      return `處理失敗：${err.message}`;
    }
  };
}

// Agent daemon loop — B3/B4 (intent handling wired, B6 wires launchd)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TelegramChannel } from './telegram.js';
import { AgentDB } from './db.js';
import { loadAgentConfig } from './config.js';
import { runAgentReport } from './report.js';
import { createHandler } from './handler.js';
import { graphGet, graphPost } from '../graph.js';
import { makeGitRunner } from './ops.js';
import { runFolderAudit } from './audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  agentDbPath: path.join(__dirname, '..', '..', 'data', 'agent.db'),
  outboxDir: path.join(__dirname, '..', '..', 'data', 'agent-outbox'),
  stateFile: path.join(__dirname, '..', '..', 'data', 'telegram-state.json'),
};

const PROJECT_ROOT = path.join(__dirname, '..', '..');

// Pure — compute ms until next HH:MM in timezone from now
export function msUntilNext(reportTime, timezone, now) {
  const d = now instanceof Date ? now : new Date(now);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const { type, value } of fmt.formatToParts(d)) parts[type] = value;

  const [targetH, targetM] = reportTime.split(':').map(Number);
  const nowMins = Number(parts.hour) * 60 + Number(parts.minute);
  const targetMins = targetH * 60 + targetM;

  let diffMins = targetMins - nowMins;
  if (diffMins <= 0) diffMins += 1440;

  return (diffMins * 60 - Number(parts.second)) * 1000;
}

// Pure — compute ms until next 1st-of-month at HH:MM in timezone from now
export function msUntilNextMonthly(reportTime, timezone, now) {
  const d = now instanceof Date ? now : new Date(now);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const { type, value } of fmt.formatToParts(d)) parts[type] = value;

  const [targetH, targetM] = reportTime.split(':').map(Number);
  const dayOfMonth = Number(parts.day);
  const nowMins = Number(parts.hour) * 60 + Number(parts.minute);
  const targetMins = targetH * 60 + targetM;

  // On the 1st and before the slot: fire today
  if (dayOfMonth === 1 && nowMins < targetMins) {
    return ((targetMins - nowMins) * 60 - Number(parts.second)) * 1000;
  }

  // Otherwise: next month's 1st at the slot
  const year = Number(parts.year);
  const month = Number(parts.month); // 1-indexed
  // Build a Date for the 1st of next month at the target time in the timezone
  // by computing offset from now to that target wall-clock moment
  let nextYear = year;
  let nextMonth = month + 1;
  if (nextMonth > 12) { nextMonth = 1; nextYear++; }

  // Use Intl to find the UTC instant for "next month 1st at targetH:targetM" in tz
  // Approach: step forward by days until we reach the 1st of next month in tz,
  // then compute the exact offset. More robust: just compute the difference.
  const nowSec = Number(parts.second);
  const nowTotalMins = (dayOfMonth - 1) * 1440 + nowMins;

  // Days in current month (in local tz)
  // Create a date for the last day of current month
  const daysInMonth = new Date(year, month, 0).getDate();
  const daysUntilFirst = daysInMonth - dayOfMonth + 1;

  // ms = days remaining until 1st + slot time offset
  const minsUntilMidnight1st = daysUntilFirst * 1440 - nowMins;
  const totalMs = ((minsUntilMidnight1st + targetMins) * 60 - nowSec) * 1000;

  return totalMs;
}

function loadOffset(stateFile) {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return { value: data.offset ?? 0 };
  } catch {
    return { value: 0 };
  }
}

function saveOffset(stateFile, offsetRef) {
  const dir = path.dirname(stateFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ offset: offsetRef.value }));
}

export async function runLoop({
  token, chatId,
  onMessage,
  // Internal injection (underscore = testing)
  _channel, _agentDb,
  _agentDbPath, _outboxDir, _stateFile,
  _reportTime, _timezone, _agentConfigPath,
  _maxPolls, _runReport, _runAudit, _getNow,
} = {}) {
  const agentDbPath = _agentDbPath ?? DEFAULTS.agentDbPath;
  const outboxDir = _outboxDir ?? DEFAULTS.outboxDir;
  const stateFile = _stateFile ?? DEFAULTS.stateFile;

  // Load config (shared for report schedule + handler)
  let agentConfig;
  try { agentConfig = loadAgentConfig(_agentConfigPath); }
  catch { agentConfig = { model: 'claude-sonnet-5', reportTime: '08:30', timezone: 'Asia/Hong_Kong' }; }

  let reportTime = _reportTime ?? agentConfig.reportTime;
  const tz = _timezone ?? agentConfig.timezone;

  const getNow = _getNow ?? (() => new Date().toISOString());
  const channel = _channel ?? new TelegramChannel({ token, chatId });
  const db = _agentDb ?? new AgentDB(agentDbPath);
  const reportFn = _runReport ?? runAgentReport;
  const auditFn = _runAudit ?? runFolderAudit;

  // Default handler = real intent handler; tests override via onMessage param
  const handler = onMessage ?? createHandler({
    agentDb: db,
    model: agentConfig.model,
    rulesPath: path.join(PROJECT_ROOT, 'config', 'rules.json'),
    notesPath: path.join(PROJECT_ROOT, 'config', 'agent-notes.md'),
    sortDbPath: path.join(PROJECT_ROOT, 'data', 'transactions.db'),
    lastReportPath: path.join(PROJECT_ROOT, 'data', 'agent-last-report.json'),
    git: makeGitRunner(PROJECT_ROOT),
    graphGet, graphPost,
    runReport: reportFn,
    runAudit: auditFn,
    drainOutbox: () => channel.drainOutbox(outboxDir),
    getNow,
  });

  const offsetRef = loadOffset(stateFile);

  // Startup drain
  await channel.drainOutbox(outboxDir);

  // "auto" (learned slot) is v1.5 — until then it must not silently disable
  // the daily report; fall back to the fixed default.
  if (reportTime === 'auto') reportTime = '08:30';

  // Schedule report timer (skip in test mode to avoid timer leaks)
  let reportTimer = null;
  function scheduleReport() {
    if (_maxPolls != null) return;
    const ms = msUntilNext(reportTime, tz, new Date());
    reportTimer = setTimeout(async () => {
      try {
        await reportFn({ dry: false });
        await channel.drainOutbox(outboxDir);
      } catch (err) {
        console.error(`Scheduled report error: ${err.message}`);
      }
      scheduleReport();
    }, ms);
    reportTimer.unref();
  }

  // Schedule monthly audit timer (skip in test mode to avoid timer leaks)
  let auditTimer = null;
  function scheduleAudit() {
    if (_maxPolls != null) return;
    const ms = msUntilNextMonthly(reportTime, tz, new Date());
    auditTimer = setTimeout(async () => {
      try {
        await auditFn({ dry: false });
        await channel.drainOutbox(outboxDir);
      } catch (err) {
        console.error(`Scheduled audit error: ${err.message}`);
      }
      scheduleAudit();
    }, ms);
    auditTimer.unref();
  }

  let running = true;
  const shutdown = () => { running = false; };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  scheduleReport();
  scheduleAudit();

  let polls = 0;
  try {
    while (running) {
      if (_maxPolls != null && polls >= _maxPolls) break;
      polls++;

      let messages = [];
      try {
        messages = await channel.poll(offsetRef);
      } catch (err) {
        console.error(`Poll error: ${err.message}`);
      }
      saveOffset(stateFile, offsetRef);

      for (const msg of messages) {
        const now = getNow();
        const kind = msg.text?.startsWith('/') ? 'command' : 'reply';
        db.logEngagement(now, kind);

        // Opportunistic delivery — Toby is online, best time to send pending items
        await channel.drainOutbox(outboxDir);

        const replyText = await handler(msg.text, { chatId: msg.chat?.id });
        if (replyText) await channel.send(replyText);
      }
    }
  } finally {
    if (reportTimer) clearTimeout(reportTimer);
    if (auditTimer) clearTimeout(auditTimer);
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
    if (!_agentDb) db.close();
  }
}

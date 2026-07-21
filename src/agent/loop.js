// Agent daemon loop — polls Telegram, runs sweep + idle trigger each iteration

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TelegramChannel } from './telegram.js';
import { AgentDB } from './db.js';
import { loadAgentConfig } from './config.js';
import { runAgentReport, writeOutbox } from './report.js';
import { createHandler } from './handler.js';
import { graphGet, graphPost } from '../graph.js';
import { runFolderAudit } from './audit.js';
import { cleanQueue } from './cli-transport.js';
import { runSweep } from './render-sweep.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  agentDbPath: path.join(__dirname, '..', '..', 'data', 'agent.db'),
  outboxDir: path.join(__dirname, '..', '..', 'data', 'agent-outbox'),
  stateFile: path.join(__dirname, '..', '..', 'data', 'telegram-state.json'),
  queueDir: path.join(__dirname, '..', '..', 'data', 'llm-queue'),
  notesPath: path.join(__dirname, '..', '..', 'config', 'agent-notes.md'),
  lastReportPath: path.join(__dirname, '..', '..', 'data', 'agent-last-report.json'),
};

const PROJECT_ROOT = path.join(__dirname, '..', '..');

// Monthly audit anchor — constant, no longer tied to a configurable reportTime
const AUDIT_TIME = '09:00';

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

  const nowSec = Number(parts.second);

  // Days in current month (in local tz)
  const daysInMonth = new Date(year, month, 0).getDate();
  const daysUntilFirst = daysInMonth - dayOfMonth + 1;

  const minsUntilMidnight1st = daysUntilFirst * 1440 - nowMins;
  const totalMs = ((minsUntilMidnight1st + targetMins) * 60 - nowSec) * 1000;

  return totalMs;
}

// Idle trigger — fire a report when the owner hasn't checked in a while
export function shouldTriggerIdle(agentDb, now, idleHours) {
  // Never fire while a render is already in flight
  const openPendings = agentDb.openPendings();
  if (openPendings.length > 0) return false;

  const lastRun = agentDb.lastRun('report');
  if (!lastRun) return true; // Bootstrap: first deploy, fire immediately

  const hoursSince = (new Date(now).getTime() - new Date(lastRun.run_at).getTime()) / 3_600_000;
  return hoursSince >= idleHours;
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
  _queueDir, _notesPath, _lastReportPath,
  _timezone, _agentConfigPath,
  _maxPolls, _runReport, _runAudit, _getNow,
} = {}) {
  const agentDbPath = _agentDbPath ?? DEFAULTS.agentDbPath;
  const outboxDir = _outboxDir ?? DEFAULTS.outboxDir;
  const stateFile = _stateFile ?? DEFAULTS.stateFile;
  const queueDir = _queueDir ?? DEFAULTS.queueDir;
  const notesPath = _notesPath ?? DEFAULTS.notesPath;
  const lastReportPath = _lastReportPath ?? DEFAULTS.lastReportPath;

  // Load config
  let agentConfig;
  try { agentConfig = loadAgentConfig(_agentConfigPath); }
  catch { agentConfig = { model: 'claude-sonnet-4-6', timezone: 'Asia/Hong_Kong', idleHours: 24, renderDeadlineHours: 8, freshLookbackHours: 12, ownerName: 'the user', replyLanguage: 'English' }; }

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
    ownerName: agentConfig.ownerName,
    replyLanguage: agentConfig.replyLanguage,
    rulesPath: path.join(PROJECT_ROOT, 'config', 'rules.json'),
    notesPath,
    sortDbPath: path.join(PROJECT_ROOT, 'data', 'transactions.db'),
    lastReportPath,
    graphGet, graphPost,
    runReport: reportFn,
    runAudit: auditFn,
    drainOutbox: () => channel.drainOutbox(outboxDir),
    send: (text) => channel.send(text),
    outboxDir,
    getNow,
  });

  const offsetRef = loadOffset(stateFile);

  // Production mode: sweep + idle trigger enabled, timers running.
  // Test mode (_maxPolls set): skip sweep/idle/timers to keep tests fast and isolated.
  const productionMode = _maxPolls == null;

  // Startup queue cleanup — stale requests/results from prior crashes.
  // Protect in-flight pending render request files.
  const protectedIds = productionMode
    ? db.openPendings().map(p => p.request_id)
    : [];
  cleanQueue(getNow(), queueDir, protectedIds);

  // Register bot menu commands (non-fatal)
  if (productionMode && channel.registerCommands) {
    await channel.registerCommands();
  }

  // Sweep deps (reused every iteration)
  const sweepDeps = {
    agentDb: db,
    outboxDir,
    queueDir,
    notesPath,
    lastReportPath,
    drainOutbox: () => channel.drainOutbox(outboxDir),
    config: agentConfig,
    getNow,
  };

  // Startup sweep — pick up orphan renders from prior process.  A sweep
  // failure must not prevent the daemon from starting (KeepAlive would
  // otherwise crash-loop on a persistent error).
  if (productionMode) {
    try {
      await runSweep(sweepDeps);
    } catch (err) {
      console.error(`Startup sweep error: ${err.message}`);
    }
  }

  // Startup drain
  await channel.drainOutbox(outboxDir);

  // Schedule monthly audit timer (skip in test mode to avoid timer leaks)
  let auditTimer = null;
  function scheduleAudit() {
    if (!productionMode) return;
    const ms = msUntilNextMonthly(AUDIT_TIME, tz, new Date());
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
  scheduleAudit();

  const IDLE_ATTEMPT_THROTTLE_MS = 30 * 60_000;
  let lastIdleAttemptMs = 0;

  let polls = 0;
  try {
    while (running) {
      if (_maxPolls != null && polls >= _maxPolls) break;
      polls++;

      // Sweep pending renders + idle trigger (production only)
      if (productionMode) {
        try {
          await runSweep(sweepDeps);
        } catch (err) {
          console.error(`Sweep error: ${err.message}`);
        }

        // Throttle idle attempts: success stops re-fires via agent_runs /
        // pending rows, so this only paces the failure path — without it a
        // failing assemble would push an error message every poll iteration.
        const nowMs = new Date(getNow()).getTime();
        if (nowMs - lastIdleAttemptMs >= IDLE_ATTEMPT_THROTTLE_MS
            && shouldTriggerIdle(db, getNow(), agentConfig.idleHours)) {
          lastIdleAttemptMs = nowMs;
          try {
            await reportFn({ dry: false, origin: 'idle' });
            await channel.drainOutbox(outboxDir);
          } catch (err) {
            // Idle trigger must also produce feedback — zero silent path
            try {
              writeOutbox(outboxDir, `idle report 出唔到：${err.message}`, getNow());
              await channel.drainOutbox(outboxDir);
            } catch { /* best effort */ }
          }
        }
      }

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

        // Opportunistic delivery — the owner is online, best time to send pending items
        await channel.drainOutbox(outboxDir);

        const replyText = await handler(msg.text, { chatId: msg.chat?.id });
        if (replyText) await channel.send(replyText);
      }
    }
  } finally {
    if (auditTimer) clearTimeout(auditTimer);
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
    if (!_agentDb) db.close();
  }
}

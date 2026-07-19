import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runSweep } from '../src/agent/render-sweep.js';
import { shouldTriggerIdle } from '../src/agent/loop.js';
import { AgentDB } from '../src/agent/db.js';

// --- Helpers ---

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-cli-sweep-'));
}

function writeResult(queueDir, id, result) {
  const dir = path.join(queueDir, 'results');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(result));
}

function writeRequest(queueDir, id) {
  const dir = path.join(queueDir, 'requests');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, kind: 'render' }));
}

function writeNotes(dir, content) {
  const p = path.join(dir, 'agent-notes.md');
  fs.writeFileSync(p, content);
  return p;
}

const MINIMAL_REPORT = {
  window: { start: '2026-07-17T08:00:00Z', end: '2026-07-18T08:00:00Z' },
  sort: { moved: [], guardBlocked: [], noparse: [], unsorted: [], runErrors: [], kept: [], summary: { keptRuleCount: 0, pinnedCount: 0 } },
  reminders: [],
  questions: [],
  junk: [],
  fresh: [],
};

function makeSweepDeps(tmpDir, overrides = {}) {
  const agentDb = overrides.agentDb ?? new AgentDB(path.join(tmpDir, 'agent.db'));
  const outboxDir = overrides.outboxDir ?? path.join(tmpDir, 'outbox');
  const drainCalls = [];
  return {
    deps: {
      agentDb,
      outboxDir,
      queueDir: overrides.queueDir ?? path.join(tmpDir, 'llm-queue'),
      notesPath: overrides.notesPath ?? path.join(tmpDir, 'agent-notes.md'),
      lastReportPath: overrides.lastReportPath ?? path.join(tmpDir, 'agent-last-report.json'),
      drainOutbox: overrides.drainOutbox ?? (async () => { drainCalls.push(1); }),
      config: overrides.config ?? { model: 'claude-sonnet-5', renderDeadlineHours: 8 },
      getNow: overrides.getNow ?? (() => '2026-07-18T10:00:00Z'),
    },
    drainCalls,
    agentDb,
    cleanup: () => { if (!overrides.agentDb) agentDb.close(); },
  };
}

function insertPending(agentDb, requestId, overrides = {}) {
  agentDb.insertPending({
    created_at: overrides.created_at ?? '2026-07-18T09:50:00Z',
    origin: overrides.origin ?? 'check',
    window_start: '2026-07-17T08:00:00Z',
    window_end: '2026-07-18T08:00:00Z',
    request_id: requestId,
    report_json: JSON.stringify(overrides.reportJson ?? MINIMAL_REPORT),
    status: 'open',
  });
}

// --- Idle trigger (tested via loop's shouldTriggerIdle logic, extracted here) ---

describe('idle trigger logic', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true }); });

  test('fires when idleHours exceeded', () => {
    const db = new AgentDB(path.join(tmpDir, 'agent.db'));
    db.logRun({
      run_at: '2026-07-17T08:00:00Z', kind: 'report',
      window_start: null, window_end: null, status: 'ok', detail: null
    });
    // 25 hours later with 24h idle
    const result = shouldTriggerIdle(db, '2026-07-18T09:00:00Z', 24);
    assert.strictEqual(result, true);
    db.close();
  });

  test('does not fire when under idleHours', () => {
    const db = new AgentDB(path.join(tmpDir, 'agent.db'));
    db.logRun({
      run_at: '2026-07-18T08:00:00Z', kind: 'report',
      window_start: null, window_end: null, status: 'ok', detail: null
    });
    // 1 hour later with 24h idle
    const result = shouldTriggerIdle(db, '2026-07-18T09:00:00Z', 24);
    assert.strictEqual(result, false);
    db.close();
  });

  test('does not fire when open pending exists', () => {
    const db = new AgentDB(path.join(tmpDir, 'agent.db'));
    db.logRun({
      run_at: '2026-07-17T08:00:00Z', kind: 'report',
      window_start: null, window_end: null, status: 'ok', detail: null
    });
    db.insertPending({
      created_at: '2026-07-18T08:00:00Z', origin: 'check',
      window_start: '2026-07-17T00:00:00Z', window_end: '2026-07-18T00:00:00Z',
      request_id: 'req-1', report_json: '{}', status: 'open',
    });
    // Over 24h but open pending blocks
    const result = shouldTriggerIdle(db, '2026-07-18T09:00:00Z', 24);
    assert.strictEqual(result, false);
    db.close();
  });

  test('bootstrap fire: no run history triggers immediately', () => {
    const db = new AgentDB(path.join(tmpDir, 'agent.db'));
    const result = shouldTriggerIdle(db, '2026-07-18T09:00:00Z', 24);
    assert.strictEqual(result, true);
    db.close();
  });
});

describe('render sweep', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    writeNotes(tmpDir, '# Notes\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  // --- Valid result completion ---

  test('valid result: completes pending, writes outbox, logs run', async () => {
    const { deps, drainCalls, agentDb, cleanup } = makeSweepDeps(tmpDir);
    insertPending(agentDb, 'req-1');
    writeRequest(deps.queueDir, 'req-1');
    writeResult(deps.queueDir, 'req-1', {
      id: 'req-1', ts: '2026-07-18T10:00:00Z', ok: true,
      text: JSON.stringify({
        message_text: 'Report done',
        new_questions: [{ domain: 'test', question: 'Q?' }],
        auto_resolved_reminders: [],
        junk_flags: [],
      }),
    });

    await runSweep(deps);

    // Pending should be marked done
    const pending = agentDb.getPending(1);
    assert.strictEqual(pending.status, 'done');

    // Run logged
    const lastRun = agentDb.lastRun('report');
    assert.ok(lastRun);
    assert.strictEqual(lastRun.status, 'ok');

    // Outbox written
    const outboxFiles = fs.readdirSync(deps.outboxDir);
    assert.strictEqual(outboxFiles.length, 1);
    const outboxMsg = JSON.parse(fs.readFileSync(path.join(deps.outboxDir, outboxFiles[0]), 'utf8'));
    assert.strictEqual(outboxMsg.text, 'Report done');

    // Question added
    const questions = agentDb.openQuestions();
    assert.strictEqual(questions.length, 1);
    assert.strictEqual(questions[0].domain, 'test');

    // Drain called
    assert.ok(drainCalls.length > 0);

    // Queue files cleaned up
    assert.ok(!fs.existsSync(path.join(deps.queueDir, 'results', 'req-1.json')));

    cleanup();
  });

  // --- Invalid JSON: re-enqueue ---

  test('invalid JSON result: re-enqueues with retry preamble', async () => {
    const { deps, agentDb, cleanup } = makeSweepDeps(tmpDir);
    insertPending(agentDb, 'req-bad');
    writeRequest(deps.queueDir, 'req-bad');
    writeResult(deps.queueDir, 'req-bad', {
      id: 'req-bad', ts: '2026-07-18T10:00:00Z', ok: true,
      text: 'not valid json at all',
    });

    await runSweep(deps);

    // Should still be open with updated request_id
    const pendings = agentDb.openPendings();
    assert.strictEqual(pendings.length, 1);
    assert.notStrictEqual(pendings[0].request_id, 'req-bad');
    assert.strictEqual(pendings[0].enqueue_count, 2);

    // New request file should exist
    const reqDir = path.join(deps.queueDir, 'requests');
    const reqFiles = fs.readdirSync(reqDir).filter(f => f.endsWith('.json'));
    assert.ok(reqFiles.length >= 1);

    // Check retry preamble in new request
    const newReqFile = reqFiles.find(f => !f.startsWith('req-bad'));
    const newReq = JSON.parse(fs.readFileSync(path.join(reqDir, newReqFile), 'utf8'));
    assert.ok(newReq.system.includes('CRITICAL'));

    cleanup();
  });

  test('invalid JSON after 3 attempts: degraded completion', async () => {
    const { deps, agentDb, cleanup } = makeSweepDeps(tmpDir);
    insertPending(agentDb, 'req-fail');
    writeRequest(deps.queueDir, 'req-fail');
    // Manually set enqueue_count to 3
    agentDb.updatePendingRequest(1, 'req-fail', 3);
    writeResult(deps.queueDir, 'req-fail', {
      id: 'req-fail', ts: '2026-07-18T10:00:00Z', ok: true,
      text: 'still garbage',
    });

    await runSweep(deps);

    const pending = agentDb.getPending(1);
    assert.strictEqual(pending.status, 'degraded');

    const lastRun = agentDb.lastRun('report');
    assert.strictEqual(lastRun.status, 'degraded');
    assert.ok(lastRun.detail.includes('JSON validation failed'));

    cleanup();
  });

  // --- ok:false auth_expired ---

  test('ok:false auth_expired: immediate degraded completion', async () => {
    const { deps, agentDb, cleanup } = makeSweepDeps(tmpDir);
    insertPending(agentDb, 'req-auth');
    writeRequest(deps.queueDir, 'req-auth');
    writeResult(deps.queueDir, 'req-auth', {
      id: 'req-auth', ts: '2026-07-18T10:00:00Z', ok: false,
      error: 'auth_expired', detail: 'login required',
    });

    await runSweep(deps);

    const pending = agentDb.getPending(1);
    assert.strictEqual(pending.status, 'degraded');

    const lastRun = agentDb.lastRun('report');
    assert.ok(lastRun.detail.includes('MBA claude login'));

    // Outbox written with degraded message
    const outboxFiles = fs.readdirSync(deps.outboxDir);
    assert.ok(outboxFiles.length > 0);

    cleanup();
  });

  // --- Request file missing: re-enqueue ---

  test('request file vanished: re-enqueues', async () => {
    const { deps, agentDb, cleanup } = makeSweepDeps(tmpDir);
    insertPending(agentDb, 'req-gone');
    // Deliberately do NOT write the request file

    await runSweep(deps);

    const pendings = agentDb.openPendings();
    assert.strictEqual(pendings.length, 1);
    assert.notStrictEqual(pendings[0].request_id, 'req-gone');
    assert.strictEqual(pendings[0].enqueue_count, 2);

    cleanup();
  });

  // --- 2min interim notification ---

  test('2min interim: check origin gets notification, idle does not', async () => {
    const { deps, drainCalls, agentDb, cleanup } = makeSweepDeps(tmpDir, {
      // Created 3 minutes ago
      getNow: () => '2026-07-18T09:53:00Z',
    });

    // Insert check-origin pending created 3 min before "now"
    insertPending(agentDb, 'req-check', { origin: 'check', created_at: '2026-07-18T09:50:00Z' });
    writeRequest(deps.queueDir, 'req-check');

    await runSweep(deps);

    // Should have interim_notified set
    const pending = agentDb.getPending(1);
    assert.strictEqual(pending.interim_notified, 1);

    // Outbox written
    const outboxFiles = fs.readdirSync(deps.outboxDir);
    assert.ok(outboxFiles.length > 0);
    const msg = JSON.parse(fs.readFileSync(path.join(deps.outboxDir, outboxFiles[0]), 'utf8'));
    assert.ok(msg.text.includes('MBA'));

    // Drain called
    assert.ok(drainCalls.length > 0);

    cleanup();
  });

  test('2min interim: idle origin does NOT get interim notification', async () => {
    const { deps, agentDb, cleanup } = makeSweepDeps(tmpDir, {
      getNow: () => '2026-07-18T09:53:00Z',
    });

    insertPending(agentDb, 'req-idle', { origin: 'idle', created_at: '2026-07-18T09:50:00Z' });
    writeRequest(deps.queueDir, 'req-idle');

    await runSweep(deps);

    const pending = agentDb.getPending(1);
    assert.strictEqual(pending.interim_notified, 0);

    // No outbox
    assert.ok(!fs.existsSync(deps.outboxDir));

    cleanup();
  });

  // --- Deadline exceeded ---

  test('deadline exceeded: degraded completion', async () => {
    const { deps, agentDb, cleanup } = makeSweepDeps(tmpDir, {
      // Created 9 hours ago (deadline is 8h)
      getNow: () => '2026-07-18T18:50:00Z',
      config: { model: 'claude-sonnet-5', renderDeadlineHours: 8 },
    });

    insertPending(agentDb, 'req-old', { created_at: '2026-07-18T09:50:00Z' });
    writeRequest(deps.queueDir, 'req-old');

    await runSweep(deps);

    const pending = agentDb.getPending(1);
    assert.strictEqual(pending.status, 'degraded');

    const lastRun = agentDb.lastRun('report');
    assert.ok(lastRun.detail.includes('deadline'));

    cleanup();
  });

  // --- Daemon restart survival ---

  test('pending row survives sweep cycle without result (no crash)', async () => {
    const { deps, agentDb, cleanup } = makeSweepDeps(tmpDir);
    insertPending(agentDb, 'req-waiting');
    writeRequest(deps.queueDir, 'req-waiting');

    await runSweep(deps);

    // Pending should still be open
    const pendings = agentDb.openPendings();
    assert.strictEqual(pendings.length, 1);
    assert.strictEqual(pendings[0].request_id, 'req-waiting');
    assert.strictEqual(pendings[0].status, 'open');

    cleanup();
  });

  // --- Junk flags merge ---

  test('completion merges valid junk flags, warns on unmatched', async () => {
    const reportJson = {
      ...MINIMAL_REPORT,
      junk: [
        { id: 'j1', sender: 'a@b.com', subject: 'Spam', flag: 'pending' },
        { id: 'j2', sender: 'c@d.com', subject: 'Maybe', flag: 'pending' },
      ],
    };

    const { deps, agentDb, cleanup } = makeSweepDeps(tmpDir);
    insertPending(agentDb, 'req-junk', { reportJson });
    writeRequest(deps.queueDir, 'req-junk');
    writeResult(deps.queueDir, 'req-junk', {
      id: 'req-junk', ts: '2026-07-18T10:00:00Z', ok: true,
      text: JSON.stringify({
        message_text: 'Report',
        new_questions: [],
        auto_resolved_reminders: [],
        junk_flags: [
          { id: 'j1', flag: 'pending-danger', reason: 'phishy' },
          { id: 'nonexistent', flag: 'pending-normal', reason: 'fake' },
        ],
      }),
    });

    await runSweep(deps);

    // Check the rewritten agent-last-report.json
    const lastReport = JSON.parse(fs.readFileSync(deps.lastReportPath, 'utf8'));
    const j1 = lastReport.junk.find(j => j.id === 'j1');
    assert.strictEqual(j1.flag, 'pending-danger');
    assert.strictEqual(j1.reason, 'phishy');

    // j2 should remain pending (no flag issued for it)
    const j2 = lastReport.junk.find(j => j.id === 'j2');
    assert.strictEqual(j2.flag, 'pending');

    cleanup();
  });

  // --- No open pendings: sweep is no-op ---

  test('no open pendings: sweep does nothing', async () => {
    const { deps, drainCalls, cleanup } = makeSweepDeps(tmpDir);

    await runSweep(deps);

    assert.strictEqual(drainCalls.length, 0);
    assert.ok(!fs.existsSync(deps.outboxDir));

    cleanup();
  });
});

describe('poisoned pending rows', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function insertCorruptPending(agentDb, requestId, createdAt) {
    agentDb.db.prepare(`
      INSERT INTO pending_renders (created_at, origin, window_start, window_end, request_id, report_json, enqueue_count, status)
      VALUES (?, 'check', '2026-07-17T08:00:00Z', '2026-07-18T08:00:00Z', ?, 'NOT JSON', 1, 'open')
    `).run(createdAt, requestId);
  }

  test('a row whose completion throws does not abort the sweep — later rows still process', async () => {
    const { deps, agentDb, cleanup } = makeSweepDeps(tmpDir);

    // Corrupt row first (openPendings is ordered by created_at) with a ready
    // result, so the completion path hits the corrupt report_json and throws
    insertCorruptPending(agentDb, 'poisoned-req', '2026-07-18T09:50:00Z');
    writeResult(deps.queueDir, 'poisoned-req', {
      id: 'poisoned-req', ts: '2026-07-18T10:00:00Z', ok: true,
      text: JSON.stringify({ message_text: 'x', new_questions: [], auto_resolved_reminders: [], junk_flags: [] }),
    });

    insertPending(agentDb, 'healthy-req', { created_at: '2026-07-18T09:51:00Z' });
    writeResult(deps.queueDir, 'healthy-req', {
      id: 'healthy-req', ts: '2026-07-18T10:00:00Z', ok: true,
      text: JSON.stringify({ message_text: 'ok report', new_questions: [], auto_resolved_reminders: [], junk_flags: [] }),
    });

    await runSweep(deps);

    const stillOpen = agentDb.openPendings();
    assert.strictEqual(stillOpen.length, 1);
    assert.strictEqual(stillOpen[0].request_id, 'poisoned-req');

    cleanup();
  });

  test('deadline retires a corrupt row with a fallback degraded message', async () => {
    const { deps, agentDb, cleanup } = makeSweepDeps(tmpDir, {
      getNow: () => '2026-07-18T20:00:00Z',
    });

    insertCorruptPending(agentDb, 'poisoned-req', '2026-07-18T09:50:00Z');
    writeRequest(deps.queueDir, 'poisoned-req');

    await runSweep(deps);

    assert.strictEqual(agentDb.openPendings().length, 0);

    const files = fs.readdirSync(deps.outboxDir);
    assert.strictEqual(files.length, 1);
    const msg = JSON.parse(fs.readFileSync(path.join(deps.outboxDir, files[0]), 'utf8'));
    assert.match(msg.text, /degraded/);
    assert.match(msg.text, /deadline/i);

    const run = agentDb.lastRun('report');
    assert.strictEqual(run.status, 'degraded');

    cleanup();
  });
});

test('completion archives the sent report to sent-reports/', async () => {
  const tmpDir = makeTmpDir();
  const { deps, agentDb, cleanup } = makeSweepDeps(tmpDir);
  insertPending(agentDb, 'req-arch');
  writeResult(deps.queueDir, 'req-arch', {
    id: 'req-arch', ts: '2026-07-18T10:00:00Z', ok: true,
    text: JSON.stringify({ message_text: 'archived report', new_questions: [], auto_resolved_reminders: [], junk_flags: [] }),
  });

  await runSweep(deps);

  const dir = path.join(tmpDir, 'sent-reports');
  const files = fs.readdirSync(dir);
  assert.strictEqual(files.length, 1);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.strictEqual(rec.text, 'archived report');
  assert.strictEqual(rec.origin, 'check');
  assert.strictEqual(rec.status, 'ok');
  cleanup();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

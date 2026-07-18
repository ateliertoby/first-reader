import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runFolderAudit, aggregatePatterns, _setAuditTransportForTesting } from '../src/agent/audit.js';
import { msUntilNextMonthly } from '../src/agent/loop.js';
import { AgentDB } from '../src/agent/db.js';
import { executeOps, _validateOp } from '../src/agent/ops.js';

// --- Helpers ---

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-cli-audit-'));
}

function writeAgentConfig(dir, overrides = {}) {
  const p = path.join(dir, 'agent.json');
  fs.writeFileSync(p, JSON.stringify({
    model: 'claude-sonnet-5',
    reportTime: '08:30',
    timezone: 'Asia/Hong_Kong',
    ...overrides,
  }));
  return p;
}

function makeMsg(sender, subject, receivedDateTime) {
  return {
    from: { emailAddress: { address: sender } },
    subject,
    receivedDateTime,
  };
}

// --- aggregatePatterns ---

describe('aggregatePatterns', () => {
  test('collapses same sender + subjectKey into one pattern', () => {
    const messages = [
      makeMsg('billing@acme.com', 'Invoice #123 processed', '2026-06-01T10:00:00Z'),
      makeMsg('billing@acme.com', 'Invoice #456 processed', '2026-07-01T10:00:00Z'),
    ];
    const patterns = aggregatePatterns(messages, 'Accounting');

    assert.strictEqual(patterns.length, 1);
    assert.strictEqual(patterns[0].sender, 'billing@acme.com');
    assert.strictEqual(patterns[0].count, 2);
    assert.strictEqual(patterns[0].folder, 'Accounting');
  });

  test('different senders with same subject pattern stay separate', () => {
    const messages = [
      makeMsg('a@x.com', 'Payment Receipt #100', '2026-06-01T10:00:00Z'),
      makeMsg('b@y.com', 'Payment Receipt #200', '2026-06-02T10:00:00Z'),
    ];
    const patterns = aggregatePatterns(messages, 'Accounting');

    assert.strictEqual(patterns.length, 2);
    const senders = patterns.map(p => p.sender).sort();
    assert.deepStrictEqual(senders, ['a@x.com', 'b@y.com']);
  });

  test('same sender with different subject patterns stay separate', () => {
    const messages = [
      makeMsg('noreply@bank.com', 'Transfer Confirmation #1', '2026-06-01T10:00:00Z'),
      makeMsg('noreply@bank.com', 'Monthly Statement June', '2026-06-15T10:00:00Z'),
    ];
    const patterns = aggregatePatterns(messages, 'Notifications');

    assert.strictEqual(patterns.length, 2);
  });

  test('tracks first and last dates correctly', () => {
    const messages = [
      makeMsg('info@co.com', 'Update #1', '2026-06-15T10:00:00Z'),
      makeMsg('info@co.com', 'Update #2', '2026-06-01T08:00:00Z'),
      makeMsg('info@co.com', 'Update #3', '2026-07-01T12:00:00Z'),
    ];
    const patterns = aggregatePatterns(messages, 'Notifications');

    assert.strictEqual(patterns.length, 1);
    assert.strictEqual(patterns[0].firstDate, '2026-06-01T08:00:00Z');
    assert.strictEqual(patterns[0].lastDate, '2026-07-01T12:00:00Z');
  });

  test('sender address normalized to lowercase', () => {
    const messages = [
      makeMsg('Billing@Acme.COM', 'Invoice #1', '2026-06-01T10:00:00Z'),
      makeMsg('billing@acme.com', 'Invoice #2', '2026-06-02T10:00:00Z'),
    ];
    const patterns = aggregatePatterns(messages, 'Accounting');

    assert.strictEqual(patterns.length, 1);
    assert.strictEqual(patterns[0].sender, 'billing@acme.com');
    assert.strictEqual(patterns[0].count, 2);
  });

  test('empty messages returns empty array', () => {
    assert.deepStrictEqual(aggregatePatterns([], 'Accounting'), []);
  });

  test('missing sender handled gracefully', () => {
    const messages = [{ from: null, subject: 'Test', receivedDateTime: '2026-06-01T10:00:00Z' }];
    const patterns = aggregatePatterns(messages, 'Accounting');

    assert.strictEqual(patterns.length, 1);
    assert.strictEqual(patterns[0].sender, '');
  });

  test('preserves sample subject (first seen)', () => {
    const messages = [
      makeMsg('a@b.com', 'Order #111 confirmed', '2026-06-01T10:00:00Z'),
      makeMsg('a@b.com', 'Order #222 confirmed', '2026-06-02T10:00:00Z'),
    ];
    const patterns = aggregatePatterns(messages, 'Accounting');

    assert.strictEqual(patterns[0].sample, 'Order #111 confirmed');
  });
});

// --- runFolderAudit with LLM suspects ---

describe('runFolderAudit', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    _setAuditTransportForTesting(null);
    fs.rmSync(tmpDir, { recursive: true });
  });

  function stubGraphGet(accountingMsgs = [], notificationMsgs = []) {
    return async (url) => {
      if (url.includes("displayName eq 'Accounting'")) {
        return { value: [{ id: 'acc-folder-id' }] };
      }
      if (url.includes("displayName eq 'Notifications'")) {
        return { value: [{ id: 'notif-folder-id' }] };
      }
      if (url.includes('acc-folder-id')) {
        return { value: accountingMsgs };
      }
      if (url.includes('notif-folder-id')) {
        return { value: notificationMsgs };
      }
      return { value: [] };
    };
  }

  test('suspects from LLM passed through to report message', async () => {
    const suspects = [{
      folder: 'Notifications',
      sender: 'payments@ridehail.example',
      subject_sample: 'Rider income statement',
      count: 5,
      suggested: 'accounting',
      reason: 'income already paid out with amount shown',
    }];

    _setAuditTransportForTesting(() => ({ suspects, clean: false }));
    const configPath = writeAgentConfig(tmpDir);

    const result = await runFolderAudit({
      dry: true,
      _agentDbPath: path.join(tmpDir, 'agent.db'),
      _outboxDir: path.join(tmpDir, 'outbox'),
      _agentConfigPath: configPath,
      _now: '2026-07-18T10:00:00Z',
      _graphGet: stubGraphGet(
        [makeMsg('payments@ridehail.example', 'Rider income statement', '2026-07-01T10:00:00Z')],
        [makeMsg('payments@ridehail.example', 'Rider income statement #2', '2026-07-02T10:00:00Z')],
      ),
    });

    assert.strictEqual(result.status, 'ok');
    assert.ok(result.message.includes('suspects'));
    assert.ok(result.message.includes('payments@ridehail.example'));
    assert.ok(result.message.includes('accounting'));
    assert.ok(result.message.includes('建議'));
  });

  test('clean audit returns clean message', async () => {
    _setAuditTransportForTesting(() => ({ suspects: [], clean: true }));
    const configPath = writeAgentConfig(tmpDir);

    const result = await runFolderAudit({
      dry: true,
      _agentDbPath: path.join(tmpDir, 'agent.db'),
      _outboxDir: path.join(tmpDir, 'outbox'),
      _agentConfigPath: configPath,
      _now: '2026-07-18T10:00:00Z',
      _graphGet: stubGraphGet(
        [makeMsg('a@b.com', 'Receipt', '2026-07-01T10:00:00Z')],
      ),
    });

    assert.strictEqual(result.status, 'ok');
    assert.ok(result.message.includes('乾淨'));
  });

  test('degraded on LLM transport throw', async () => {
    _setAuditTransportForTesting(() => { throw new Error('API down'); });
    const configPath = writeAgentConfig(tmpDir);

    const result = await runFolderAudit({
      dry: true,
      _agentDbPath: path.join(tmpDir, 'agent.db'),
      _outboxDir: path.join(tmpDir, 'outbox'),
      _agentConfigPath: configPath,
      _now: '2026-07-18T10:00:00Z',
      _graphGet: stubGraphGet(
        [makeMsg('a@b.com', 'Receipt #1', '2026-07-01T10:00:00Z')],
        [makeMsg('c@d.com', 'Alert #1', '2026-07-01T10:00:00Z')],
      ),
    });

    assert.strictEqual(result.status, 'degraded');
    assert.ok(result.message.includes('degraded'));
    assert.ok(result.message.includes('LLM'));
    assert.ok(result.message.includes('Accounting'));
    assert.ok(result.message.includes('Notifications'));
  });

  test('dry mode prints to stdout, no outbox or logRun', async () => {
    _setAuditTransportForTesting(() => ({ suspects: [], clean: true }));
    const configPath = writeAgentConfig(tmpDir);
    const outboxDir = path.join(tmpDir, 'outbox');

    await runFolderAudit({
      dry: true,
      _agentDbPath: path.join(tmpDir, 'agent.db'),
      _outboxDir: outboxDir,
      _agentConfigPath: configPath,
      _now: '2026-07-18T10:00:00Z',
      _graphGet: stubGraphGet([makeMsg('a@b.com', 'X', '2026-07-01T10:00:00Z')]),
    });

    // No outbox file created
    assert.strictEqual(fs.existsSync(outboxDir), false);

    // No agent_runs entry
    const db = new AgentDB(path.join(tmpDir, 'agent.db'));
    const lastRun = db.lastRun('audit');
    assert.strictEqual(lastRun, null);
    db.close();
  });

  test('non-dry writes outbox file and logs audit run', async () => {
    _setAuditTransportForTesting(() => ({ suspects: [], clean: true }));
    const configPath = writeAgentConfig(tmpDir);
    const outboxDir = path.join(tmpDir, 'outbox');

    await runFolderAudit({
      dry: false,
      _agentDbPath: path.join(tmpDir, 'agent.db'),
      _outboxDir: outboxDir,
      _agentConfigPath: configPath,
      _now: '2026-07-18T10:00:00Z',
      _graphGet: stubGraphGet([makeMsg('a@b.com', 'X', '2026-07-01T10:00:00Z')]),
    });

    // Outbox file exists
    const files = fs.readdirSync(outboxDir).filter(f => f.endsWith('.json'));
    assert.strictEqual(files.length, 1);

    const data = JSON.parse(fs.readFileSync(path.join(outboxDir, files[0]), 'utf8'));
    assert.ok(data.text.includes('乾淨'));

    // agent_runs entry
    const db = new AgentDB(path.join(tmpDir, 'agent.db'));
    const lastRun = db.lastRun('audit');
    assert.strictEqual(lastRun.kind, 'audit');
    assert.strictEqual(lastRun.status, 'ok');
    db.close();
  });

  test('logRun records degraded status on LLM failure', async () => {
    _setAuditTransportForTesting(() => { throw new Error('boom'); });
    const configPath = writeAgentConfig(tmpDir);

    await runFolderAudit({
      dry: false,
      _agentDbPath: path.join(tmpDir, 'agent.db'),
      _outboxDir: path.join(tmpDir, 'outbox'),
      _agentConfigPath: configPath,
      _now: '2026-07-18T10:00:00Z',
      _graphGet: stubGraphGet([makeMsg('a@b.com', 'X', '2026-07-01T10:00:00Z')]),
    });

    const db = new AgentDB(path.join(tmpDir, 'agent.db'));
    const lastRun = db.lastRun('audit');
    assert.strictEqual(lastRun.status, 'degraded');
    assert.ok(lastRun.detail.includes('LLM'));
    db.close();
  });

  test('empty folders: ok status, specific message', async () => {
    const configPath = writeAgentConfig(tmpDir);

    const result = await runFolderAudit({
      dry: true,
      _agentDbPath: path.join(tmpDir, 'agent.db'),
      _outboxDir: path.join(tmpDir, 'outbox'),
      _agentConfigPath: configPath,
      _now: '2026-07-18T10:00:00Z',
      _graphGet: stubGraphGet(),
    });

    assert.strictEqual(result.status, 'ok');
    assert.ok(result.message.includes('空'));
  });

  test('report footer mentions conversation channel when suspects exist', async () => {
    _setAuditTransportForTesting(() => ({
      suspects: [{
        folder: 'Accounting', sender: 'a@b.com', subject_sample: 'Test',
        count: 1, suggested: 'notifications', reason: 'no amount',
      }],
      clean: false,
    }));
    const configPath = writeAgentConfig(tmpDir);

    const result = await runFolderAudit({
      dry: true,
      _agentDbPath: path.join(tmpDir, 'agent.db'),
      _outboxDir: path.join(tmpDir, 'outbox'),
      _agentConfigPath: configPath,
      _now: '2026-07-18T10:00:00Z',
      _graphGet: stubGraphGet([makeMsg('a@b.com', 'Test', '2026-07-01T10:00:00Z')]),
    });

    assert.ok(result.message.includes('Telegram'));
  });
});

// --- msUntilNextMonthly ---

describe('msUntilNextMonthly', () => {
  test('mid-month: fires on 1st of next month', () => {
    // 2026-07-15 08:00 HKT (00:00 UTC) -> next 1st = 2026-08-01 08:30 HKT
    const ms = msUntilNextMonthly('08:30', 'Asia/Hong_Kong', '2026-07-15T00:00:00Z');
    // 16 days remaining in July (15->31 = 16 days) + 0 days + 30min
    // Jul has 31 days, day 15 -> 17 days until Aug 1st, then 30 min
    // daysUntilFirst = 31 - 15 + 1 = 17
    // minsUntilMidnight1st = 17 * 1440 - (8*60+0) = 24480 - 480 = 24000
    // totalMs = (24000 + 510) * 60 * 1000 = 24510 * 60000 = 1,470,600,000
    // Actually let me recalculate: nowMins = 8*60+0 = 480 (HKT)
    // targetMins = 8*60+30 = 510
    // daysInMonth for July = 31
    // daysUntilFirst = 31 - 15 + 1 = 17
    // minsUntilMidnight1st = 17 * 1440 - 480 = 24480 - 480 = 24000
    // total = (24000 + 510) * 60 - 0 = 24510 * 60 = 1470600 sec = 1,470,600,000 ms
    assert.strictEqual(ms, 1_470_600_000);
  });

  test('on the 1st before slot: fires today', () => {
    // 2026-08-01 08:00 HKT (00:00 UTC), target 08:30 -> 30 min
    const ms = msUntilNextMonthly('08:30', 'Asia/Hong_Kong', '2026-08-01T00:00:00Z');
    assert.strictEqual(ms, 30 * 60 * 1000);
  });

  test('on the 1st after slot: fires next month 1st', () => {
    // 2026-08-01 10:00 HKT (02:00 UTC), target 08:30
    // nowMins = 10*60 = 600, targetMins = 510, 600 > 510 -> next month
    // Aug has 31 days, day 1 -> daysUntilFirst = 31 - 1 + 1 = 31
    // minsUntilMidnight1st = 31 * 1440 - 600 = 44640 - 600 = 44040
    // total = (44040 + 510) * 60 = 44550 * 60 = 2673000 sec = 2,673,000,000 ms
    const ms = msUntilNextMonthly('08:30', 'Asia/Hong_Kong', '2026-08-01T02:00:00Z');
    assert.strictEqual(ms, 2_673_000_000);
  });

  test('timezone honored: same UTC, different tz', () => {
    // 2026-07-15T12:00:00Z
    // HKT = 20:00 Jul 15 -> mid-month, fires Aug 1
    const hkt = msUntilNextMonthly('08:30', 'Asia/Hong_Kong', '2026-07-15T12:00:00Z');
    // EDT = 08:00 Jul 15 -> mid-month, fires Aug 1
    const edt = msUntilNextMonthly('08:30', 'America/New_York', '2026-07-15T12:00:00Z');

    // Different values because different local times
    assert.notStrictEqual(hkt, edt);
    // Both should be positive
    assert.ok(hkt > 0);
    assert.ok(edt > 0);
  });

  test('accounts for seconds within the minute', () => {
    // 2026-08-01 08:00:30 HKT (00:00:30 UTC), target 08:30 -> 29m30s
    const ms = msUntilNextMonthly('08:30', 'Asia/Hong_Kong', '2026-08-01T00:00:30Z');
    assert.strictEqual(ms, (29 * 60 + 30) * 1000);
  });

  test('Dec wraps to Jan next year', () => {
    // 2026-12-15 08:00 HKT (00:00 UTC) -> next 1st = 2027-01-01 08:30 HKT
    // Dec has 31 days, day 15 -> daysUntilFirst = 31 - 15 + 1 = 17
    // nowMins = 480, targetMins = 510
    // minsUntilMidnight = 17 * 1440 - 480 = 24480 - 480 = 24000
    // total = (24000 + 510) * 60 = 24510 * 60 = 1,470,600 sec
    const ms = msUntilNextMonthly('08:30', 'Asia/Hong_Kong', '2026-12-15T00:00:00Z');
    assert.strictEqual(ms, 1_470_600_000);
  });

  test('accepts Date object', () => {
    const ms = msUntilNextMonthly('08:30', 'Asia/Hong_Kong', new Date('2026-08-01T00:00:00Z'));
    assert.strictEqual(ms, 30 * 60 * 1000);
  });
});

// --- trigger_audit op wiring ---

describe('trigger_audit op wiring', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('trigger_audit returns ack immediately, fires audit in background', async () => {
    let auditCalled = false;
    let drainCalled = false;

    const agentDb = new AgentDB(path.join(tmpDir, 'agent.db'));
    const results = await executeOps([{ type: 'trigger_audit' }], {
      rulesPath: path.join(tmpDir, 'rules.json'),
      notesPath: path.join(tmpDir, 'notes.md'),
      sortDbPath: path.join(tmpDir, 'transactions.db'),
      agentDb,
      git: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      graphGet: async () => ({ id: 'x', value: [] }),
      graphPost: async () => ({ id: 'x' }),
      runReport: async () => ({}),
      runAudit: async () => { auditCalled = true; },
      drainOutbox: async () => { drainCalled = true; },
      deepVerify: async () => '',
      getNow: () => '2026-07-18T10:00:00Z',
      userText: 'audit',
    });

    // Ack returned immediately
    assert.ok(results[0].includes('收到'));
    // Background work fires asynchronously
    await new Promise(r => setTimeout(r, 10));
    assert.ok(auditCalled, 'runAudit should have been called');
    assert.ok(drainCalled, 'drainOutbox should have been called');
    agentDb.close();
  });

  test('trigger_audit error reported via send (fire-and-forget)', async () => {
    let sentError = null;
    const agentDb = new AgentDB(path.join(tmpDir, 'agent.db'));
    const results = await executeOps([{ type: 'trigger_audit' }], {
      rulesPath: path.join(tmpDir, 'rules.json'),
      notesPath: path.join(tmpDir, 'notes.md'),
      sortDbPath: path.join(tmpDir, 'transactions.db'),
      agentDb,
      git: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      graphGet: async () => ({ id: 'x', value: [] }),
      graphPost: async () => ({ id: 'x' }),
      runReport: async () => ({}),
      runAudit: async () => { throw new Error('Graph API down'); },
      drainOutbox: async () => ({}),
      send: async (text) => { sentError = text; },
      deepVerify: async () => '',
      getNow: () => '2026-07-18T10:00:00Z',
      userText: 'audit',
    });

    // Ack returned immediately
    assert.ok(results[0].includes('收到'));
    // Wait for background chain
    await new Promise(r => setTimeout(r, 10));
    assert.ok(sentError, 'error should have been sent');
    assert.ok(sentError.includes('Graph API down'));
    agentDb.close();
  });
});

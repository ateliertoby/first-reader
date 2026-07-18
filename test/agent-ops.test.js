import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { executeOps, makeGitRunner, _validateOp } from '../src/agent/ops.js';
import { AgentDB } from '../src/agent/db.js';
import { SortLogDB } from '../src/sorter/db.js';

// --- Helpers ---

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-cli-ops-'));
}

function writeRules(dir, rules = [], guards = ['urgent']) {
  const p = path.join(dir, 'rules.json');
  fs.writeFileSync(p, JSON.stringify({
    guards,
    settings: { minAgeHours: 6 },
    rules,
  }, null, 2) + '\n');
  return p;
}

// Stub git: all commands succeed by default
function stubGit(overrides = {}) {
  return async (args) => {
    const cmd = args[0];
    if (overrides[cmd]) return overrides[cmd](args);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

function makeDeps(tmpDir, overrides = {}) {
  const rulesPath = overrides.rulesPath ?? path.join(tmpDir, 'rules.json');
  const notesPath = overrides.notesPath ?? path.join(tmpDir, 'agent-notes.md');
  const sortDbPath = overrides.sortDbPath ?? path.join(tmpDir, 'transactions.db');
  const agentDb = overrides.agentDb ?? new AgentDB(path.join(tmpDir, 'agent.db'));
  return {
    rulesPath,
    notesPath,
    sortDbPath,
    agentDb,
    git: overrides.git ?? stubGit(),
    graphGet: overrides.graphGet ?? (async () => ({ id: 'inbox-id', value: [] })),
    graphPost: overrides.graphPost ?? (async () => ({ id: 'new-id' })),
    runReport: overrides.runReport ?? (async () => ({})),
    runAudit: overrides.runAudit ?? (async () => ({})),
    drainOutbox: overrides.drainOutbox ?? (async () => ({})),
    deepVerify: overrides.deepVerify ?? (async (claim) => `verified: ${claim}`),
    runInspection: overrides.runInspection ?? (async (emailId) => `[SAFE] ${emailId}\n\n呢個係檢驗，唔係判決 — 開唔開你話事`),
    model: overrides.model ?? 'test-model',
    getNow: overrides.getNow ?? (() => '2026-07-18T10:00:00Z'),
    userText: overrides.userText ?? 'test command',
    _agentDbOwned: !overrides.agentDb,
  };
}

function closeDeps(deps) {
  if (deps._agentDbOwned && deps.agentDb) deps.agentDb.close();
}

// --- Validation ---

describe('op validation', () => {
  test('rejects unknown op type', () => {
    const err = _validateOp({ type: 'explode' });
    assert.ok(err.includes('唔識'));
  });

  test('rejects missing type', () => {
    const err = _validateOp({});
    assert.ok(err.includes('冇 type'));
  });

  test('rejects null op', () => {
    const err = _validateOp(null);
    assert.ok(err);
  });

  test('rule_add: rejects missing bucket', () => {
    const err = _validateOp({ type: 'rule_add', domains: ['test.com'] });
    assert.ok(err.includes('bucket'));
  });

  test('rule_add: rejects empty domains', () => {
    const err = _validateOp({ type: 'rule_add', bucket: 'notifications', domains: [] });
    assert.ok(err.includes('domains'));
  });

  test('rule_add: rejects domain with @', () => {
    const err = _validateOp({ type: 'rule_add', bucket: 'notifications', domains: ['user@test.com'] });
    assert.ok(err.includes('@'));
  });

  test('rule_add: rejects domain without dot', () => {
    const err = _validateOp({ type: 'rule_add', bucket: 'notifications', domains: ['testcom'] });
    assert.ok(err.includes('dot'));
  });

  test('rule_add: rejects uppercase domain', () => {
    const err = _validateOp({ type: 'rule_add', bucket: 'notifications', domains: ['Test.com'] });
    assert.ok(err.includes('lowercase'));
  });

  test('rule_add: rejects bad subject regex', () => {
    const err = _validateOp({ type: 'rule_add', bucket: 'notifications', domains: ['test.com'], subject: '(unclosed' });
    assert.ok(err.includes('regex'));
  });

  test('rule_add: rejects bad subjectExclude regex', () => {
    const err = _validateOp({ type: 'rule_add', bucket: 'notifications', domains: ['test.com'], subjectExclude: '[invalid' });
    assert.ok(err.includes('regex'));
  });

  test('rule_add: accepts valid op', () => {
    const err = _validateOp({ type: 'rule_add', bucket: 'notifications', domains: ['test.com'], subject: 'alert.*', note: 'test' });
    assert.strictEqual(err, null);
  });

  test('rule_rm: rejects missing id', () => {
    const err = _validateOp({ type: 'rule_rm' });
    assert.ok(err.includes('id'));
  });

  test('guard_add: rejects missing word', () => {
    const err = _validateOp({ type: 'guard_add' });
    assert.ok(err.includes('word'));
  });

  test('rescue: rejects no filters', () => {
    const err = _validateOp({ type: 'rescue' });
    assert.ok(err.includes('filter'));
  });

  test('rescue: accepts with sender filter', () => {
    assert.strictEqual(_validateOp({ type: 'rescue', sender: 'foo@bar.com' }), null);
  });

  test('reminder_ack: rejects non-numeric id', () => {
    const err = _validateOp({ type: 'reminder_ack', id: 'abc' });
    assert.ok(err.includes('number'));
  });

  test('reminder_ack: accepts numeric string id', () => {
    assert.strictEqual(_validateOp({ type: 'reminder_ack', id: '3' }), null);
  });

  test('junk_rescue: rejects missing email_id', () => {
    const err = _validateOp({ type: 'junk_rescue' });
    assert.ok(err.includes('email_id'));
  });

  test('deep_verify: rejects missing claim', () => {
    const err = _validateOp({ type: 'deep_verify' });
    assert.ok(err.includes('claim'));
  });

  test('note_add: rejects missing text', () => {
    const err = _validateOp({ type: 'note_add' });
    assert.ok(err.includes('text'));
  });

  test('trigger_report: no params required', () => {
    assert.strictEqual(_validateOp({ type: 'trigger_report' }), null);
  });

  test('trigger_audit: no params required', () => {
    assert.strictEqual(_validateOp({ type: 'trigger_audit' }), null);
  });
});

// --- executeOps ---

describe('executeOps', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('unknown op type: rejected with message', async () => {
    const deps = makeDeps(tmpDir);
    const results = await executeOps([{ type: 'nuke_everything' }], deps);
    closeDeps(deps);
    assert.strictEqual(results.length, 1);
    assert.ok(results[0].includes('唔識'));
  });

  test('rule_add: happy path writes config and returns confirmation', async () => {
    writeRules(tmpDir);
    const deps = makeDeps(tmpDir);

    const results = await executeOps([{
      type: 'rule_add',
      bucket: 'notifications',
      domains: ['example.com'],
      note: 'test rule',
    }], deps);
    closeDeps(deps);

    assert.strictEqual(results.length, 1);
    assert.ok(results[0].includes('已落 rule'));
    assert.ok(results[0].includes('notifications'));
    assert.ok(results[0].includes('probation'));

    // Verify config was written
    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'rules.json'), 'utf8'));
    assert.ok(config.rules.some(r => r.domains.includes('example.com')));
  });

  test('rule_rm: happy path removes rule', async () => {
    writeRules(tmpDir, [{ id: 'to-remove', bucket: 'notifications', domains: ['rem.com'] }]);
    const deps = makeDeps(tmpDir);

    const results = await executeOps([{ type: 'rule_rm', id: 'to-remove' }], deps);
    closeDeps(deps);

    assert.strictEqual(results.length, 1);
    assert.ok(results[0].includes('已刪 rule'));
    assert.ok(results[0].includes('to-remove'));

    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'rules.json'), 'utf8'));
    assert.strictEqual(config.rules.length, 0);
  });

  test('rule_rm: non-existent rule returns failure', async () => {
    writeRules(tmpDir);
    const deps = makeDeps(tmpDir);

    const results = await executeOps([{ type: 'rule_rm', id: 'no-such' }], deps);
    closeDeps(deps);

    assert.strictEqual(results.length, 1);
    assert.ok(results[0].includes('not found'));
  });

  test('guard_add: happy path', async () => {
    writeRules(tmpDir);
    const deps = makeDeps(tmpDir);

    const results = await executeOps([{ type: 'guard_add', word: 'payment' }], deps);
    closeDeps(deps);

    assert.ok(results[0].includes('已加 guard'));
    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'rules.json'), 'utf8'));
    assert.ok(config.guards.includes('payment'));
  });

  test('guard_rm: happy path', async () => {
    writeRules(tmpDir, [], ['urgent', 'payment']);
    const deps = makeDeps(tmpDir);

    const results = await executeOps([{ type: 'guard_rm', word: 'payment' }], deps);
    closeDeps(deps);

    assert.ok(results[0].includes('已刪 guard'));
    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'rules.json'), 'utf8'));
    assert.ok(!config.guards.includes('payment'));
  });

  test('rescue: happy path moves emails back', async () => {
    const sortDbPath = path.join(tmpDir, 'transactions.db');
    const logDb = new SortLogDB(sortDbPath);
    logDb.insert({
      run_at: '2026-07-18T08:00:00Z', email_id: 'email-1',
      sender: 'foo@test.com', domain: 'test.com', subject: 'Test',
      subject_key: 'test', received_at: '2026-07-18T07:00:00Z',
      bucket: 'notifications', rule_id: 'test-rule', action: 'moved', parsed: 1
    });
    logDb.close();

    let movedTo = null;
    const deps = makeDeps(tmpDir, {
      sortDbPath,
      graphGet: async () => ({ id: 'inbox-folder-id' }),
      graphPost: async (url, body) => {
        movedTo = body.destinationId;
        return { id: 'email-1-new' };
      },
    });

    const results = await executeOps([{ type: 'rescue', sender: 'foo@test.com' }], deps);
    closeDeps(deps);

    assert.ok(results.some(r => r.includes('已 rescue')));
    assert.strictEqual(movedTo, 'inbox-folder-id');

    // Verify unsorted row was inserted
    const logDb2 = new SortLogDB(sortDbPath);
    assert.ok(logDb2.isUnsorted('email-1-new'));
    logDb2.close();
  });

  test('rescue: no matching emails', async () => {
    const sortDbPath = path.join(tmpDir, 'transactions.db');
    const logDb = new SortLogDB(sortDbPath);
    logDb.close();

    const deps = makeDeps(tmpDir, { sortDbPath });
    const results = await executeOps([{ type: 'rescue', sender: 'nobody@test.com' }], deps);
    closeDeps(deps);

    assert.ok(results[0].includes('冇搵到'));
  });

  test('reminder_ack: resolves open reminder', async () => {
    const agentDb = new AgentDB(path.join(tmpDir, 'agent.db'));
    agentDb.addReminder({
      kind: 'hketoll-reminder', source_email_id: 'e-1',
      subject: 'toll payment', now: '2026-07-18T08:00:00Z'
    });
    const reminders = agentDb.openReminders();
    const remId = reminders[0].id;

    const deps = makeDeps(tmpDir, { agentDb });
    const results = await executeOps([{ type: 'reminder_ack', id: remId }], deps);

    assert.ok(results[0].includes('已確認'));
    assert.strictEqual(agentDb.openReminders().length, 0);
    agentDb.close();
  });

  test('reminder_ack: non-existent id returns failure', async () => {
    const agentDb = new AgentDB(path.join(tmpDir, 'agent.db'));
    const deps = makeDeps(tmpDir, { agentDb });

    const results = await executeOps([{ type: 'reminder_ack', id: 999 }], deps);

    assert.ok(results[0].includes('搵唔到'));
    agentDb.close();
  });

  test('junk_rescue: moves to inbox', async () => {
    let postUrl = null;
    const deps = makeDeps(tmpDir, {
      graphPost: async (url, body) => {
        postUrl = url;
        return { id: 'new-id' };
      },
    });

    const results = await executeOps([{ type: 'junk_rescue', email_id: 'junk-123' }], deps);
    closeDeps(deps);

    assert.ok(results[0].includes('已將 junk'));
    assert.ok(postUrl.includes('junk-123'));
    assert.ok(postUrl.includes('move'));
  });

  test('junk_dismiss: records dismissal', async () => {
    const agentDb = new AgentDB(path.join(tmpDir, 'agent.db'));
    const deps = makeDeps(tmpDir, { agentDb });

    const results = await executeOps([{ type: 'junk_dismiss', email_id: 'junk-456' }], deps);

    assert.ok(results[0].includes('已 dismiss'));
    assert.ok(agentDb.isJunkDismissed('junk-456'));
    agentDb.close();
  });

  test('trigger_report: returns ack immediately, fires report in background', async () => {
    let reportCalled = false;
    let drainCalled = false;
    const deps = makeDeps(tmpDir, {
      runReport: async () => { reportCalled = true; },
      drainOutbox: async () => { drainCalled = true; },
    });

    const results = await executeOps([{ type: 'trigger_report' }], deps);
    closeDeps(deps);

    // Ack returned immediately
    assert.ok(results[0].includes('收到'));
    // Background work fires asynchronously — wait a tick for it to complete
    await new Promise(r => setTimeout(r, 10));
    assert.ok(reportCalled);
    assert.ok(drainCalled);
  });

  test('trigger_audit: returns ack immediately, fires audit in background', async () => {
    let auditCalled = false;
    let drainCalled = false;
    const deps = makeDeps(tmpDir, {
      runAudit: async () => { auditCalled = true; },
      drainOutbox: async () => { drainCalled = true; },
    });
    const results = await executeOps([{ type: 'trigger_audit' }], deps);
    closeDeps(deps);

    // Ack returned immediately
    assert.ok(results[0].includes('收到'));
    // Background work fires asynchronously — wait a tick for it to complete
    await new Promise(r => setTimeout(r, 10));
    assert.ok(auditCalled);
    assert.ok(drainCalled);
  });

  test('deep_verify: calls deepVerify dep and returns evidence', async () => {
    const deps = makeDeps(tmpDir, {
      deepVerify: async (claim) => `Evidence found for: ${claim}`,
    });

    const results = await executeOps([{
      type: 'deep_verify', claim: 'sender is legit',
    }], deps);
    closeDeps(deps);

    assert.ok(results[0].includes('Evidence found'));
    assert.ok(results[0].includes('sender is legit'));
  });

  test('inspect: calls runInspection and returns report', async () => {
    const deps = makeDeps(tmpDir, {
      runInspection: async (emailId) => `[SAFE] Inspected ${emailId}\n\n呢個係檢驗，唔係判決 — 開唔開你話事`,
    });
    const results = await executeOps([{ type: 'inspect', email_id: 'x' }], deps);
    closeDeps(deps);

    assert.ok(results[0].includes('SAFE'));
    assert.ok(results[0].includes('Inspected x'));
  });

  test('note_add: appends to notes file', async () => {
    const notesPath = path.join(tmpDir, 'agent-notes.md');
    fs.writeFileSync(notesPath, '# Notes\n');
    const deps = makeDeps(tmpDir, { notesPath });

    const results = await executeOps([{ type: 'note_add', text: 'remember this' }], deps);
    closeDeps(deps);

    assert.ok(results[0].includes('已記低'));
    const content = fs.readFileSync(notesPath, 'utf8');
    assert.ok(content.includes('remember this'));
    assert.ok(content.startsWith('# Notes\n'));
  });

  test('note_add: creates file if missing', async () => {
    const notesPath = path.join(tmpDir, 'new-notes.md');
    const deps = makeDeps(tmpDir, { notesPath });

    const results = await executeOps([{ type: 'note_add', text: 'first note' }], deps);
    closeDeps(deps);

    assert.ok(results[0].includes('已記低'));
    assert.ok(fs.existsSync(notesPath));
    assert.ok(fs.readFileSync(notesPath, 'utf8').includes('first note'));
  });

  test('multiple ops: results collected in order', async () => {
    writeRules(tmpDir);
    const agentDb = new AgentDB(path.join(tmpDir, 'agent.db'));
    const deps = makeDeps(tmpDir, { agentDb });

    const results = await executeOps([
      { type: 'trigger_audit' },
      { type: 'inspect', email_id: 'x' },
    ], deps);

    assert.strictEqual(results.length, 2);
    assert.ok(results[0].includes('收到'));
    assert.ok(results[1].includes('SAFE'));
    agentDb.close();
  });

  test('validation failure does not prevent other ops', async () => {
    const deps = makeDeps(tmpDir);
    const results = await executeOps([
      { type: 'rule_add' }, // missing bucket + domains
      { type: 'trigger_audit' },
    ], deps);
    closeDeps(deps);

    assert.strictEqual(results.length, 2);
    assert.ok(results[0].includes('bucket'));
    assert.ok(results[1].includes('收到'));
  });
});

// --- Git flow tests ---

describe('executeOps git flow', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('rule_add with real git: commits with quoted user text', async () => {
    // Set up bare remote + working repo
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-cli-ops-remote-'));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-cli-ops-work-'));

    try {
      execSync('git init --bare', { cwd: remoteDir, stdio: 'pipe' });
      execSync('git init -b main', { cwd: workDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: workDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: workDir, stdio: 'pipe' });

      // Initial commit with rules.json
      const rulesPath = path.join(workDir, 'rules.json');
      fs.writeFileSync(rulesPath, JSON.stringify({
        guards: ['urgent'], settings: { minAgeHours: 6 }, rules: []
      }, null, 2) + '\n');
      execSync('git add . && git commit -m "init"', { cwd: workDir, stdio: 'pipe' });
      execSync(`git remote add origin ${remoteDir}`, { cwd: workDir, stdio: 'pipe' });
      execSync('git push -u origin main', { cwd: workDir, stdio: 'pipe' });

      const git = makeGitRunner(workDir);
      const agentDb = new AgentDB(path.join(workDir, 'agent.db'));

      const results = await executeOps([{
        type: 'rule_add',
        bucket: 'notifications',
        domains: ['newdomain.com'],
        note: 'test via agent',
      }], {
        rulesPath,
        notesPath: path.join(workDir, 'notes.md'),
        sortDbPath: path.join(workDir, 'transactions.db'),
        agentDb,
        git,
        graphGet: async () => ({}),
        graphPost: async () => ({}),
        runReport: async () => ({}),
        drainOutbox: async () => ({}),
        deepVerify: async () => '',
        getNow: () => '2026-07-18T10:00:00Z',
        userText: '加 newdomain.com 去 notifications',
      });

      agentDb.close();

      // Assert success
      assert.strictEqual(results.length, 1);
      assert.ok(results[0].includes('已落 rule'), `Expected success, got: ${results[0]}`);

      // Assert commit exists with quoted user text
      const log = execSync('git log --oneline -1', { cwd: workDir }).toString();
      assert.ok(log.includes('agent:'), `Expected agent commit, got: ${log}`);
      assert.ok(log.includes('加 newdomain.com'), `Expected quoted text in commit, got: ${log}`);

      // Assert config was written
      const config = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
      assert.ok(config.rules.some(r => r.domains.includes('newdomain.com')));
    } finally {
      fs.rmSync(remoteDir, { recursive: true });
      fs.rmSync(workDir, { recursive: true });
    }
  });

  test('push failure: file reverted, failure message returned', async () => {
    const rulesPath = writeRules(tmpDir);
    const originalContent = fs.readFileSync(rulesPath, 'utf8');

    // Stub: pull OK, add OK, commit OK, push FAIL
    const git = stubGit({
      push: () => ({ exitCode: 1, stdout: '', stderr: 'rejected' }),
    });

    const deps = makeDeps(tmpDir, { git });
    const results = await executeOps([{
      type: 'rule_add', bucket: 'notifications', domains: ['fail.com'],
    }], deps);
    closeDeps(deps);

    assert.strictEqual(results.length, 1);
    assert.ok(results[0].includes('衝突'), `Expected conflict message, got: ${results[0]}`);

    // File should be reverted to pre-write state (post-pull = original since pull is stub)
    const afterContent = fs.readFileSync(rulesPath, 'utf8');
    assert.strictEqual(afterContent, originalContent);
  });

  test('pull failure: abort called, failure message returned', async () => {
    const rulesPath = writeRules(tmpDir);
    const originalContent = fs.readFileSync(rulesPath, 'utf8');

    let abortCalled = false;
    const git = stubGit({
      pull: () => ({ exitCode: 1, stdout: '', stderr: 'conflict' }),
      rebase: (args) => {
        if (args[1] === '--abort') abortCalled = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const deps = makeDeps(tmpDir, { git });
    const results = await executeOps([{
      type: 'rule_add', bucket: 'notifications', domains: ['conflict.com'],
    }], deps);
    closeDeps(deps);

    assert.ok(results[0].includes('衝突'));
    assert.ok(abortCalled, 'git rebase --abort should have been called');

    // File unchanged — writeFn never ran
    const afterContent = fs.readFileSync(rulesPath, 'utf8');
    assert.strictEqual(afterContent, originalContent);
  });

  test('note_add with real git: appends and commits', async () => {
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-cli-ops-remote-'));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-cli-ops-work-'));

    try {
      execSync('git init --bare', { cwd: remoteDir, stdio: 'pipe' });
      execSync('git init -b main', { cwd: workDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: workDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: workDir, stdio: 'pipe' });

      const notesPath = path.join(workDir, 'agent-notes.md');
      fs.writeFileSync(notesPath, '# Notes\n');
      // Also need rules.json for agentDb path context
      writeRules(workDir);
      execSync('git add . && git commit -m "init"', { cwd: workDir, stdio: 'pipe' });
      execSync(`git remote add origin ${remoteDir}`, { cwd: workDir, stdio: 'pipe' });
      execSync('git push -u origin main', { cwd: workDir, stdio: 'pipe' });

      const git = makeGitRunner(workDir);
      const agentDb = new AgentDB(path.join(workDir, 'agent.db'));

      const results = await executeOps([{
        type: 'note_add', text: 'remember: check invoices weekly',
      }], {
        rulesPath: path.join(workDir, 'rules.json'),
        notesPath,
        sortDbPath: path.join(workDir, 'transactions.db'),
        agentDb, git,
        graphGet: async () => ({}),
        graphPost: async () => ({}),
        runReport: async () => ({}),
        drainOutbox: async () => ({}),
        deepVerify: async () => '',
        getNow: () => '2026-07-18T10:00:00Z',
        userText: '記住 check invoices weekly',
      });

      agentDb.close();

      assert.ok(results[0].includes('已記低'));

      const content = fs.readFileSync(notesPath, 'utf8');
      assert.ok(content.includes('remember: check invoices weekly'));

      const log = execSync('git log --oneline -1', { cwd: workDir }).toString();
      assert.ok(log.includes('agent:'));
    } finally {
      fs.rmSync(remoteDir, { recursive: true });
      fs.rmSync(workDir, { recursive: true });
    }
  });
});

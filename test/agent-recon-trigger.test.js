// Tests for: recon-grade body fetch (Change 1) and fire-and-forget trigger ops (Change 2)

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runAgentReport } from '../src/agent/report.js';
import { AgentDB } from '../src/agent/db.js';
import { SortLogDB } from '../src/sorter/db.js';
import { _setTokenForTesting, setRetryDelays } from '../src/graph.js';
import { _setLLMTransportForTesting } from '../src/agent/llm.js';
import { executeOps } from '../src/agent/ops.js';

// --- Helpers ---

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-cli-recon-'));
}

function writeRules(dir, extra = []) {
  const p = path.join(dir, 'rules.json');
  fs.writeFileSync(p, JSON.stringify({
    guards: ['urgent'],
    settings: { minAgeHours: 6 },
    rules: [
      { id: 'mox-tx', bucket: 'accounting', domains: ['mox.com'], note: 'mox transactions' },
      { id: 'github-notif', bucket: 'notifications', domains: ['github.com'], note: 'github notifications' },
      ...extra
    ]
  }));
  return p;
}

function writeAgentConfig(dir) {
  const p = path.join(dir, 'agent.json');
  fs.writeFileSync(p, JSON.stringify({
    model: 'claude-sonnet-5',
    idleHours: 24, renderDeadlineHours: 8, readBodyCap: 40
  }));
  return p;
}

function writeNotes(dir, content = '# Agent Notes\n---\n') {
  const p = path.join(dir, 'agent-notes.md');
  fs.writeFileSync(p, content);
  return p;
}

function defaultLLMResponse() {
  return {
    message_text: 'Test report message',
    new_questions: [],
    auto_resolved_reminders: [],
    junk_flags: []
  };
}

function opts(tmpDir, overrides = {}) {
  return {
    _agentDbPath: path.join(tmpDir, 'agent.db'),
    _sortDbPath: path.join(tmpDir, 'transactions.db'),
    _notesPath: path.join(tmpDir, 'agent-notes.md'),
    _outboxDir: path.join(tmpDir, 'outbox'),
    _rulesPath: path.join(tmpDir, 'rules.json'),
    _agentConfigPath: path.join(tmpDir, 'agent.json'),
    _queueDir: path.join(tmpDir, 'llm-queue'),
    _now: '2026-07-18T08:30:00Z',
    ...overrides
  };
}

// Graph mock for folder-based read sweep
function setupFolderMock({ folders = [], folderMessages = {}, moveCalls = [], bodyResponses = {} } = {}) {
  globalThis.fetch = async (url, fetchOpts) => {
    if (fetchOpts?.method === 'POST' && url.includes('/move')) {
      moveCalls.push(url);
      return { ok: true, status: 200, json: async () => ({ id: 'moved-new' }) };
    }
    const bodyMatch = url.match(/\/me\/messages\/([^?/]+)\?.*\$select=body/);
    if (bodyMatch && bodyResponses[bodyMatch[1]]) {
      return { ok: true, status: 200, json: async () => bodyResponses[bodyMatch[1]] };
    }
    if (bodyMatch) {
      return { ok: true, status: 200, json: async () => ({ body: { content: 'default body', contentType: 'text' } }) };
    }
    const wkMatch = url.match(/\/me\/mailFolders\/(sentitems|deleteditems|drafts|outbox|junkemail)\b/);
    if (wkMatch && !url.includes('/messages')) {
      return { ok: true, status: 200, json: async () => ({ id: `folder-${wkMatch[1]}`, displayName: wkMatch[1] }) };
    }
    if (url.includes('/me/mailFolders') && url.includes('$top') && !url.includes('/messages')) {
      return { ok: true, status: 200, json: async () => ({ value: folders }) };
    }
    for (const [folderId, msgs] of Object.entries(folderMessages)) {
      if (url.includes(`/me/mailFolders/${folderId}/messages`)) {
        return { ok: true, status: 200, json: async () => ({ value: msgs }) };
      }
    }
    return { ok: true, status: 200, json: async () => ({ value: [] }) };
  };
}

// --- Change 1: Body fetch ---

describe('body fetch (recon-grade reports)', () => {
  let tmpDir, originalFetch;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    writeRules(tmpDir);
    writeAgentConfig(tmpDir);
    writeNotes(tmpDir);
    originalFetch = globalThis.fetch;
    _setTokenForTesting('fake-token');
    setRetryDelays([0, 0]);
    _setLLMTransportForTesting(async () => defaultLLMResponse());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTokenForTesting(null);
    setRetryDelays([2000, 8000]);
    _setLLMTransportForTesting(null);
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('body_excerpt attached to unruled inbox emails', async () => {
    setupFolderMock({
      folders: [{ id: 'inbox-id', displayName: 'Inbox' }],
      folderMessages: {
        'inbox-id': [
          { id: 'kept-001', subject: 'Invoice #123', from: { emailAddress: { address: 'hello@random.com' } }, receivedDateTime: '2026-07-17T09:00:00Z', internetMessageId: 'inet-k1' },
        ]
      },
      bodyResponses: {
        'kept-001': { body: { contentType: 'text', content: 'Payment of $500 due by 2026-08-01' }, subject: 'Invoice #123' }
      }
    });

    await runAgentReport(opts(tmpDir));
    const db = new AgentDB(path.join(tmpDir, 'agent.db'));
    const rj = JSON.parse(db.openPendings()[0].report_json);
    const email = rj.emails.find(e => e.id === 'kept-001');
    assert.ok(email, 'email should exist');
    assert.strictEqual(email.body_excerpt, 'Payment of $500 due by 2026-08-01');
    db.close();
  });

  test('body_excerpt attached to junk pending items', async () => {
    setupFolderMock({
      folders: [{ id: 'folder-junkemail', displayName: 'Junk Email' }],
      folderMessages: {
        'folder-junkemail': [
          { id: 'j-pending-1', subject: 'Urgent offer', from: { emailAddress: { address: 'spam@unknown.com' } }, receivedDateTime: '2026-07-18T06:00:00Z', internetMessageId: 'inet-jp1' },
        ]
      },
      bodyResponses: {
        'j-pending-1': { body: { contentType: 'text', content: 'Claim your $1M prize now!' }, subject: 'Urgent offer' }
      }
    });

    await runAgentReport(opts(tmpDir));
    const db = new AgentDB(path.join(tmpDir, 'agent.db'));
    const rj = JSON.parse(db.openPendings()[0].report_json);
    const email = rj.emails.find(e => e.id === 'j-pending-1');
    assert.ok(email);
    assert.strictEqual(email.body_excerpt, 'Claim your $1M prize now!');
    // Also in compat junk array
    const jItem = rj.junk.find(j => j.id === 'j-pending-1');
    assert.ok(jItem);
    assert.strictEqual(jItem.flag, 'pending');
    db.close();
  });

  test('HTML stripped from body content', async () => {
    setupFolderMock({
      folders: [{ id: 'inbox-id', displayName: 'Inbox' }],
      folderMessages: {
        'inbox-id': [
          { id: 'html-001', subject: 'HTML email', from: { emailAddress: { address: 'info@random.com' } }, receivedDateTime: '2026-07-17T09:00:00Z', internetMessageId: 'inet-h1' },
        ]
      },
      bodyResponses: {
        'html-001': { body: { contentType: 'html', content: '<div><p>Your balance is <b>$1,234.56</b></p>&nbsp;&amp; more</div>' }, subject: 'HTML email' }
      }
    });

    await runAgentReport(opts(tmpDir));
    const db = new AgentDB(path.join(tmpDir, 'agent.db'));
    const rj = JSON.parse(db.openPendings()[0].report_json);
    const email = rj.emails.find(e => e.id === 'html-001');
    assert.strictEqual(email.body_excerpt, 'Your balance is $1,234.56 & more');
    db.close();
  });

  test('body truncated to 1200 chars', async () => {
    const longBody = 'A'.repeat(2000);
    setupFolderMock({
      folders: [{ id: 'inbox-id', displayName: 'Inbox' }],
      folderMessages: {
        'inbox-id': [
          { id: 'long-001', subject: 'Long email', from: { emailAddress: { address: 'info@random.com' } }, receivedDateTime: '2026-07-17T09:00:00Z', internetMessageId: 'inet-l1' },
        ]
      },
      bodyResponses: {
        'long-001': { body: { contentType: 'text', content: longBody }, subject: 'Long email' }
      }
    });

    await runAgentReport(opts(tmpDir));
    const db = new AgentDB(path.join(tmpDir, 'agent.db'));
    const rj = JSON.parse(db.openPendings()[0].report_json);
    const email = rj.emails.find(e => e.id === 'long-001');
    assert.strictEqual(email.body_excerpt.length, 1200);
    db.close();
  });

  test('cap honored, sets bodyOverflow', async () => {
    // Create 5 emails with readBodyCap=3
    const msgs = [];
    for (let i = 0; i < 5; i++) {
      msgs.push({
        id: `cap-${i}`, subject: `Email ${i}`,
        from: { emailAddress: { address: `user${i}@random.com` } },
        receivedDateTime: `2026-07-17T09:${i.toString().padStart(2, '0')}:00Z`,
        internetMessageId: `inet-cap-${i}`
      });
    }

    setupFolderMock({
      folders: [{ id: 'inbox-id', displayName: 'Inbox' }],
      folderMessages: { 'inbox-id': msgs }
    });

    const cfgPath = path.join(tmpDir, 'agent.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ model: 'claude-sonnet-5', readBodyCap: 3 }));

    await runAgentReport(opts(tmpDir));
    const db = new AgentDB(path.join(tmpDir, 'agent.db'));
    const rj = JSON.parse(db.openPendings()[0].report_json);
    assert.strictEqual(rj.bodyOverflow, 2);
    const withBody = rj.emails.filter(e => e.body_excerpt);
    assert.strictEqual(withBody.length, 3);
    db.close();
  });

  test('fetch error skips item without crashing', async () => {
    const bodyResponses = {
      'ok-001': { body: { contentType: 'text', content: 'OK body content' }, subject: 'OK email' },
    };
    setupFolderMock({
      folders: [{ id: 'inbox-id', displayName: 'Inbox' }],
      folderMessages: {
        'inbox-id': [
          { id: 'err-001', subject: 'Error email', from: { emailAddress: { address: 'info@random.com' } }, receivedDateTime: '2026-07-17T09:00:00Z', internetMessageId: 'inet-e1' },
          { id: 'ok-001', subject: 'OK email', from: { emailAddress: { address: 'info2@random.com' } }, receivedDateTime: '2026-07-17T09:30:00Z', internetMessageId: 'inet-o1' },
        ]
      },
    });
    // Override fetch to make err-001 body fetch throw
    const baseFetch = globalThis.fetch;
    globalThis.fetch = async (url, fetchOpts) => {
      const bodyMatch = url.match(/\/me\/messages\/([^?/]+)\?.*\$select=body/);
      if (bodyMatch && bodyMatch[1] === 'err-001') {
        throw new Error('Graph API timeout');
      }
      if (bodyMatch && bodyMatch[1] === 'ok-001') {
        return { ok: true, status: 200, json: async () => bodyResponses['ok-001'] };
      }
      return baseFetch(url, fetchOpts);
    };

    const result = await runAgentReport(opts(tmpDir));
    assert.strictEqual(result.status, 'pending');
    const db = new AgentDB(path.join(tmpDir, 'agent.db'));
    const rj = JSON.parse(db.openPendings()[0].report_json);
    const okEmail = rj.emails.find(e => e.id === 'ok-001');
    const errEmail = rj.emails.find(e => e.id === 'err-001');
    assert.strictEqual(okEmail.body_excerpt, 'OK body content');
    assert.strictEqual(errEmail.body_excerpt, undefined);
    db.close();
  });

  test('dry mode still fetches bodies (read-only)', async () => {
    let bodyFetched = false;
    let anyPostCalled = false;
    setupFolderMock({
      folders: [{ id: 'inbox-id', displayName: 'Inbox' }],
      folderMessages: {
        'inbox-id': [
          { id: 'dry-001', subject: 'Dry email', from: { emailAddress: { address: 'info@random.com' } }, receivedDateTime: '2026-07-17T09:00:00Z', internetMessageId: 'inet-d1' },
        ]
      },
    });
    const baseFetch = globalThis.fetch;
    globalThis.fetch = async (url, fetchOpts) => {
      if (fetchOpts?.method === 'POST') {
        anyPostCalled = true;
        return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
      }
      const bodyMatch = url.match(/\/me\/messages\/([^?/]+)\?.*\$select=body/);
      if (bodyMatch && bodyMatch[1] === 'dry-001') {
        bodyFetched = true;
        return { ok: true, status: 200, json: async () => ({ body: { contentType: 'text', content: 'Dry body text' }, subject: 'Dry email' }) };
      }
      return baseFetch(url, fetchOpts);
    };

    const result = await runAgentReport(opts(tmpDir, { dry: true }));
    assert.ok(bodyFetched, 'body should be fetched in dry mode');
    assert.ok(!anyPostCalled, 'no writes should happen in dry mode');
    assert.strictEqual(result.status, 'ok');
  });
});

// --- Body excerpt in LLM prompt ---

describe('LLM prompt includes body_excerpt', () => {
  let tmpDir, originalFetch;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    writeRules(tmpDir);
    writeAgentConfig(tmpDir);
    writeNotes(tmpDir);
    originalFetch = globalThis.fetch;
    _setTokenForTesting('fake-token');
    setRetryDelays([0, 0]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTokenForTesting(null);
    setRetryDelays([2000, 8000]);
    _setLLMTransportForTesting(null);
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('renderReport user payload includes body_excerpt content', async () => {
    setupFolderMock({
      folders: [{ id: 'inbox-id', displayName: 'Inbox' }],
      folderMessages: {
        'inbox-id': [
          { id: 'prompt-001', subject: 'Payment due', from: { emailAddress: { address: 'info@random.com' } }, receivedDateTime: '2026-07-17T09:00:00Z', internetMessageId: 'inet-p1' },
        ]
      },
      bodyResponses: {
        'prompt-001': { body: { contentType: 'text', content: 'Please pay HKD 3,000 by July 25th' }, subject: 'Payment due' }
      }
    });

    const result = await runAgentReport(opts(tmpDir));
    assert.strictEqual(result.status, 'pending');

    const db = new AgentDB(path.join(tmpDir, 'agent.db'));
    const rj = JSON.parse(db.openPendings()[0].report_json);
    const emailsWithBody = rj.emails.filter(e => e.body_excerpt);
    assert.ok(emailsWithBody.length > 0, 'at least one email should have body_excerpt');
    assert.ok(emailsWithBody[0].body_excerpt.includes('Please pay HKD 3,000 by July 25th'));
    db.close();
  });
});

// --- Change 2: Fire-and-forget trigger ops ---

describe('fire-and-forget trigger ops', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  function makeDeps(overrides = {}) {
    const agentDb = new AgentDB(path.join(tmpDir, 'agent.db'));
    return {
      rulesPath: path.join(tmpDir, 'rules.json'),
      notesPath: path.join(tmpDir, 'agent-notes.md'),
      sortDbPath: path.join(tmpDir, 'transactions.db'),
      agentDb,
      git: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      graphGet: async () => ({ id: 'inbox-id', value: [] }),
      graphPost: async () => ({ id: 'new-id' }),
      runReport: overrides.runReport ?? (async () => ({})),
      runAudit: overrides.runAudit ?? (async () => ({})),
      drainOutbox: overrides.drainOutbox ?? (async () => ({})),
      send: overrides.send ?? (async () => {}),
      model: 'test-model',
      getNow: () => '2026-07-18T10:00:00Z',
      userText: 'test',
      _agentDb: agentDb,
    };
  }

  test('trigger_report returns ack without awaiting report completion', async () => {
    let reportResolved = false;
    let resolveReport;
    const reportPromise = new Promise(r => { resolveReport = r; });
    const deps = makeDeps({
      runReport: () => reportPromise.then(() => { reportResolved = true; }),
    });

    const results = await executeOps([{ type: 'trigger_report' }], deps);
    deps._agentDb.close();

    assert.ok(results[0].includes('收到'));
    assert.strictEqual(reportResolved, false);

    resolveReport();
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(reportResolved, true);
  });

  test('trigger_audit returns ack without awaiting audit completion', async () => {
    let auditResolved = false;
    let resolveAudit;
    const auditPromise = new Promise(r => { resolveAudit = r; });
    const deps = makeDeps({
      runAudit: () => auditPromise.then(() => { auditResolved = true; }),
    });

    const results = await executeOps([{ type: 'trigger_audit' }], deps);
    deps._agentDb.close();

    assert.ok(results[0].includes('收到'));
    assert.strictEqual(auditResolved, false);

    resolveAudit();
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(auditResolved, true);
  });

  test('trigger_report error writes to outbox', async () => {
    const outboxDir = path.join(tmpDir, 'outbox');
    const deps = makeDeps({
      runReport: async () => { throw new Error('Graph API down'); },
    });
    deps.outboxDir = outboxDir;

    const results = await executeOps([{ type: 'trigger_report' }], deps);
    deps._agentDb.close();

    assert.ok(results[0].includes('收到'));
    await new Promise(r => setTimeout(r, 50));
    assert.ok(fs.existsSync(outboxDir), 'outbox dir should exist');
    const files = fs.readdirSync(outboxDir);
    assert.ok(files.length > 0, 'outbox should have a file');
    const msg = JSON.parse(fs.readFileSync(path.join(outboxDir, files[0]), 'utf8'));
    assert.ok(msg.text.includes('Graph API down'));
  });

  test('trigger_audit error calls send with error message', async () => {
    let sentError = null;
    const deps = makeDeps({
      runAudit: async () => { throw new Error('DB locked'); },
      send: async (text) => { sentError = text; },
    });

    const results = await executeOps([{ type: 'trigger_audit' }], deps);
    deps._agentDb.close();

    assert.ok(results[0].includes('收到'));
    await new Promise(r => setTimeout(r, 10));
    assert.ok(sentError, 'error should have been sent');
    assert.ok(sentError.includes('DB locked'));
  });

  test('poll loop not blocked: second message processed while report pending', async () => {
    let resolveReport;
    const reportPromise = new Promise(r => { resolveReport = r; });
    let reportStarted = false;

    const deps = makeDeps({
      runReport: () => {
        reportStarted = true;
        return reportPromise;
      },
    });

    const results1 = await executeOps([{ type: 'trigger_report' }], deps);
    assert.ok(results1[0].includes('收到'));
    assert.ok(reportStarted, 'report should have been kicked off');

    const results2 = await executeOps([{ type: 'note_add', text: 'immediate note' }], {
      ...deps,
      notesPath: path.join(tmpDir, 'agent-notes.md'),
    });
    assert.strictEqual(results2.length, 1);

    resolveReport();
    await new Promise(r => setTimeout(r, 10));
    deps._agentDb.close();
  });

  test('drainOutbox called after successful report', async () => {
    let drainCalled = false;
    const deps = makeDeps({
      runReport: async () => ({}),
      drainOutbox: async () => { drainCalled = true; },
    });

    await executeOps([{ type: 'trigger_report' }], deps);
    deps._agentDb.close();

    await new Promise(r => setTimeout(r, 10));
    assert.ok(drainCalled, 'drainOutbox should be called after report');
  });

  test('send failure in error handler does not crash (best-effort)', async () => {
    const deps = makeDeps({
      runReport: async () => { throw new Error('fail'); },
      send: async () => { throw new Error('Telegram down too'); },
    });

    await executeOps([{ type: 'trigger_report' }], deps);
    deps._agentDb.close();

    await new Promise(r => setTimeout(r, 10));
  });
});

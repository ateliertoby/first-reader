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
  fs.writeFileSync(p, JSON.stringify({ model: 'claude-sonnet-5' }));
  return p;
}

function writeSortState(dir, processedThrough) {
  const p = path.join(dir, 'sort-state.json');
  fs.writeFileSync(p, JSON.stringify({ processedThrough }));
  return p;
}

function writeNotes(dir, content = '# Agent Notes\n---\n') {
  const p = path.join(dir, 'agent-notes.md');
  fs.writeFileSync(p, content);
  return p;
}

function insertSortRows(dbPath, rows) {
  const logDb = new SortLogDB(dbPath);
  for (const r of rows) logDb.insert(r);
  logDb.close();
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
    _statePath: path.join(tmpDir, 'sort-state.json'),
    _notesPath: path.join(tmpDir, 'agent-notes.md'),
    _outboxDir: path.join(tmpDir, 'outbox'),
    _rulesPath: path.join(tmpDir, 'rules.json'),
    _agentConfigPath: path.join(tmpDir, 'agent.json'),
    _now: '2026-07-18T08:30:00Z',
    ...overrides
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

  test('body_excerpt attached to kept rows', async () => {
    writeSortState(tmpDir, '2026-07-18T08:00:00Z');
    insertSortRows(path.join(tmpDir, 'transactions.db'), [
      {
        run_at: '2026-07-17T10:00:00Z', email_id: 'kept-001',
        sender: 'hello@random.com', domain: 'random.com',
        subject: 'Invoice #123', subject_key: 'invoice #',
        received_at: '2026-07-17T09:00:00Z', bucket: null,
        rule_id: null, action: 'kept', parsed: null
      }
    ]);

    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/me/messages/kept-001')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            body: { contentType: 'text', content: 'Payment of $500 due by 2026-08-01' },
            subject: 'Invoice #123'
          })
        };
      }
      if (url.includes('junkemail')) {
        return { ok: true, status: 200, json: async () => ({ value: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ value: [] }) };
    };

    const result = await runAgentReport(opts(tmpDir));
    const keptGroup = result.reportJson.sort.kept[0];
    assert.ok(keptGroup, 'kept group should exist');
    const sample = keptGroup.samples[0];
    assert.strictEqual(sample.body_excerpt, 'Payment of $500 due by 2026-08-01');
  });

  test('body_excerpt attached to noparse rows', async () => {
    writeSortState(tmpDir, '2026-07-18T08:00:00Z');
    insertSortRows(path.join(tmpDir, 'transactions.db'), [
      {
        run_at: '2026-07-17T10:00:00Z', email_id: 'np-001',
        sender: 'alert@mox.com', domain: 'mox.com',
        subject: 'Transaction alert', subject_key: 'transaction alert',
        received_at: '2026-07-17T09:00:00Z', bucket: 'accounting',
        rule_id: 'mox-tx', action: 'moved', parsed: 0
      }
    ]);

    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/me/messages/np-001')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            body: { contentType: 'text', content: 'You received HKD 2,500.00 from John' },
            subject: 'Transaction alert'
          })
        };
      }
      if (url.includes('junkemail')) {
        return { ok: true, status: 200, json: async () => ({ value: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ value: [] }) };
    };

    const result = await runAgentReport(opts(tmpDir));
    const npRow = result.reportJson.sort.noparse[0];
    assert.strictEqual(npRow.body_excerpt, 'You received HKD 2,500.00 from John');
  });

  test('body_excerpt attached to junk pending items', async () => {
    writeSortState(tmpDir, '2026-07-18T08:00:00Z');
    const junkMsg = {
      id: 'j-pending-1', subject: 'Urgent offer',
      from: { emailAddress: { address: 'spam@unknown.com' } },
      receivedDateTime: '2026-07-18T06:00:00Z'
    };

    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, fetchOpts) => {
      if (url.includes('junkemail/messages') && !url.includes('/me/messages/j-pending-1')) {
        return { ok: true, status: 200, json: async () => ({ value: [junkMsg] }) };
      }
      if (url.includes('/me/messages/j-pending-1')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            body: { contentType: 'text', content: 'Claim your $1M prize now!' },
            subject: 'Urgent offer'
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({ value: [] }) };
    };

    const result = await runAgentReport(opts(tmpDir));
    const junkItem = result.reportJson.junk.find(j => j.id === 'j-pending-1');
    assert.ok(junkItem);
    assert.strictEqual(junkItem.body_excerpt, 'Claim your $1M prize now!');
  });

  test('HTML stripped from body content', async () => {
    writeSortState(tmpDir, '2026-07-18T08:00:00Z');
    insertSortRows(path.join(tmpDir, 'transactions.db'), [
      {
        run_at: '2026-07-17T10:00:00Z', email_id: 'html-001',
        sender: 'info@random.com', domain: 'random.com',
        subject: 'HTML email', subject_key: 'html email',
        received_at: '2026-07-17T09:00:00Z', bucket: null,
        rule_id: null, action: 'kept', parsed: null
      }
    ]);

    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/me/messages/html-001')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            body: {
              contentType: 'html',
              content: '<div><p>Your balance is <b>$1,234.56</b></p>&nbsp;&amp; more</div>'
            },
            subject: 'HTML email'
          })
        };
      }
      if (url.includes('junkemail')) {
        return { ok: true, status: 200, json: async () => ({ value: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ value: [] }) };
    };

    const result = await runAgentReport(opts(tmpDir));
    const sample = result.reportJson.sort.kept[0].samples[0];
    assert.strictEqual(sample.body_excerpt, 'Your balance is $1,234.56 & more');
  });

  test('body truncated to 1200 chars', async () => {
    writeSortState(tmpDir, '2026-07-18T08:00:00Z');
    insertSortRows(path.join(tmpDir, 'transactions.db'), [
      {
        run_at: '2026-07-17T10:00:00Z', email_id: 'long-001',
        sender: 'info@random.com', domain: 'random.com',
        subject: 'Long email', subject_key: 'long email',
        received_at: '2026-07-17T09:00:00Z', bucket: null,
        rule_id: null, action: 'kept', parsed: null
      }
    ]);

    const longBody = 'A'.repeat(2000);
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/me/messages/long-001')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            body: { contentType: 'text', content: longBody },
            subject: 'Long email'
          })
        };
      }
      if (url.includes('junkemail')) {
        return { ok: true, status: 200, json: async () => ({ value: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ value: [] }) };
    };

    const result = await runAgentReport(opts(tmpDir));
    const sample = result.reportJson.sort.kept[0].samples[0];
    assert.strictEqual(sample.body_excerpt.length, 1200);
  });

  test('cap at 25 bodies, sets bodiesTruncated', async () => {
    writeSortState(tmpDir, '2026-07-18T08:00:00Z');
    // Insert 30 kept rows
    const rows = [];
    for (let i = 0; i < 30; i++) {
      rows.push({
        run_at: '2026-07-17T10:00:00Z', email_id: `cap-${i.toString().padStart(3, '0')}`,
        sender: `user${i}@random.com`, domain: 'random.com',
        subject: `Email ${i}`, subject_key: `email ${i}`,
        received_at: `2026-07-17T09:${i.toString().padStart(2, '0')}:00Z`, bucket: null,
        rule_id: null, action: 'kept', parsed: null
      });
    }
    insertSortRows(path.join(tmpDir, 'transactions.db'), rows);

    const fetchedIds = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const match = url.match(/messages\/(cap-\d+)/);
      if (match) {
        fetchedIds.push(match[1]);
        return {
          ok: true, status: 200,
          json: async () => ({
            body: { contentType: 'text', content: `Body of ${match[1]}` },
            subject: 'test'
          })
        };
      }
      if (url.includes('junkemail')) {
        return { ok: true, status: 200, json: async () => ({ value: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ value: [] }) };
    };

    const result = await runAgentReport(opts(tmpDir));
    // Only 25 fetches made (cap honored)
    assert.strictEqual(fetchedIds.length, 25);
    // bodiesTruncated reports count of skipped items
    assert.strictEqual(result.reportJson.bodiesTruncated, 5);
  });

  test('fetch error skips item without crashing', async () => {
    writeSortState(tmpDir, '2026-07-18T08:00:00Z');
    insertSortRows(path.join(tmpDir, 'transactions.db'), [
      {
        run_at: '2026-07-17T10:00:00Z', email_id: 'err-001',
        sender: 'info@random.com', domain: 'random.com',
        subject: 'Error email', subject_key: 'error email',
        received_at: '2026-07-17T09:00:00Z', bucket: null,
        rule_id: null, action: 'kept', parsed: null
      },
      {
        run_at: '2026-07-17T10:00:00Z', email_id: 'ok-001',
        sender: 'info2@random.com', domain: 'random.com',
        subject: 'OK email', subject_key: 'ok email',
        received_at: '2026-07-17T09:30:00Z', bucket: null,
        rule_id: null, action: 'kept', parsed: null
      }
    ]);

    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/me/messages/err-001')) {
        throw new Error('Graph API timeout');
      }
      if (url.includes('/me/messages/ok-001')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            body: { contentType: 'text', content: 'OK body content' },
            subject: 'OK email'
          })
        };
      }
      if (url.includes('junkemail')) {
        return { ok: true, status: 200, json: async () => ({ value: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ value: [] }) };
    };

    const result = await runAgentReport(opts(tmpDir));
    assert.strictEqual(result.status, 'ok');
    // The errored item has no body_excerpt; the OK one does
    const samples = result.reportJson.sort.kept[0].samples;
    const okSample = samples.find(s => s.subject === 'OK email');
    const errSample = samples.find(s => s.subject === 'Error email');
    assert.strictEqual(okSample.body_excerpt, 'OK body content');
    assert.strictEqual(errSample.body_excerpt, undefined);
  });

  test('dry mode still fetches bodies (read-only)', async () => {
    writeSortState(tmpDir, '2026-07-18T08:00:00Z');
    insertSortRows(path.join(tmpDir, 'transactions.db'), [
      {
        run_at: '2026-07-17T10:00:00Z', email_id: 'dry-001',
        sender: 'info@random.com', domain: 'random.com',
        subject: 'Dry email', subject_key: 'dry email',
        received_at: '2026-07-17T09:00:00Z', bucket: null,
        rule_id: null, action: 'kept', parsed: null
      }
    ]);

    let bodyFetched = false;
    let anyPostCalled = false;
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, fetchOpts) => {
      if (fetchOpts?.method === 'POST') {
        anyPostCalled = true;
        return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
      }
      if (url.includes('/me/messages/dry-001')) {
        bodyFetched = true;
        return {
          ok: true, status: 200,
          json: async () => ({
            body: { contentType: 'text', content: 'Dry body text' },
            subject: 'Dry email'
          })
        };
      }
      if (url.includes('junkemail')) {
        return { ok: true, status: 200, json: async () => ({ value: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ value: [] }) };
    };

    const result = await runAgentReport(opts(tmpDir, { dry: true }));
    // Body was fetched (read-only operation)
    assert.ok(bodyFetched, 'body should be fetched in dry mode');
    // No POST calls (no writes in dry mode)
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
    writeSortState(tmpDir, '2026-07-18T08:00:00Z');
    insertSortRows(path.join(tmpDir, 'transactions.db'), [
      {
        run_at: '2026-07-17T10:00:00Z', email_id: 'prompt-001',
        sender: 'info@random.com', domain: 'random.com',
        subject: 'Payment due', subject_key: 'payment due',
        received_at: '2026-07-17T09:00:00Z', bucket: null,
        rule_id: null, action: 'kept', parsed: null
      }
    ]);

    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/me/messages/prompt-001')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            body: { contentType: 'text', content: 'Please pay HKD 3,000 by July 25th' },
            subject: 'Payment due'
          })
        };
      }
      if (url.includes('junkemail')) {
        return { ok: true, status: 200, json: async () => ({ value: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ value: [] }) };
    };

    // Capture what the transport receives
    let capturedUser = null;
    _setLLMTransportForTesting(async ({ user }) => {
      capturedUser = user;
      return defaultLLMResponse();
    });

    await runAgentReport(opts(tmpDir));
    assert.ok(capturedUser, 'transport should have been called');
    assert.ok(capturedUser.includes('body_excerpt'), 'user payload should contain body_excerpt key');
    assert.ok(capturedUser.includes('Please pay HKD 3,000 by July 25th'), 'user payload should contain body text');
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

    // Ack returned immediately — report has NOT completed yet
    assert.ok(results[0].includes('收到'));
    assert.strictEqual(reportResolved, false);

    // Now resolve the report
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

    // Ack returned immediately — audit has NOT completed yet
    assert.ok(results[0].includes('收到'));
    assert.strictEqual(auditResolved, false);

    resolveAudit();
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(auditResolved, true);
  });

  test('trigger_report error calls send with error message', async () => {
    let sentError = null;
    const deps = makeDeps({
      runReport: async () => { throw new Error('Graph API down'); },
      send: async (text) => { sentError = text; },
    });

    const results = await executeOps([{ type: 'trigger_report' }], deps);
    deps._agentDb.close();

    assert.ok(results[0].includes('收到'));
    // Wait for the fire-and-forget chain to complete
    await new Promise(r => setTimeout(r, 10));
    assert.ok(sentError, 'error should have been sent');
    assert.ok(sentError.includes('Graph API down'));
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
    // Simulate what happens in the loop: handler returns ack immediately,
    // loop processes next message without waiting for report to finish.
    let resolveReport;
    const reportPromise = new Promise(r => { resolveReport = r; });
    let reportStarted = false;

    const deps = makeDeps({
      runReport: () => {
        reportStarted = true;
        return reportPromise;
      },
    });

    // First message triggers report
    const results1 = await executeOps([{ type: 'trigger_report' }], deps);
    assert.ok(results1[0].includes('收到'));
    assert.ok(reportStarted, 'report should have been kicked off');

    // Second op can execute immediately — loop is not blocked
    const results2 = await executeOps([{ type: 'note_add', text: 'immediate note' }], {
      ...deps,
      notesPath: path.join(tmpDir, 'agent-notes.md'),
    });
    // note_add would fail due to no file/git but that's fine — the point is it ran immediately
    assert.strictEqual(results2.length, 1);

    // Cleanup
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

    // Wait for background chain
    await new Promise(r => setTimeout(r, 10));
    assert.ok(drainCalled, 'drainOutbox should be called after report');
  });

  test('send failure in error handler does not crash (best-effort)', async () => {
    const deps = makeDeps({
      runReport: async () => { throw new Error('fail'); },
      send: async () => { throw new Error('Telegram down too'); },
    });

    // This should not throw
    await executeOps([{ type: 'trigger_report' }], deps);
    deps._agentDb.close();

    // Wait for background chain to complete without crash
    await new Promise(r => setTimeout(r, 10));
    // If we get here without unhandled rejection, test passes
  });
});

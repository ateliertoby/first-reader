import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runAgentReport, buildDegradedMessage } from '../src/agent/report.js';
import { AgentDB } from '../src/agent/db.js';
import { SortLogDB } from '../src/sorter/db.js';
import { _setTokenForTesting, setRetryDelays } from '../src/graph.js';
import { _setLLMTransportForTesting } from '../src/agent/llm.js';

// --- Test helpers ---

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-cli-agent-report-'));
}

function writeRules(dir, extra = []) {
  const p = path.join(dir, 'rules.json');
  fs.writeFileSync(p, JSON.stringify({
    guards: ['urgent'],
    settings: { minAgeHours: 6 },
    rules: [
      { id: 'mox-tx', bucket: 'accounting', domains: ['mox.com'], note: 'mox transactions' },
      { id: 'github-notif', bucket: 'notifications', domains: ['github.com'], note: 'github notifications' },
      { id: 'hketoll-reminder', bucket: 'notifications', domains: ['govhk.com'], note: 'reminder-class: toll payment' },
      { id: 'keep-test', bucket: 'keep', domains: ['important.com'], note: 'keep in inbox' },
      ...extra
    ]
  }));
  return p;
}

function writeAgentConfig(dir) {
  const p = path.join(dir, 'agent.json');
  fs.writeFileSync(p, JSON.stringify({
    model: 'claude-sonnet-5',
    idleHours: 24, renderDeadlineHours: 8, freshLookbackHours: 12
  }));
  return p;
}

function writeSortState(dir, processedThrough) {
  const p = path.join(dir, 'sort-state.json');
  fs.writeFileSync(p, JSON.stringify({ processedThrough }));
  return p;
}

function writeNotes(dir, content) {
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

// Standard options builder for runAgentReport
function opts(tmpDir, overrides = {}) {
  return {
    _agentDbPath: path.join(tmpDir, 'agent.db'),
    _sortDbPath: path.join(tmpDir, 'transactions.db'),
    _statePath: path.join(tmpDir, 'sort-state.json'),
    _notesPath: path.join(tmpDir, 'agent-notes.md'),
    _outboxDir: path.join(tmpDir, 'outbox'),
    _rulesPath: path.join(tmpDir, 'rules.json'),
    _agentConfigPath: path.join(tmpDir, 'agent.json'),
    _queueDir: path.join(tmpDir, 'llm-queue'),
    _now: '2026-07-18T08:30:00Z',
    ...overrides
  };
}

describe('runAgentReport', () => {
  let tmpDir, originalFetch;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    writeRules(tmpDir);
    writeAgentConfig(tmpDir);
    writeNotes(tmpDir, '# Agent Notes\n---\n');

    // Graph API mock
    originalFetch = globalThis.fetch;
    _setTokenForTesting('fake-token');
    setRetryDelays([0, 0]);
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ value: [] })
    });

    // LLM mock (only used for dry mode now)
    _setLLMTransportForTesting(async () => defaultLLMResponse());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTokenForTesting(null);
    setRetryDelays([2000, 8000]);
    _setLLMTransportForTesting(null);
    fs.rmSync(tmpDir, { recursive: true });
  });

  // --- Window computation ---

  describe('window computation', () => {
    test('normal chain: uses lastRun window_end as start, returns pending', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      // Seed a previous report run
      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      db.logRun({
        run_at: '2026-07-17T08:30:00Z', kind: 'report',
        window_start: '2026-07-16T08:00:00Z', window_end: '2026-07-17T08:00:00Z',
        status: 'ok', detail: null
      });
      db.close();

      const result = await runAgentReport(opts(tmpDir));
      assert.strictEqual(result.status, 'pending');
      assert.ok(result.requestId);

      // Verify pending_renders row
      const db2 = new AgentDB(path.join(tmpDir, 'agent.db'));
      const pendings = db2.openPendings();
      assert.strictEqual(pendings.length, 1);
      assert.strictEqual(pendings[0].window_start, '2026-07-17T08:00:00Z');
      assert.strictEqual(pendings[0].window_end, '2026-07-18T08:15:00.000Z');
      assert.strictEqual(pendings[0].origin, 'check');
      db2.close();
    });

    test('first run: now minus 24h, returns pending', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');

      const result = await runAgentReport(opts(tmpDir));
      assert.strictEqual(result.status, 'pending');

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const pendings = db.openPendings();
      assert.strictEqual(pendings.length, 1);
      assert.strictEqual(pendings[0].window_start, '2026-07-17T08:30:00.000Z');
      db.close();
    });

    test('missing state file returns degraded with outbox message', async () => {
      // No sort-state.json written
      const o = opts(tmpDir);
      const result = await runAgentReport(o);
      assert.strictEqual(result.status, 'degraded');
      assert.ok(result.reason.includes('sort has never run'));

      // Outbox message written (zero silent path)
      const outboxFiles = fs.readdirSync(o._outboxDir);
      assert.strictEqual(outboxFiles.length, 1);
      const msg = JSON.parse(fs.readFileSync(path.join(o._outboxDir, outboxFiles[0]), 'utf8'));
      assert.ok(msg.text.includes('[degraded]'));
    });
  });

  // --- Single-open rule ---

  describe('single-open rule', () => {
    test('rejects new assemble when open pending exists', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');

      // First call creates a pending
      const r1 = await runAgentReport(opts(tmpDir));
      assert.strictEqual(r1.status, 'pending');

      // Second call should hit single-open rule
      const r2 = await runAgentReport(opts(tmpDir));
      assert.strictEqual(r2.status, 'single-open');

      // Outbox has the "already building" message
      const outboxFiles = fs.readdirSync(path.join(tmpDir, 'outbox'));
      assert.ok(outboxFiles.length >= 1);
    });
  });

  // --- Reminders ---

  describe('reminders', () => {
    test('creates reminders for reminder-class rules only', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      insertSortRows(path.join(tmpDir, 'transactions.db'), [
        {
          run_at: '2026-07-17T10:00:00Z', email_id: 'toll-001',
          sender: 'noreply@govhk.com', domain: 'govhk.com',
          subject: 'Toll payment due', subject_key: 'toll payment due',
          received_at: '2026-07-17T09:00:00Z', bucket: 'notifications',
          rule_id: 'hketoll-reminder', action: 'moved', parsed: null
        },
        {
          run_at: '2026-07-17T10:00:00Z', email_id: 'gh-001',
          sender: 'noreply@github.com', domain: 'github.com',
          subject: 'PR merged', subject_key: 'pr merged',
          received_at: '2026-07-17T09:00:00Z', bucket: 'notifications',
          rule_id: 'github-notif', action: 'moved', parsed: null
        }
      ]);

      await runAgentReport(opts(tmpDir));

      // Verify: only the toll reminder was created
      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const reminders = db.openReminders();
      assert.strictEqual(reminders.length, 1);
      assert.strictEqual(reminders[0].kind, 'hketoll-reminder');
      assert.strictEqual(reminders[0].source_email_id, 'toll-001');
      db.close();
    });

    test('deduplicates reminders on re-run', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      insertSortRows(path.join(tmpDir, 'transactions.db'), [
        {
          run_at: '2026-07-17T10:00:00Z', email_id: 'toll-001',
          sender: 'noreply@govhk.com', domain: 'govhk.com',
          subject: 'Toll payment due', subject_key: 'toll payment due',
          received_at: '2026-07-17T09:00:00Z', bucket: 'notifications',
          rule_id: 'hketoll-reminder', action: 'moved', parsed: null
        }
      ]);

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      db.addReminder({ kind: 'hketoll-reminder', source_email_id: 'toll-001', subject: 'dup', now: '2026-07-18T09:00:00Z' });
      const reminders = db.openReminders();
      assert.strictEqual(reminders.length, 1);
      db.close();
    });
  });

  // --- Junk patrol ---

  describe('junk patrol', () => {
    const junkMessages = [
      { id: 'j-mox', subject: 'Mox transaction', from: { emailAddress: { address: 'noreply@mox.com' } }, receivedDateTime: '2026-07-18T06:00:00Z' },
      { id: 'j-gh', subject: 'PR update', from: { emailAddress: { address: 'noreply@github.com' } }, receivedDateTime: '2026-07-18T06:00:00Z' },
      { id: 'j-guard', subject: 'urgent: GitHub alert', from: { emailAddress: { address: 'noreply@github.com' } }, receivedDateTime: '2026-07-18T06:00:00Z' },
      { id: 'j-unruled', subject: 'Buy now', from: { emailAddress: { address: 'spam@unknown.com' } }, receivedDateTime: '2026-07-18T06:00:00Z' },
      { id: 'j-dismissed', subject: 'Old spam', from: { emailAddress: { address: 'old@spam.com' } }, receivedDateTime: '2026-07-18T06:00:00Z' },
      { id: 'j-keep', subject: 'Important', from: { emailAddress: { address: 'info@important.com' } }, receivedDateTime: '2026-07-18T06:00:00Z' }
    ];

    function setupJunkFetch() {
      const moveCalls = [];
      globalThis.fetch = async (url, fetchOpts) => {
        if (fetchOpts?.method === 'POST' && url.includes('/move')) {
          moveCalls.push(url);
          return { ok: true, status: 200, json: async () => ({ id: 'moved-new' }) };
        }
        if (url.includes('junkemail/messages')) {
          return { ok: true, status: 200, json: async () => ({ value: junkMessages }) };
        }
        return { ok: true, status: 200, json: async () => ({ value: [] }) };
      };
      return moveCalls;
    }

    test('rule-matched unguarded emails are rescued (move called)', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      const moveCalls = setupJunkFetch();
      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      db.dismissJunk('j-dismissed', '2026-07-17T00:00:00Z');
      db.close();

      const result = await runAgentReport(opts(tmpDir));
      assert.strictEqual(result.status, 'pending');

      // j-mox, j-gh, j-keep should all be rescued
      assert.strictEqual(moveCalls.length, 3);
      assert.ok(moveCalls.some(u => u.includes('j-mox')));
      assert.ok(moveCalls.some(u => u.includes('j-gh')));
      assert.ok(moveCalls.some(u => u.includes('j-keep')));
    });

    test('guarded and unruled emails go to pending (in stored report_json)', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      setupJunkFetch();
      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      db.dismissJunk('j-dismissed', '2026-07-17T00:00:00Z');
      db.close();

      await runAgentReport(opts(tmpDir));

      // Check the stored report_json in pending_renders
      const db2 = new AgentDB(path.join(tmpDir, 'agent.db'));
      const pendings = db2.openPendings();
      const reportJson = JSON.parse(pendings[0].report_json);
      const pending = reportJson.junk.filter(j => j.flag === 'pending');
      assert.strictEqual(pending.length, 2);
      const pendingIds = pending.map(j => j.id);
      assert.ok(pendingIds.includes('j-guard'));
      assert.ok(pendingIds.includes('j-unruled'));
      db2.close();
    });
  });

  // --- Dry mode ---

  describe('dry mode', () => {
    test('zero mutations: no outbox, no DB writes, no graph moves', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      const moveCalls = [];
      globalThis.fetch = async (url, fetchOpts) => {
        if (fetchOpts?.method === 'POST') moveCalls.push(url);
        if (url.includes('junkemail/messages')) {
          return {
            ok: true, status: 200,
            json: async () => ({
              value: [
                { id: 'j-mox-dry', subject: 'Mox tx', from: { emailAddress: { address: 'a@mox.com' } }, receivedDateTime: '2026-07-18T06:00:00Z' }
              ]
            })
          };
        }
        return { ok: true, status: 200, json: async () => ({ value: [] }) };
      };

      insertSortRows(path.join(tmpDir, 'transactions.db'), [
        {
          run_at: '2026-07-17T10:00:00Z', email_id: 'toll-dry',
          sender: 'noreply@govhk.com', domain: 'govhk.com',
          subject: 'Toll', subject_key: 'toll',
          received_at: '2026-07-17T09:00:00Z', bucket: 'notifications',
          rule_id: 'hketoll-reminder', action: 'moved', parsed: null
        }
      ]);

      _setLLMTransportForTesting(async () => ({
        message_text: 'Dry report',
        new_questions: [{ domain: 'test', question: 'Q?' }],
        auto_resolved_reminders: [],
        junk_flags: []
      }));

      const o = opts(tmpDir, { dry: true });
      const result = await runAgentReport(o);
      assert.strictEqual(result.status, 'ok');

      // No outbox
      assert.ok(!fs.existsSync(o._outboxDir));

      // No graph moves
      assert.strictEqual(moveCalls.length, 0);

      // No DB mutations: no reminders, no questions, no runs, no pendings
      const db = new AgentDB(o._agentDbPath);
      assert.strictEqual(db.openReminders().length, 0);
      assert.strictEqual(db.openQuestions().length, 0);
      assert.strictEqual(db.lastRun('report'), null);
      assert.strictEqual(db.openPendings().length, 0);
      db.close();
    });

    test('LLM failure in dry mode produces degraded template', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      insertSortRows(path.join(tmpDir, 'transactions.db'), [
        {
          run_at: '2026-07-17T10:00:00Z', email_id: 'gh-d1',
          sender: 'x@github.com', domain: 'github.com',
          subject: 'PR', subject_key: 'pr',
          received_at: '2026-07-17T09:00:00Z', bucket: 'notifications',
          rule_id: 'github-notif', action: 'moved', parsed: null
        }
      ]);

      _setLLMTransportForTesting(async () => { throw new Error('API down'); });

      const result = await runAgentReport(opts(tmpDir, { dry: true }));
      assert.strictEqual(result.status, 'degraded');
      assert.ok(result.message.includes('[degraded]'));
      assert.ok(result.message.includes('sort:'));
    });
  });

  // --- Notes warning (dry mode) ---

  describe('notes warning', () => {
    test('notes >60 lines appends warning to message (dry)', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      const lines = Array(65).fill('line').join('\n');
      writeNotes(tmpDir, lines);

      const result = await runAgentReport(opts(tmpDir, { dry: true }));
      assert.ok(result.message.includes('agent-notes.md 有 65 行，清理時間'));
    });

    test('notes <=60 lines: no warning (dry)', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      writeNotes(tmpDir, Array(60).fill('line').join('\n'));

      const result = await runAgentReport(opts(tmpDir, { dry: true }));
      assert.ok(!result.message.includes('agent-notes.md'));
    });
  });

  // --- Sort section ---

  describe('sort section', () => {
    test('groups moved rows and attaches historicalCount to kept (via pending report_json)', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      const dbPath = path.join(tmpDir, 'transactions.db');
      insertSortRows(dbPath, [
        {
          run_at: '2026-07-17T10:00:00Z', email_id: 'gh-1',
          sender: 'x@github.com', domain: 'github.com',
          subject: 'PR 1', subject_key: 'pr #',
          received_at: '2026-07-17T09:00:00Z', bucket: 'notifications',
          rule_id: 'github-notif', action: 'moved', parsed: null
        },
        {
          run_at: '2026-07-17T10:00:00Z', email_id: 'gh-2',
          sender: 'x@github.com', domain: 'github.com',
          subject: 'PR 2', subject_key: 'pr #',
          received_at: '2026-07-17T09:30:00Z', bucket: 'notifications',
          rule_id: 'github-notif', action: 'moved', parsed: null
        },
        {
          run_at: '2026-07-17T10:00:00Z', email_id: 'kept-1',
          sender: 'hello@random.com', domain: 'random.com',
          subject: 'Hello', subject_key: 'hello',
          received_at: '2026-07-17T09:00:00Z', bucket: null,
          rule_id: null, action: 'kept', parsed: null
        }
      ]);

      await runAgentReport(opts(tmpDir));

      // Check stored report_json
      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const pendings = db.openPendings();
      const reportJson = JSON.parse(pendings[0].report_json);
      assert.strictEqual(reportJson.sort.moved.length, 1);
      assert.strictEqual(reportJson.sort.moved[0].ruleId, 'github-notif');
      assert.strictEqual(reportJson.sort.moved[0].count, 2);
      assert.strictEqual(reportJson.sort.kept.length, 1);
      assert.strictEqual(reportJson.sort.kept[0].domain, 'random.com');
      assert.strictEqual(typeof reportJson.sort.kept[0].historicalCount, 'number');
      db.close();
    });
  });

  // --- Request file creation ---

  describe('enqueue', () => {
    test('non-dry creates request file in queue dir', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      const o = opts(tmpDir);
      const result = await runAgentReport(o);

      assert.strictEqual(result.status, 'pending');
      const reqDir = path.join(o._queueDir, 'requests');
      const files = fs.readdirSync(reqDir).filter(f => f.endsWith('.json'));
      assert.strictEqual(files.length, 1);
    });

    test('origin defaults to check, can be set to idle', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      const result = await runAgentReport(opts(tmpDir, { origin: 'idle' }));
      assert.strictEqual(result.status, 'pending');

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const pendings = db.openPendings();
      assert.strictEqual(pendings[0].origin, 'idle');
      db.close();
    });
  });

  // --- Fresh peek ---

  describe('fresh peek', () => {
    test('unruled inbox emails appear in fresh[], ruled are invisible', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      // Return inbox messages for fresh peek
      globalThis.fetch = async (url) => {
        if (url.includes('inbox/messages')) {
          return {
            ok: true, status: 200,
            json: async () => ({
              value: [
                { id: 'fresh-1', subject: 'New lead', from: { emailAddress: { address: 'hello@newco.com' } }, receivedDateTime: '2026-07-18T08:00:00Z' },
                { id: 'fresh-ruled', subject: 'GitHub PR', from: { emailAddress: { address: 'noreply@github.com' } }, receivedDateTime: '2026-07-18T08:00:00Z' },
              ]
            })
          };
        }
        return { ok: true, status: 200, json: async () => ({ value: [] }) };
      };

      const result = await runAgentReport(opts(tmpDir));
      assert.strictEqual(result.status, 'pending');

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const pendings = db.openPendings();
      const reportJson = JSON.parse(pendings[0].report_json);

      // Unruled email in fresh[]
      assert.strictEqual(reportJson.fresh.length, 1);
      assert.strictEqual(reportJson.fresh[0].id, 'fresh-1');
      assert.strictEqual(reportJson.fresh[0].sender, 'hello@newco.com');

      // Ruled email (github.com) invisible — not in fresh[]
      assert.ok(!reportJson.fresh.some(f => f.id === 'fresh-ruled'));
      db.close();
    });

    test('sortRows IDs deduped from fresh peek', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      insertSortRows(path.join(tmpDir, 'transactions.db'), [
        {
          run_at: '2026-07-17T10:00:00Z', email_id: 'already-sorted',
          sender: 'x@newco.com', domain: 'newco.com',
          subject: 'Already seen', subject_key: 'already seen',
          received_at: '2026-07-17T09:00:00Z', bucket: null,
          rule_id: null, action: 'kept', parsed: null
        }
      ]);

      globalThis.fetch = async (url) => {
        if (url.includes('inbox/messages')) {
          return {
            ok: true, status: 200,
            json: async () => ({
              value: [
                { id: 'already-sorted', subject: 'Already seen', from: { emailAddress: { address: 'x@newco.com' } }, receivedDateTime: '2026-07-17T09:00:00Z' },
                { id: 'brand-new', subject: 'Brand new', from: { emailAddress: { address: 'y@newco.com' } }, receivedDateTime: '2026-07-18T08:00:00Z' },
              ]
            })
          };
        }
        return { ok: true, status: 200, json: async () => ({ value: [] }) };
      };

      const result = await runAgentReport(opts(tmpDir));
      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const reportJson = JSON.parse(db.openPendings()[0].report_json);

      // 'already-sorted' should NOT be in fresh (deduped)
      assert.ok(!reportJson.fresh.some(f => f.id === 'already-sorted'));
      // 'brand-new' should be in fresh
      assert.ok(reportJson.fresh.some(f => f.id === 'brand-new'));
      db.close();
    });

    test('Graph failure during fresh peek is non-fatal', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      globalThis.fetch = async (url) => {
        if (url.includes('inbox/messages')) {
          throw new Error('Graph API down');
        }
        return { ok: true, status: 200, json: async () => ({ value: [] }) };
      };

      // Should not throw — report continues without fresh data
      const result = await runAgentReport(opts(tmpDir));
      assert.strictEqual(result.status, 'pending');

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const reportJson = JSON.parse(db.openPendings()[0].report_json);
      assert.deepStrictEqual(reportJson.fresh, []);
      db.close();
    });
  });

  // --- Degraded logs run ---

  describe('degraded run logging', () => {
    test('missing state file logs degraded run', async () => {
      const o = opts(tmpDir);
      await runAgentReport(o);

      const db = new AgentDB(o._agentDbPath);
      const last = db.lastRun('report');
      assert.ok(last);
      assert.strictEqual(last.status, 'degraded');
      db.close();
    });
  });
});

// --- buildDegradedMessage ---

describe('buildDegradedMessage', () => {
  test('includes kept + fresh subjects (cap 15)', () => {
    const reportJson = {
      sort: {
        moved: [{ ruleId: 'test', count: 2 }],
        guardBlocked: [],
        kept: [
          { domain: 'example.com', count: 1, samples: [{ subject: 'Hello World', received: '2026-07-18T08:00:00Z' }] },
        ],
      },
      reminders: [],
      questions: [],
      junk: [],
      fresh: [
        { id: 'f1', sender: 'a@b.com', subject: 'Fresh email', received: '2026-07-18T08:00:00Z' },
      ],
    };

    const msg = buildDegradedMessage(reportJson);
    assert.ok(msg.includes('[degraded]'));
    assert.ok(msg.includes('Hello World (example.com)'));
    assert.ok(msg.includes('Fresh email (a@b.com)'));
    assert.ok(msg.includes('LLM 唔喺度'));
  });

  test('caps at 15 subjects with +N more', () => {
    const samples = [];
    for (let i = 0; i < 20; i++) {
      samples.push({ subject: `Subject ${i}`, received: '2026-07-18T08:00:00Z' });
    }
    const reportJson = {
      sort: {
        moved: [],
        guardBlocked: [],
        kept: [{ domain: 'test.com', count: 20, samples }],
      },
      reminders: [],
      questions: [],
      junk: [],
      fresh: [],
    };

    const msg = buildDegradedMessage(reportJson);
    assert.ok(msg.includes('Subject 0'));
    assert.ok(msg.includes('Subject 14'));
    assert.ok(!msg.includes('Subject 15'));
    assert.ok(msg.includes('+5 more'));
  });
});

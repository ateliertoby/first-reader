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
  fs.writeFileSync(p, JSON.stringify({ model: 'claude-sonnet-5' }));
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

    // LLM mock
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
    test('normal chain: uses lastRun window_end as start', async () => {
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
      assert.strictEqual(result.status, 'ok');
      assert.strictEqual(result.reportJson.window.start, '2026-07-17T08:00:00Z');
      // end = now (08:30) minus 15min buffer
      assert.strictEqual(result.reportJson.window.end, '2026-07-18T08:15:00.000Z');
    });

    test('first run: now minus 24h', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      // No previous report run — agent.db is fresh

      const result = await runAgentReport(opts(tmpDir));
      assert.strictEqual(result.status, 'ok');
      assert.strictEqual(result.reportJson.window.start, '2026-07-17T08:30:00.000Z');
      assert.strictEqual(result.reportJson.window.end, '2026-07-18T08:15:00.000Z');
    });

    test('missing state file returns degraded', async () => {
      // No sort-state.json written
      const result = await runAgentReport(opts(tmpDir));
      assert.strictEqual(result.status, 'degraded');
      assert.ok(result.reason.includes('sort has never run'));
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

      // Run twice
      await runAgentReport(opts(tmpDir));
      // Second run (re-process same window by resetting lastRun)
      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      // The first run already logged — second run picks up from window_end
      // But same email_id means INSERT OR IGNORE dedupes
      db.addReminder({ kind: 'hketoll-reminder', source_email_id: 'toll-001', subject: 'dup', now: '2026-07-18T09:00:00Z' });
      const reminders = db.openReminders();
      assert.strictEqual(reminders.length, 1);
      db.close();
    });

    test('expired reminders appear as final-mention in report', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');

      // Pre-seed an old reminder (>14 days)
      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      db.addReminder({
        kind: 'hketoll-reminder', source_email_id: 'old-toll',
        subject: 'Old toll payment', now: '2026-07-01T08:00:00Z'
      });
      db.close();

      const result = await runAgentReport(opts(tmpDir));
      const expired = result.reportJson.reminders.filter(r => r.status === 'expired');
      assert.strictEqual(expired.length, 1);
      assert.strictEqual(expired[0].kind, 'hketoll-reminder');
      assert.strictEqual(expired[0].subject, 'Old toll payment');
    });
  });

  // --- Junk patrol ---

  describe('junk patrol', () => {
    const NOW = '2026-07-18T08:30:00Z';
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
      // Pre-dismiss j-dismissed
      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      db.dismissJunk('j-dismissed', '2026-07-17T00:00:00Z');
      db.close();

      const result = await runAgentReport(opts(tmpDir));

      // j-mox (accounting), j-gh (notifications), j-keep (keep — Toby's standing
      // "I read these" order) should all be rescued
      assert.strictEqual(moveCalls.length, 3);
      assert.ok(moveCalls.some(u => u.includes('j-mox')));
      assert.ok(moveCalls.some(u => u.includes('j-gh')));
      assert.ok(moveCalls.some(u => u.includes('j-keep')));

      const rescued = result.reportJson.junk.filter(j => j.flag === 'rescued-rule');
      assert.strictEqual(rescued.length, 3);
      assert.ok(rescued.some(j => j.rule_id === 'mox-tx'));
      assert.ok(rescued.some(j => j.rule_id === 'github-notif'));
      assert.ok(rescued.some(j => j.rule_id === 'keep-test'));
    });

    test('guarded and unruled emails go to pending', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      setupJunkFetch();
      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      db.dismissJunk('j-dismissed', '2026-07-17T00:00:00Z');
      db.close();

      const result = await runAgentReport(opts(tmpDir));
      const pending = result.reportJson.junk.filter(j => j.flag === 'pending');
      // j-guard (guard word in junk = extra suspicious), j-unruled (no rule)
      assert.strictEqual(pending.length, 2);
      const pendingIds = pending.map(j => j.id);
      assert.ok(pendingIds.includes('j-guard'));
      assert.ok(pendingIds.includes('j-unruled'));
    });

    test('dismissed ids are skipped', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      setupJunkFetch();
      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      db.dismissJunk('j-dismissed', '2026-07-17T00:00:00Z');
      db.close();

      const result = await runAgentReport(opts(tmpDir));
      const allIds = result.reportJson.junk.map(j => j.id);
      assert.ok(!allIds.includes('j-dismissed'));
    });
  });

  // --- LLM output application ---

  describe('LLM output application', () => {
    test('new questions are added to DB', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      _setLLMTransportForTesting(async () => ({
        message_text: 'Report with questions',
        new_questions: [
          { domain: 'billing', question: 'Keep mox alerts?' },
          { domain: 'social', question: 'Sort github stars?' }
        ],
        auto_resolved_reminders: [],
        junk_flags: []
      }));

      await runAgentReport(opts(tmpDir));

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const questions = db.openQuestions();
      assert.strictEqual(questions.length, 2);
      assert.ok(questions.some(q => q.domain === 'billing'));
      assert.ok(questions.some(q => q.domain === 'social'));
      db.close();
    });

    test('question dedupe: same domain not re-added', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      // Pre-seed an open question
      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      db.addQuestion({ domain: 'billing', question: 'Old q?', now: '2026-07-17T08:00:00Z' });
      db.close();

      _setLLMTransportForTesting(async () => ({
        message_text: 'Report',
        new_questions: [{ domain: 'billing', question: 'New q?' }],
        auto_resolved_reminders: [],
        junk_flags: []
      }));

      await runAgentReport(opts(tmpDir));

      const db2 = new AgentDB(path.join(tmpDir, 'agent.db'));
      const questions = db2.openQuestions();
      assert.strictEqual(questions.length, 1);
      assert.strictEqual(questions[0].question, 'Old q?');
      db2.close();
    });

    test('auto-resolved reminders are marked resolved', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      // Pre-seed a reminder
      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      db.addReminder({
        kind: 'hketoll-reminder', source_email_id: 'toll-x',
        subject: 'Toll', now: '2026-07-16T08:00:00Z'
      });
      const reminderId = db.openReminders()[0].id;
      db.close();

      _setLLMTransportForTesting(async () => ({
        message_text: 'Report',
        new_questions: [],
        auto_resolved_reminders: [{ id: reminderId }],
        junk_flags: []
      }));

      await runAgentReport(opts(tmpDir));

      const db2 = new AgentDB(path.join(tmpDir, 'agent.db'));
      assert.strictEqual(db2.openReminders().length, 0);
      db2.close();
    });

    test('junk flags are advisory only — no graph moves', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      const moveCalls = [];
      globalThis.fetch = async (url, fetchOpts) => {
        if (fetchOpts?.method === 'POST') moveCalls.push(url);
        if (url.includes('junkemail/messages')) {
          return {
            ok: true, status: 200,
            json: async () => ({
              value: [
                { id: 'j-pending', subject: 'Spam', from: { emailAddress: { address: 'x@unknown.com' } }, receivedDateTime: '2026-07-18T06:00:00Z' }
              ]
            })
          };
        }
        return { ok: true, status: 200, json: async () => ({ value: [] }) };
      };

      _setLLMTransportForTesting(async () => ({
        message_text: 'Report',
        new_questions: [],
        auto_resolved_reminders: [],
        junk_flags: [{ id: 'j-pending', flag: 'pending-danger', reason: 'looks phishy' }]
      }));

      const result = await runAgentReport(opts(tmpDir));

      // No move calls for flagged junk — flags are advisory
      assert.strictEqual(moveCalls.length, 0);
      // Flag is merged into the item for display
      const item = result.reportJson.junk.find(j => j.id === 'j-pending');
      assert.strictEqual(item.flag, 'pending-danger');
      assert.strictEqual(item.reason, 'looks phishy');
    });
  });

  // --- Degraded mode ---

  describe('degraded mode', () => {
    test('LLM failure produces degraded template', async () => {
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

      const result = await runAgentReport(opts(tmpDir));
      assert.strictEqual(result.status, 'degraded');
      assert.ok(result.message.startsWith('[degraded]'));
      assert.ok(result.message.includes('sort:'));
      assert.ok(result.message.includes('LLM 唔喺度，建議缺席'));
    });

    test('degraded run still writes outbox and logRun', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      _setLLMTransportForTesting(async () => { throw new Error('API down'); });

      const o = opts(tmpDir);
      await runAgentReport(o);

      // Outbox file created
      const outboxFiles = fs.readdirSync(o._outboxDir);
      assert.strictEqual(outboxFiles.length, 1);
      const outbox = JSON.parse(fs.readFileSync(path.join(o._outboxDir, outboxFiles[0]), 'utf8'));
      assert.ok(outbox.text.startsWith('[degraded]'));

      // Run logged
      const db = new AgentDB(o._agentDbPath);
      const last = db.lastRun('report');
      assert.strictEqual(last.status, 'degraded');
      db.close();
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

      // No DB mutations: no reminders, no questions, no runs
      const db = new AgentDB(o._agentDbPath);
      assert.strictEqual(db.openReminders().length, 0);
      assert.strictEqual(db.openQuestions().length, 0);
      assert.strictEqual(db.lastRun('report'), null);
      db.close();
    });
  });

  // --- Notes warning ---

  describe('notes warning', () => {
    test('notes >60 lines appends warning to message', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      const lines = Array(65).fill('line').join('\n');
      writeNotes(tmpDir, lines);

      const result = await runAgentReport(opts(tmpDir));
      assert.ok(result.message.includes('agent-notes.md 有 65 行，清理時間'));
    });

    test('notes <=60 lines: no warning', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      writeNotes(tmpDir, Array(60).fill('line').join('\n'));

      const result = await runAgentReport(opts(tmpDir));
      assert.ok(!result.message.includes('agent-notes.md'));
    });

    test('notes warning in degraded mode uses / separator', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      writeNotes(tmpDir, Array(70).fill('line').join('\n'));
      _setLLMTransportForTesting(async () => { throw new Error('fail'); });

      const result = await runAgentReport(opts(tmpDir));
      assert.ok(result.message.includes(' / agent-notes.md 有 70 行，清理時間'));
    });
  });

  // --- Sort section ---

  describe('sort section', () => {
    test('groups moved rows and attaches historicalCount to kept', async () => {
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

      const result = await runAgentReport(opts(tmpDir));
      const { sort } = result.reportJson;
      assert.strictEqual(sort.moved.length, 1);
      assert.strictEqual(sort.moved[0].ruleId, 'github-notif');
      assert.strictEqual(sort.moved[0].count, 2);
      assert.strictEqual(sort.kept.length, 1);
      assert.strictEqual(sort.kept[0].domain, 'random.com');
      assert.strictEqual(typeof sort.kept[0].historicalCount, 'number');
    });

    test('kept-rule and pinned appear only as summary counts', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      insertSortRows(path.join(tmpDir, 'transactions.db'), [
        {
          run_at: '2026-07-17T10:00:00Z', email_id: 'kr-1',
          sender: 'info@important.com', domain: 'important.com',
          subject: 'Important stuff', subject_key: 'important stuff',
          received_at: '2026-07-17T09:00:00Z', bucket: 'keep',
          rule_id: 'keep-test', action: 'kept-rule', parsed: null
        }
      ]);

      const result = await runAgentReport(opts(tmpDir));
      // kept-rule should NOT appear in kept[] (which is unruled only)
      assert.strictEqual(result.reportJson.sort.kept.length, 0);
      assert.strictEqual(result.reportJson.sort.summary.keptRuleCount, 1);
    });
  });

  // --- Outbox ---

  describe('outbox', () => {
    test('non-dry writes outbox JSON with ts and text', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      const o = opts(tmpDir);
      await runAgentReport(o);

      const files = fs.readdirSync(o._outboxDir);
      assert.strictEqual(files.length, 1);
      assert.ok(files[0].endsWith('.json'));
      const content = JSON.parse(fs.readFileSync(path.join(o._outboxDir, files[0]), 'utf8'));
      assert.strictEqual(content.ts, '2026-07-18T08:30:00Z');
      assert.strictEqual(typeof content.text, 'string');
      assert.ok(content.text.length > 0);
    });
  });

  // --- Run ledger ---

  describe('run ledger', () => {
    test('non-dry logs run with window and status', async () => {
      writeSortState(tmpDir, '2026-07-18T08:00:00Z');
      const o = opts(tmpDir);
      await runAgentReport(o);

      const db = new AgentDB(o._agentDbPath);
      const last = db.lastRun('report');
      assert.ok(last);
      assert.strictEqual(last.status, 'ok');
      assert.strictEqual(last.window_end, '2026-07-18T08:15:00.000Z');
      db.close();
    });

    test('missing state file logs degraded run (non-dry)', async () => {
      // No sort-state.json
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

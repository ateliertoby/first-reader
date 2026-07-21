import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHandler } from '../src/agent/handler.js';
import { AgentDB } from '../src/agent/db.js';
import { _setIntentTransportForTesting } from '../src/agent/intent.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'first-reader-handler-'));
}

describe('createHandler', () => {
  let tmpDir, agentDb;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agentDb = new AgentDB(path.join(tmpDir, 'agent.db'));
  });

  afterEach(() => {
    _setIntentTransportForTesting(null);
    agentDb.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  function makeHandler(overrides = {}) {
    return createHandler({
      agentDb,
      model: 'claude-sonnet-5',
      ownerName: 'TestUser',
      replyLanguage: 'English',
      rulesPath: path.join(tmpDir, 'rules.json'),
      notesPath: path.join(tmpDir, 'agent-notes.md'),
      sortDbPath: path.join(tmpDir, 'transactions.db'),
      lastReportPath: path.join(tmpDir, 'agent-last-report.json'),
      graphGet: async () => ({ id: 'inbox-id' }),
      graphPost: async () => ({ id: 'new-id' }),
      runReport: async () => ({}),
      drainOutbox: async () => ({}),
      getNow: () => '2026-07-18T10:00:00Z',
      ...overrides,
    });
  }

  test('clarification: returns reply_text only, no ops executed', async () => {
    _setIntentTransportForTesting(() => ({
      ops: [],
      reply_text: 'Could you clarify what you mean?',
      needs_clarification: true,
    }));

    const handler = makeHandler();
    const reply = await handler('hmm');

    assert.strictEqual(reply, 'Could you clarify what you mean?');
  });

  test('no ops, no clarification: returns reply_text', async () => {
    _setIntentTransportForTesting(() => ({
      ops: [],
      reply_text: 'OK',
      needs_clarification: false,
    }));

    const handler = makeHandler();
    const reply = await handler('hello');

    assert.strictEqual(reply, 'OK');
  });

  test('ops path: returns concatenated confirmations plus reply_text', async () => {
    // Set up rules.json for rule_add to work
    fs.writeFileSync(path.join(tmpDir, 'rules.json'), JSON.stringify({
      guards: ['urgent'], settings: { minAgeHours: 6 }, rules: []
    }, null, 2) + '\n');

    _setIntentTransportForTesting(() => ({
      ops: [
        { type: 'rule_add', bucket: 'notifications', domains: ['test.com'] },
      ],
      reply_text: 'Done',
      needs_clarification: false,
    }));

    const handler = makeHandler();
    const reply = await handler('add rule for test.com');

    assert.ok(reply.includes('已落 rule'), `Expected rule confirmation, got: ${reply}`);
    assert.ok(reply.includes('Done'), `Expected reply_text, got: ${reply}`);
  });

  test('context loading tolerates missing last-report file', async () => {
    // No last-report file exists — handler should still work
    _setIntentTransportForTesting((args) => {
      // Verify no untrusted_report_data in user prompt (file missing)
      assert.ok(!args.user.includes('untrusted_report_data'));
      return { ops: [], reply_text: 'OK', needs_clarification: false };
    });

    const handler = makeHandler();
    const reply = await handler('hi');

    assert.strictEqual(reply, 'OK');
  });

  test('context loading includes last-report data when file exists', async () => {
    const report = {
      window: { start: '2026-07-18T00:00:00Z', end: '2026-07-18T08:00:00Z' },
      sort: { moved: [], guardBlocked: [], noparse: [], unsorted: [], runErrors: [], kept: [] },
      reminders: [], questions: [],
      junk: [
        { id: 'j1', sender: 'spam@bad.com', subject: 'free', flag: 'pending-normal' },
        { id: 'j2', sender: 'ok@good.com', subject: 'receipt', flag: 'rescued-rule' },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'agent-last-report.json'),
      JSON.stringify(report, null, 2)
    );

    _setIntentTransportForTesting((args) => {
      // Pending junk should include j1 but not j2 (rescued-rule filtered out)
      assert.ok(args.user.includes('spam@bad.com'));
      assert.ok(!args.user.includes('ok@good.com'));
      return { ops: [], reply_text: 'ok', needs_clarification: false };
    });

    const handler = makeHandler();
    await handler('status');
  });

  test('context includes open reminders and questions from agentDb', async () => {
    agentDb.addReminder({
      kind: 'hketoll-reminder', source_email_id: 'e-1',
      subject: 'toll payment', now: '2026-07-18T08:00:00Z'
    });
    agentDb.addQuestion({
      domain: 'billing', question: 'Keep or sort?', now: '2026-07-18T08:00:00Z'
    });

    _setIntentTransportForTesting((args) => {
      assert.ok(args.user.includes('hketoll-reminder'));
      assert.ok(args.user.includes('Keep or sort'));
      return { ops: [], reply_text: 'ok', needs_clarification: false };
    });

    const handler = makeHandler();
    await handler('check');
  });

  test('handler catches errors and returns error message', async () => {
    _setIntentTransportForTesting(() => {
      throw new Error('API unavailable');
    });

    const handler = makeHandler();
    const reply = await handler('hello');

    assert.ok(reply.includes('處理失敗'));
    assert.ok(reply.includes('API unavailable'));
  });

  test('empty reply_text with no ops returns fallback', async () => {
    _setIntentTransportForTesting(() => ({
      ops: [],
      reply_text: '',
      needs_clarification: false,
    }));

    const handler = makeHandler();
    const reply = await handler('...');

    assert.strictEqual(reply, '收到');
  });
});

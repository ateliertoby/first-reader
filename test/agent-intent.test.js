import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  parseIntent,
  runDeepVerify,
  _setIntentTransportForTesting,
  _setDeepVerifyTransportForTesting,
} from '../src/agent/intent.js';

afterEach(() => {
  _setIntentTransportForTesting(null);
  _setDeepVerifyTransportForTesting(null);
});

describe('parseIntent', () => {
  test('transport injection: mock is called instead of real API', async () => {
    let captured = null;
    _setIntentTransportForTesting((args) => {
      captured = args;
      return { ops: [], reply_text: 'mock reply', needs_clarification: false };
    });

    const result = await parseIntent({
      model: 'claude-sonnet-5',
      userText: 'hello',
      context: {},
    });

    assert.ok(captured, 'transport should have been called');
    assert.strictEqual(captured.model, 'claude-sonnet-5');
    assert.ok(captured.system.includes('IRON RULE'));
    assert.ok(captured.user.includes('hello'));
    assert.strictEqual(result.reply_text, 'mock reply');
  });

  test('ops passthrough: mock ops returned as-is', async () => {
    _setIntentTransportForTesting(() => ({
      ops: [
        { type: 'rule_add', bucket: 'notifications', domains: ['test.com'] },
        { type: 'guard_add', word: 'invoice' },
      ],
      reply_text: '落咗',
      needs_clarification: false,
    }));

    const result = await parseIntent({
      model: 'claude-sonnet-5',
      userText: 'add rule and guard',
      context: {},
    });

    assert.strictEqual(result.ops.length, 2);
    assert.strictEqual(result.ops[0].type, 'rule_add');
    assert.strictEqual(result.ops[0].bucket, 'notifications');
    assert.deepStrictEqual(result.ops[0].domains, ['test.com']);
    assert.strictEqual(result.ops[1].type, 'guard_add');
    assert.strictEqual(result.ops[1].word, 'invoice');
    assert.strictEqual(result.needs_clarification, false);
  });

  test('needs_clarification path: empty ops, reply asks for clarity', async () => {
    _setIntentTransportForTesting(() => ({
      ops: [],
      reply_text: '你想做乜？',
      needs_clarification: true,
    }));

    const result = await parseIntent({
      model: 'claude-sonnet-5',
      userText: 'hmm',
      context: {},
    });

    assert.strictEqual(result.ops.length, 0);
    assert.strictEqual(result.needs_clarification, true);
    assert.strictEqual(result.reply_text, '你想做乜？');
  });

  test('context included in user message when provided', async () => {
    let captured = null;
    _setIntentTransportForTesting((args) => {
      captured = args;
      return { ops: [], reply_text: 'ok', needs_clarification: false };
    });

    await parseIntent({
      model: 'claude-sonnet-5',
      userText: 'status',
      context: {
        lastReport: { window: { start: '2026-07-18T00:00:00Z', end: '2026-07-18T08:00:00Z' } },
        openReminders: [{ id: 1, kind: 'hketoll-reminder' }],
        openQuestions: [{ id: 2, question: 'keep or sort?' }],
        pendingJunk: [{ id: 'abc', sender: 'spam@test.com', subject: 'free money' }],
        notesContent: 'test note content',
      },
    });

    assert.ok(captured.user.includes('untrusted_report_data'));
    assert.ok(captured.user.includes('open_reminders'));
    assert.ok(captured.user.includes('hketoll-reminder'));
    assert.ok(captured.user.includes('open_questions'));
    assert.ok(captured.user.includes('pending_junk'));
    assert.ok(captured.user.includes('spam@test.com'));
    // Notes go in system prompt
    assert.ok(captured.system.includes('test note content'));
  });

  test('missing context fields tolerated', async () => {
    let captured = null;
    _setIntentTransportForTesting((args) => {
      captured = args;
      return { ops: [], reply_text: 'ok', needs_clarification: false };
    });

    await parseIntent({
      model: 'claude-sonnet-5',
      userText: 'hi',
      context: null,
    });

    assert.ok(captured);
    assert.ok(!captured.user.includes('untrusted_report_data'));
    assert.ok(!captured.user.includes('open_reminders'));
  });
});

describe('runDeepVerify', () => {
  test('transport injection: mock called, not real API', async () => {
    let captured = null;
    _setDeepVerifyTransportForTesting((args) => {
      captured = args;
      return 'Verified: claim is true, source: example.com';
    });

    const result = await runDeepVerify({
      model: 'claude-sonnet-5',
      claim: 'This sender is legitimate',
      context: 'sender: foo@bar.com',
    });

    assert.ok(captured);
    assert.strictEqual(captured.model, 'claude-sonnet-5');
    assert.strictEqual(captured.claim, 'This sender is legitimate');
    assert.ok(captured.system.includes('IRON RULE'));
    assert.ok(captured.user.includes('This sender is legitimate'));
    assert.ok(captured.user.includes('foo@bar.com'));
    assert.strictEqual(result, 'Verified: claim is true, source: example.com');
  });

  test('works without context', async () => {
    _setDeepVerifyTransportForTesting((args) => {
      assert.ok(!args.user.includes('Context:'));
      return 'no context result';
    });

    const result = await runDeepVerify({
      model: 'claude-sonnet-5',
      claim: 'test claim',
    });
    assert.strictEqual(result, 'no context result');
  });
});

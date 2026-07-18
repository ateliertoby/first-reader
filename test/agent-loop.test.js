import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { msUntilNextMonthly, runLoop } from '../src/agent/loop.js';
import { AgentDB } from '../src/agent/db.js';
import { _setIntentTransportForTesting } from '../src/agent/intent.js';

// --- msUntilNextMonthly ---

describe('msUntilNextMonthly', () => {
  test('1st of month before slot: fires today', () => {
    // 2026-08-01T00:00:00Z = 08:00 HKT, target 09:00 -> 60min
    const ms = msUntilNextMonthly('09:00', 'Asia/Hong_Kong', '2026-08-01T00:00:00Z');
    assert.strictEqual(ms, 60 * 60 * 1000);
  });

  test('1st of month after slot: fires next month', () => {
    // 2026-08-01T02:00:00Z = 10:00 HKT, target 09:00 -> next month
    const ms = msUntilNextMonthly('09:00', 'Asia/Hong_Kong', '2026-08-01T02:00:00Z');
    assert.ok(ms > 29 * 24 * 60 * 60 * 1000); // at least 29 days
  });
});

// --- runLoop ---

describe('runLoop', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-cli-loop-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  function makeMockChannel(messageBatches) {
    return {
      pollCount: 0,
      sent: [],
      drainCalls: [],
      async poll(offsetRef) {
        const msgs = messageBatches[this.pollCount] ?? [];
        this.pollCount++;
        if (msgs.length > 0) {
          offsetRef.value = (offsetRef.value || 0) + msgs.length;
        }
        return msgs;
      },
      async send(text) { this.sent.push(text); },
      async drainOutbox(dir) {
        this.drainCalls.push(dir);
        return { sent: 0, remaining: 0 };
      },
    };
  }

  test('logs engagement with correct kind: /command vs plain text', async () => {
    const messages = [
      { chat: { id: 100 }, text: '/report' },
      { chat: { id: 100 }, text: 'hello there' },
    ];
    const channel = makeMockChannel([messages]);
    const dbPath = path.join(tmpDir, 'agent.db');

    await runLoop({
      _channel: channel,
      _agentDbPath: dbPath,
      _stateFile: path.join(tmpDir, 'state.json'),
      _outboxDir: path.join(tmpDir, 'outbox'),
      _maxPolls: 1,
      _timezone: 'Asia/Hong_Kong',
      _getNow: () => '2026-07-18T10:00:00Z',
    });

    const db = new AgentDB(dbPath);
    const rows = db.engagementSince('2000-01-01T00:00:00Z');
    assert.strictEqual(rows.length, 2);
    const kinds = rows.map(r => r.kind);
    assert.strictEqual(kinds[0], 'command');
    assert.strictEqual(kinds[1], 'reply');
    db.close();
  });

  test('opportunistic drain called on each incoming message', async () => {
    const messages = [
      { chat: { id: 100 }, text: 'first' },
      { chat: { id: 100 }, text: 'second' },
    ];
    const channel = makeMockChannel([messages]);
    const outboxDir = path.join(tmpDir, 'outbox');

    await runLoop({
      _channel: channel,
      _agentDbPath: path.join(tmpDir, 'agent.db'),
      _stateFile: path.join(tmpDir, 'state.json'),
      _outboxDir: outboxDir,
      _maxPolls: 1,
      _timezone: 'Asia/Hong_Kong',
    });

    // 1 startup drain + 1 per message = 3 total
    assert.strictEqual(channel.drainCalls.length, 3);
    for (const call of channel.drainCalls) {
      assert.strictEqual(call, outboxDir);
    }
  });

  test('default handler processes messages via intent parser', async () => {
    // Mock the LLM intent transport so default handler works without real API
    _setIntentTransportForTesting(() => ({
      ops: [],
      reply_text: '收到你嘅 message',
      needs_clarification: false
    }));

    const messages = [{ chat: { id: 100 }, text: 'hello' }];
    const channel = makeMockChannel([messages]);

    await runLoop({
      _channel: channel,
      _agentDbPath: path.join(tmpDir, 'agent.db'),
      _stateFile: path.join(tmpDir, 'state.json'),
      _outboxDir: path.join(tmpDir, 'outbox'),
      _maxPolls: 1,
      _timezone: 'Asia/Hong_Kong',
    });

    assert.strictEqual(channel.sent.length, 1);
    assert.strictEqual(channel.sent[0], '收到你嘅 message');

    _setIntentTransportForTesting(null);
  });

  test('offset persisted across restarts', async () => {
    const stateFile = path.join(tmpDir, 'state.json');
    const messages = [{ chat: { id: 100 }, text: 'hi' }];

    // First run — channel advances offset
    const channel1 = makeMockChannel([messages]);
    await runLoop({
      _channel: channel1,
      _agentDbPath: path.join(tmpDir, 'agent.db'),
      _stateFile: stateFile,
      _outboxDir: path.join(tmpDir, 'outbox'),
      _maxPolls: 1,
      _timezone: 'Asia/Hong_Kong',
    });

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(state.offset > 0, 'offset should be persisted');

    // Second run — verify offset starts from persisted value
    let seenOffset;
    const channel2 = {
      async poll(offsetRef) {
        seenOffset = offsetRef.value;
        return [];
      },
      async send() {},
      async drainOutbox() { return { sent: 0, remaining: 0 }; },
    };

    await runLoop({
      _channel: channel2,
      _agentDbPath: path.join(tmpDir, 'agent2.db'),
      _stateFile: stateFile,
      _outboxDir: path.join(tmpDir, 'outbox'),
      _maxPolls: 1,
      _timezone: 'Asia/Hong_Kong',
    });

    assert.strictEqual(seenOffset, state.offset);
  });

  test('custom onMessage handler receives text and ctx', async () => {
    const messages = [{ chat: { id: 100 }, text: 'test message' }];
    const channel = makeMockChannel([messages]);
    const handlerCalls = [];

    await runLoop({
      _channel: channel,
      _agentDbPath: path.join(tmpDir, 'agent.db'),
      _stateFile: path.join(tmpDir, 'state.json'),
      _outboxDir: path.join(tmpDir, 'outbox'),
      _maxPolls: 1,
      _timezone: 'Asia/Hong_Kong',
      onMessage: async (text, ctx) => {
        handlerCalls.push({ text, ctx });
        return 'custom reply';
      },
    });

    assert.strictEqual(handlerCalls.length, 1);
    assert.strictEqual(handlerCalls[0].text, 'test message');
    assert.strictEqual(handlerCalls[0].ctx.chatId, 100);
    assert.strictEqual(channel.sent[0], 'custom reply');
  });

  test('null reply from onMessage does not send', async () => {
    const messages = [{ chat: { id: 100 }, text: 'hi' }];
    const channel = makeMockChannel([messages]);

    await runLoop({
      _channel: channel,
      _agentDbPath: path.join(tmpDir, 'agent.db'),
      _stateFile: path.join(tmpDir, 'state.json'),
      _outboxDir: path.join(tmpDir, 'outbox'),
      _maxPolls: 1,
      _timezone: 'Asia/Hong_Kong',
      onMessage: async () => null,
    });

    assert.strictEqual(channel.sent.length, 0);
  });

  test('no messages: no engagement logged, no reply sent', async () => {
    const channel = makeMockChannel([[]]); // one poll returning empty
    const dbPath = path.join(tmpDir, 'agent.db');

    await runLoop({
      _channel: channel,
      _agentDbPath: dbPath,
      _stateFile: path.join(tmpDir, 'state.json'),
      _outboxDir: path.join(tmpDir, 'outbox'),
      _maxPolls: 1,
      _timezone: 'Asia/Hong_Kong',
    });

    assert.strictEqual(channel.sent.length, 0);
    const db = new AgentDB(dbPath);
    assert.strictEqual(db.engagementSince('2000-01-01T00:00:00Z').length, 0);
    db.close();
  });
});

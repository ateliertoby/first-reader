import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  TelegramChannel,
  _setTelegramDelaysForTesting,
  _setTelegramSleepForTesting,
} from '../src/agent/telegram.js';

describe('TelegramChannel', () => {
  let originalFetch, tmpDir;
  const BASE_URL = 'https://test-tg-api/bot123';
  const CHAT_ID = 12345;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    _setTelegramDelaysForTesting([0, 0]);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-cli-tg-'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTelegramDelaysForTesting([1000, 3000]);
    _setTelegramSleepForTesting(null);
    fs.rmSync(tmpDir, { recursive: true });
  });

  // --- send ---

  describe('send', () => {
    test('single message under 4096 chars', async () => {
      const sentBodies = [];
      globalThis.fetch = async (url, opts) => {
        sentBodies.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
      };

      const ch = new TelegramChannel({ chatId: CHAT_ID, baseUrl: BASE_URL });
      await ch.send('Hello world');

      assert.strictEqual(sentBodies.length, 1);
      assert.strictEqual(sentBodies[0].text, 'Hello world');
      assert.strictEqual(sentBodies[0].chat_id, CHAT_ID);
    });

    test('message >4096 chars splits on newline boundary', async () => {
      const sentBodies = [];
      globalThis.fetch = async (url, opts) => {
        sentBodies.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
      };

      const ch = new TelegramChannel({ chatId: CHAT_ID, baseUrl: BASE_URL });
      // Newline at position 4000 — split should happen there
      const text = 'a'.repeat(4000) + '\n' + 'b'.repeat(999);
      await ch.send(text);

      assert.strictEqual(sentBodies.length, 2);
      assert.strictEqual(sentBodies[0].text, 'a'.repeat(4000));
      assert.strictEqual(sentBodies[1].text, 'b'.repeat(999));
      assert.ok(sentBodies[0].text.length <= 4096);
      assert.ok(sentBodies[1].text.length <= 4096);
    });

    test('message >4096 chars without newlines does hard split at 4096', async () => {
      const sentBodies = [];
      globalThis.fetch = async (url, opts) => {
        sentBodies.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
      };

      const ch = new TelegramChannel({ chatId: CHAT_ID, baseUrl: BASE_URL });
      const text = 'x'.repeat(5000);
      await ch.send(text);

      assert.strictEqual(sentBodies.length, 2);
      assert.strictEqual(sentBodies[0].text.length, 4096);
      assert.strictEqual(sentBodies[1].text.length, 904);
      // Combined content equals original
      assert.strictEqual(sentBodies[0].text + sentBodies[1].text, text);
    });

    test('exactly 4096 chars: no split', async () => {
      const sentBodies = [];
      globalThis.fetch = async (url, opts) => {
        sentBodies.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
      };

      const ch = new TelegramChannel({ chatId: CHAT_ID, baseUrl: BASE_URL });
      await ch.send('z'.repeat(4096));

      assert.strictEqual(sentBodies.length, 1);
      assert.strictEqual(sentBodies[0].text.length, 4096);
    });

    test('429 with retry_after honored', async () => {
      const sleepCalls = [];
      _setTelegramSleepForTesting(async (ms) => { sleepCalls.push(ms); });

      let callCount = 0;
      globalThis.fetch = async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false, status: 429,
            json: async () => ({
              description: 'Too Many Requests',
              parameters: { retry_after: 7 },
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
      };

      const ch = new TelegramChannel({ chatId: CHAT_ID, baseUrl: BASE_URL });
      await ch.send('test');

      assert.strictEqual(callCount, 2);
      // retry_after (7s) should be used instead of default delay
      assert.strictEqual(sleepCalls[0], 7000);
    });

    test('5xx retry then success', async () => {
      let callCount = 0;
      globalThis.fetch = async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false, status: 503,
            json: async () => ({ description: 'Service Unavailable' }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
      };

      const ch = new TelegramChannel({ chatId: CHAT_ID, baseUrl: BASE_URL });
      await ch.send('test');
      assert.strictEqual(callCount, 2);
    });

    test('network error exhausted throws', async () => {
      globalThis.fetch = async () => { throw new Error('ECONNRESET'); };

      const ch = new TelegramChannel({ chatId: CHAT_ID, baseUrl: BASE_URL });
      await assert.rejects(
        () => ch.send('test'),
        { message: 'ECONNRESET' }
      );
    });

    test('4xx (non-429) throws immediately without retry', async () => {
      let callCount = 0;
      globalThis.fetch = async () => {
        callCount++;
        return {
          ok: false, status: 400,
          json: async () => ({ description: 'Bad Request' }),
        };
      };

      const ch = new TelegramChannel({ chatId: CHAT_ID, baseUrl: BASE_URL });
      await assert.rejects(
        () => ch.send('test'),
        { message: /Bad Request/ }
      );
      assert.strictEqual(callCount, 1);
    });
  });

  // --- poll (allowlist) ---

  describe('poll allowlist', () => {
    test('correct chatId passes, wrong chatId dropped', async () => {
      globalThis.fetch = async () => ({
        ok: true, status: 200,
        json: async () => ({
          ok: true,
          result: [
            { update_id: 1, message: { chat: { id: CHAT_ID }, text: 'allowed' } },
            { update_id: 2, message: { chat: { id: 99999 }, text: 'intruder' } },
            { update_id: 3, message: { chat: { id: CHAT_ID }, text: 'also allowed' } },
          ],
        }),
      });

      const ch = new TelegramChannel({ chatId: CHAT_ID, baseUrl: BASE_URL });
      const offsetRef = { value: 0 };
      const messages = await ch.poll(offsetRef);

      assert.strictEqual(messages.length, 2);
      assert.strictEqual(messages[0].text, 'allowed');
      assert.strictEqual(messages[1].text, 'also allowed');
      // Offset advances past ALL updates including dropped ones
      assert.strictEqual(offsetRef.value, 4);
    });

    test('all wrong chatId returns empty, offset still advances', async () => {
      globalThis.fetch = async () => ({
        ok: true, status: 200,
        json: async () => ({
          ok: true,
          result: [
            { update_id: 10, message: { chat: { id: 99999 }, text: 'hacker' } },
          ],
        }),
      });

      const ch = new TelegramChannel({ chatId: CHAT_ID, baseUrl: BASE_URL });
      const offsetRef = { value: 0 };
      const messages = await ch.poll(offsetRef);

      assert.strictEqual(messages.length, 0);
      assert.strictEqual(offsetRef.value, 11);
    });
  });

  // --- poll (offset) ---

  describe('poll offset', () => {
    test('advances offset past highest update_id', async () => {
      globalThis.fetch = async () => ({
        ok: true, status: 200,
        json: async () => ({
          ok: true,
          result: [
            { update_id: 42, message: { chat: { id: CHAT_ID }, text: 'hi' } },
            { update_id: 43, message: { chat: { id: CHAT_ID }, text: 'there' } },
          ],
        }),
      });

      const ch = new TelegramChannel({ chatId: CHAT_ID, baseUrl: BASE_URL });
      const offsetRef = { value: 0 };
      await ch.poll(offsetRef);
      assert.strictEqual(offsetRef.value, 44);
    });

    test('no updates does not change offset', async () => {
      globalThis.fetch = async () => ({
        ok: true, status: 200,
        json: async () => ({ ok: true, result: [] }),
      });

      const ch = new TelegramChannel({ chatId: CHAT_ID, baseUrl: BASE_URL });
      const offsetRef = { value: 10 };
      const messages = await ch.poll(offsetRef);
      assert.strictEqual(messages.length, 0);
      assert.strictEqual(offsetRef.value, 10);
    });

    test('sends offset and timeout in request body', async () => {
      let sentBody;
      globalThis.fetch = async (url, opts) => {
        sentBody = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
      };

      const ch = new TelegramChannel({ chatId: CHAT_ID, baseUrl: BASE_URL });
      const offsetRef = { value: 42 };
      await ch.poll(offsetRef);
      assert.strictEqual(sentBody.offset, 42);
      assert.strictEqual(sentBody.timeout, 30);
      assert.deepStrictEqual(sentBody.allowed_updates, ['message']);
    });

    test('poll error returns empty without advancing offset', async () => {
      globalThis.fetch = async () => { throw new Error('network down'); };

      const ch = new TelegramChannel({ chatId: CHAT_ID, baseUrl: BASE_URL });
      const offsetRef = { value: 5 };
      const messages = await ch.poll(offsetRef);
      assert.strictEqual(messages.length, 0);
      assert.strictEqual(offsetRef.value, 5);
    });
  });

  // --- drainOutbox ---

  describe('drainOutbox', () => {
    test('sends files in ts order and deletes after send', async () => {
      const outboxDir = path.join(tmpDir, 'outbox');
      fs.mkdirSync(outboxDir);
      fs.writeFileSync(path.join(outboxDir, '2026-07-18T08-00-00-000Z.json'),
        JSON.stringify({ ts: '2026-07-18T08:00:00Z', text: 'first' }));
      fs.writeFileSync(path.join(outboxDir, '2026-07-18T09-00-00-000Z.json'),
        JSON.stringify({ ts: '2026-07-18T09:00:00Z', text: 'second' }));
      fs.writeFileSync(path.join(outboxDir, '2026-07-18T10-00-00-000Z.json'),
        JSON.stringify({ ts: '2026-07-18T10:00:00Z', text: 'third' }));

      const sentTexts = [];
      globalThis.fetch = async (url, opts) => {
        sentTexts.push(JSON.parse(opts.body).text);
        return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
      };

      const ch = new TelegramChannel({ chatId: CHAT_ID, baseUrl: BASE_URL });
      const result = await ch.drainOutbox(outboxDir);

      assert.deepStrictEqual(sentTexts, ['first', 'second', 'third']);
      assert.strictEqual(result.sent, 3);
      assert.strictEqual(result.remaining, 0);
      assert.strictEqual(fs.readdirSync(outboxDir).length, 0);
    });

    test('stops on first failure, leaves remaining files', async () => {
      const outboxDir = path.join(tmpDir, 'outbox');
      fs.mkdirSync(outboxDir);
      fs.writeFileSync(path.join(outboxDir, '01.json'),
        JSON.stringify({ ts: 't1', text: 'one' }));
      fs.writeFileSync(path.join(outboxDir, '02.json'),
        JSON.stringify({ ts: 't2', text: 'two' }));
      fs.writeFileSync(path.join(outboxDir, '03.json'),
        JSON.stringify({ ts: 't3', text: 'three' }));

      let callCount = 0;
      globalThis.fetch = async () => {
        callCount++;
        // First sendMessage succeeds, all subsequent fail
        if (callCount === 1) {
          return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
        }
        throw new Error('network down');
      };

      const ch = new TelegramChannel({ chatId: CHAT_ID, baseUrl: BASE_URL });
      const result = await ch.drainOutbox(outboxDir);

      assert.strictEqual(result.sent, 1);
      assert.strictEqual(result.remaining, 2);
      // First file deleted, second and third remain
      const remaining = fs.readdirSync(outboxDir).sort();
      assert.deepStrictEqual(remaining, ['02.json', '03.json']);
    });

    test('delete only after successful send', async () => {
      const outboxDir = path.join(tmpDir, 'outbox');
      fs.mkdirSync(outboxDir);
      fs.writeFileSync(path.join(outboxDir, '01.json'),
        JSON.stringify({ ts: 't', text: 'msg' }));

      // All fetches fail (including retries)
      globalThis.fetch = async () => { throw new Error('network down'); };

      const ch = new TelegramChannel({ chatId: CHAT_ID, baseUrl: BASE_URL });
      const result = await ch.drainOutbox(outboxDir);

      assert.strictEqual(result.sent, 0);
      assert.strictEqual(result.remaining, 1);
      // File NOT deleted
      assert.strictEqual(fs.readdirSync(outboxDir).length, 1);
    });

    test('returns {0, 0} for nonexistent dir', async () => {
      const ch = new TelegramChannel({ chatId: CHAT_ID, baseUrl: BASE_URL });
      const result = await ch.drainOutbox(path.join(tmpDir, 'nonexistent'));
      assert.strictEqual(result.sent, 0);
      assert.strictEqual(result.remaining, 0);
    });

    test('returns {0, 0} for empty dir', async () => {
      const outboxDir = path.join(tmpDir, 'outbox');
      fs.mkdirSync(outboxDir);
      const ch = new TelegramChannel({ chatId: CHAT_ID, baseUrl: BASE_URL });
      const result = await ch.drainOutbox(outboxDir);
      assert.strictEqual(result.sent, 0);
      assert.strictEqual(result.remaining, 0);
    });
  });
});

// --- registerCommands ---

describe('registerCommands', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    _setTelegramDelaysForTesting([0, 0]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTelegramDelaysForTesting([1000, 3000]);
  });

  test('calls setMyCommands with /check command', async () => {
    let captured = null;
    globalThis.fetch = async (url, opts) => {
      captured = { url, body: JSON.parse(opts.body) };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
    };

    const ch = new TelegramChannel({ chatId: 123, baseUrl: 'https://mock/bot' });
    await ch.registerCommands();

    assert.ok(captured);
    assert.ok(captured.url.includes('setMyCommands'));
    assert.strictEqual(captured.body.commands.length, 1);
    assert.strictEqual(captured.body.commands[0].command, 'check');
  });

  test('failure is non-fatal (does not throw)', async () => {
    globalThis.fetch = async () => {
      throw new Error('network down');
    };

    const ch = new TelegramChannel({ chatId: 123, baseUrl: 'https://mock/bot' });
    // Should not throw
    await ch.registerCommands();
  });
});

describe('drainOutbox corrupt file handling', () => {
  test('corrupt file is sidetracked to .bad and drain continues', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-bad-'));
    fs.writeFileSync(path.join(dir, '2026-07-18T08-00-00.json'), '{ not valid json');
    fs.writeFileSync(path.join(dir, '2026-07-18T09-00-00.json'), JSON.stringify({ ts: 'x', text: 'ok message' }));

    const sends = [];
    globalThis.fetch = async (url, opts) => {
      sends.push(JSON.parse(opts.body).text);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    };
    const { TelegramChannel } = await import('../src/agent/telegram.js');
    const ch = new TelegramChannel({ token: 't', chatId: 1, baseUrl: 'https://mock.test/bot' });
    const result = await ch.drainOutbox(dir);

    assert.strictEqual(result.sent, 1);
    assert.strictEqual(result.remaining, 0);
    assert.deepStrictEqual(sends, ['ok message']);
    assert.ok(fs.existsSync(path.join(dir, '2026-07-18T08-00-00.json.bad')));
    fs.rmSync(dir, { recursive: true });
  });
});

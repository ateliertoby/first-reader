import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { buildGraphUrl, graphGet, setRetryDelays, _setTokenForTesting } from '../src/graph.js';

describe('buildGraphUrl', () => {
  test('builds messages URL with defaults', () => {
    const url = buildGraphUrl('/me/messages', { top: 20 });
    assert.strictEqual(url, '/me/messages?$top=20');
  });

  test('builds URL with multiple params', () => {
    const url = buildGraphUrl('/me/messages', { top: 10, filter: "isRead eq false", orderby: 'receivedDateTime desc' });
    assert.ok(url.includes('$top=10'));
    assert.ok(url.includes('$filter=isRead eq false'));
    assert.ok(url.includes('$orderby=receivedDateTime desc'));
  });

  test('builds URL with no params', () => {
    const url = buildGraphUrl('/me/mailFolders');
    assert.strictEqual(url, '/me/mailFolders');
  });
});

describe('graphFetch retry', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    _setTokenForTesting('fake-token');
    setRetryDelays([0, 0]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTokenForTesting(null);
    setRetryDelays([2000, 8000]);
  });

  test('succeeds after one 5xx then 200', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 503, json: async () => ({ error: { message: 'Backend Unknown' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ value: 'ok' }) };
    };
    const result = await graphGet('/me/messages');
    assert.deepStrictEqual(result, { value: 'ok' });
    assert.strictEqual(calls, 2);
  });

  test('retries on 429 throttling', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 429, json: async () => ({ error: { message: 'Too many requests' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ value: 'ok' }) };
    };
    const result = await graphGet('/me/messages');
    assert.deepStrictEqual(result, { value: 'ok' });
    assert.strictEqual(calls, 2);
  });

  test('does not retry on 4xx', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: false, status: 404, json: async () => ({ error: { message: 'Not Found' } }) };
    };
    await assert.rejects(
      () => graphGet('/me/messages'),
      (err) => {
        assert.strictEqual(err.message, 'Graph API error: Not Found');
        return true;
      }
    );
    assert.strictEqual(calls, 1);
  });

  test('retries exhausted throws with original error format', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: false, status: 500, json: async () => ({ error: { message: 'Internal Server Error' } }) };
    };
    await assert.rejects(
      () => graphGet('/me/messages'),
      (err) => {
        assert.strictEqual(err.message, 'Graph API error: Internal Server Error');
        return true;
      }
    );
    assert.strictEqual(calls, 3); // 1 initial + 2 retries
  });

  test('retries on network/fetch error', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls < 3) throw new Error('fetch failed');
      return { ok: true, status: 200, json: async () => ({ value: 'recovered' }) };
    };
    const result = await graphGet('/me/messages');
    assert.deepStrictEqual(result, { value: 'recovered' });
    assert.strictEqual(calls, 3);
  });

  test('network errors exhausted throws original error', async () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNRESET');
    };
    await assert.rejects(
      () => graphGet('/me/messages'),
      (err) => {
        assert.strictEqual(err.message, 'ECONNRESET');
        return true;
      }
    );
  });
});

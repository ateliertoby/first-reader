import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  buildInboxListUrl,
  listInboxMessages,
  resolveInboxIndex,
  DEFAULT_INBOX_COUNT
} from '../src/inbox-listing.js';
import { inbox } from '../src/commands/inbox.js';
import { setRetryDelays, _setTokenForTesting } from '../src/graph.js';

describe('buildInboxListUrl', () => {
  test('scopes the listing to the inbox folder', () => {
    const url = buildInboxListUrl();
    assert.ok(url.startsWith('/me/mailFolders/inbox/messages?'));
    assert.ok(!url.startsWith('/me/messages'));
  });

  test('orders newest first and pages 20 by default', () => {
    const url = buildInboxListUrl();
    assert.ok(url.includes('$orderby=receivedDateTime desc'));
    assert.ok(url.includes(`$top=${DEFAULT_INBOX_COUNT}`));
  });

  test('selects the fields the inbox rows are formatted from', () => {
    const url = buildInboxListUrl();
    for (const field of ['id', 'subject', 'from', 'receivedDateTime', 'isRead']) {
      assert.ok(url.includes(field), `missing select field: ${field}`);
    }
  });

  test('honours an explicit count', () => {
    assert.ok(buildInboxListUrl({ count: 50 }).includes('$top=50'));
  });

  test('falls back to the default count for a missing count', () => {
    assert.ok(buildInboxListUrl({ count: undefined }).includes(`$top=${DEFAULT_INBOX_COUNT}`));
  });

  test('adds the unread filter only when asked', () => {
    assert.ok(buildInboxListUrl({ unread: true }).includes('$filter=isRead eq false'));
    assert.ok(!buildInboxListUrl().includes('$filter'));
  });
});

describe('inbox index resolution', () => {
  let originalFetch;
  let requestedUrls;

  function respondWith(messages) {
    globalThis.fetch = async (url) => {
      requestedUrls.push(url);
      return { ok: true, status: 200, json: async () => ({ value: messages }) };
    };
  }

  function message(id) {
    return {
      id,
      subject: `subject ${id}`,
      from: { emailAddress: { name: id, address: `${id}@test.com` } },
      receivedDateTime: '2026-08-24T10:30:00Z',
      isRead: true
    };
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    requestedUrls = [];
    _setTokenForTesting('fake-token');
    setRetryDelays([0, 0]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTokenForTesting(null);
    setRetryDelays([2000, 8000]);
  });

  test('listInboxMessages requests the folder-scoped listing', async () => {
    respondWith([message('a')]);
    const messages = await listInboxMessages();
    assert.deepStrictEqual(messages.map(m => m.id), ['a']);
    assert.ok(requestedUrls[0].includes('/me/mailFolders/inbox/messages'));
  });

  test('resolveInboxIndex returns the message on that row', async () => {
    respondWith([message('a'), message('b'), message('c')]);
    const msg = await resolveInboxIndex('3');
    assert.strictEqual(msg.id, 'c');
  });

  test('resolveInboxIndex pages far enough for an index past the default', async () => {
    respondWith([message('a')]);
    await resolveInboxIndex('1');
    assert.ok(requestedUrls[0].includes(`$top=${DEFAULT_INBOX_COUNT}`));

    requestedUrls.length = 0;
    respondWith(Array.from({ length: 40 }, (_, i) => message(`m${i}`)));
    await resolveInboxIndex('40');
    assert.ok(requestedUrls[0].includes('$top=40'));
  });

  test('resolveInboxIndex rejects a row that was never listed', async () => {
    respondWith([message('a')]);
    const originalExit = process.exit;
    const originalError = console.error;
    const errors = [];
    console.error = (msg) => errors.push(msg);
    process.exit = (code) => { throw new Error(`exit ${code}`); };
    try {
      await assert.rejects(() => resolveInboxIndex('5'), /exit 1/);
      assert.deepStrictEqual(errors, ['Invalid message number: 5']);
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
  });

  test('resolveInboxIndex rejects a non-numeric index without calling Graph', async () => {
    respondWith([message('a')]);
    const originalExit = process.exit;
    const originalError = console.error;
    console.error = () => {};
    process.exit = (code) => { throw new Error(`exit ${code}`); };
    try {
      await assert.rejects(() => resolveInboxIndex('abc'), /exit 1/);
      assert.strictEqual(requestedUrls.length, 0);
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
  });

  // The bug this guards against: the printed row numbers and the numbers the
  // commands accept came from two different Graph collections, so they drifted
  // apart as soon as mail was sorted out of the inbox.
  test('the listing shown and the listing resolved are the same request', async () => {
    respondWith([message('a'), message('b'), message('c')]);
    const originalLog = console.log;
    console.log = () => {};
    try {
      await inbox({ number: '20' });
    } finally {
      console.log = originalLog;
    }
    const shownUrl = requestedUrls[0];

    requestedUrls.length = 0;
    await resolveInboxIndex('3');

    assert.strictEqual(requestedUrls[0], shownUrl);
  });
});

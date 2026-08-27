import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ledgerCommand } from '../src/commands/ledger.js';
import { TransactionDB } from '../src/sorter/db.js';

const SENDER = 'payment.notification@hsbc.com.hk';
// Synthetic references, real shape: the parser only accepts a run of six or
// more digits, and the bank prints eighteen.
const REF_A = '202601010000001001';
const REF_B = '202601010000001002';
const BODY = (ref, amount, memo = 'SUPPLIERPAY') =>
  `Fund transfer credit advice Transaction reference: ${ref}Payment date: 2026-01-01Payer name: A B**** C***** L` +
  `Payment amount: HKD${amount}Credit account number: 000-000XXX-XXXMessage to payee: ${memo}Please log on to HSBC HK App`;

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(feeds = [{ id: 'ride-dispatch', sender: SENDER, memo: 'SUPPLIERPAY', platform: 'ride' }]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-reader-ledger-'));
  tmpDirs.push(dir);
  const rulesPath = path.join(dir, 'rules.json');
  fs.writeFileSync(rulesPath, JSON.stringify({ settings: { minAgeHours: 6 }, guards: [], rules: [], feeds }));
  return {
    dir, rulesPath,
    dbPath: path.join(dir, 'transactions.db'),
    statePath: path.join(dir, 'ledger-state.json'),
    feedDir: path.join(dir, 'feed'),
  };
}

function fakeGraph(messages) {
  // messages: [{ id, receivedDateTime, from, body }]
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (url.includes('/me/messages/')) {
      const id = decodeURIComponent(url.split('/me/messages/')[1].split('?')[0]);
      const m = messages.find(x => x.id === id);
      return { body: { content: m.body, contentType: 'text' } };
    }
    const list = messages.filter(m => m.from === SENDER)
      .map(m => ({ id: m.id, subject: 'Fund transfer credit advice', receivedDateTime: m.receivedDateTime,
                   from: { emailAddress: { address: m.from } } }));
    return { value: list };
  };
  fn.calls = calls;
  return fn;
}

function run(env, graph, extra = {}) {
  return ledgerCommand({ _graphGet: graph, _dbPath: env.dbPath, _statePath: env.statePath,
    _feedDir: env.feedDir, _rulesPath: env.rulesPath, _now: '2026-01-03T00:00:00Z', ...extra });
}

function feedLines(env) {
  const p = path.join(env.feedDir, 'ride-dispatch.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
}

describe('email ledger', () => {
  test('first run without --since initialises the watermark and scans nothing', async () => {
    const env = setup();
    const graph = fakeGraph([{ id: 'm1', receivedDateTime: '2026-01-02T00:00:00Z', from: SENDER, body: BODY(REF_A, '100.00') }]);
    const r = await run(env, graph);
    assert.deepStrictEqual(r, { scanned: 0, recorded: 0, adopted: 0, published: 0, errors: 0 });
    assert.strictEqual(JSON.parse(fs.readFileSync(env.statePath, 'utf8')).processedThrough, '2026-01-03T00:00:00Z');
    assert.strictEqual(graph.calls.length, 0);
  });

  test('--since scans, records and publishes one line per new reference', async () => {
    const env = setup();
    const graph = fakeGraph([
      { id: 'm1', receivedDateTime: '2026-01-02T00:00:00Z', from: SENDER, body: BODY(REF_A, '100.00') },
      { id: 'm2', receivedDateTime: '2026-01-02T01:00:00Z', from: SENDER, body: BODY(REF_B, '2,540.00') },
    ]);
    const r = await run(env, graph, { since: '2026-01-01' });
    assert.deepStrictEqual(r, { scanned: 2, recorded: 2, adopted: 0, published: 2, errors: 0 });
    const lines = feedLines(env);
    assert.strictEqual(lines.length, 2);
    assert.deepStrictEqual(lines[1], {
      v: 1, feed: 'ride-dispatch', ref: REF_B, platform: 'ride', amount: 2540, currency: 'HKD',
      value_date: '2026-01-01', payer: 'A B**** C***** L', memo: 'SUPPLIERPAY', email_id: 'm2',
      received_at: '2026-01-02T01:00:00Z', recorded_at: '2026-01-03T00:00:00Z',
    });
    const db = new TransactionDB(env.dbPath);
    assert.strictEqual(db.list(10).length, 2);
    assert.strictEqual(db.list(10)[0].type, 'income');
    db.close();
    assert.strictEqual(JSON.parse(fs.readFileSync(env.statePath, 'utf8')).processedThrough, '2026-01-03T00:00:00Z');
  });

  test('a second run publishes nothing new, even when the message id changed', async () => {
    const env = setup();
    await run(env, fakeGraph([{ id: 'm1', receivedDateTime: '2026-01-02T00:00:00Z', from: SENDER, body: BODY(REF_A, '100.00') }]), { since: '2026-01-01' });
    const r = await run(env, fakeGraph([{ id: 'm1-moved', receivedDateTime: '2026-01-02T00:00:00Z', from: SENDER, body: BODY(REF_A, '100.00') }]), { since: '2026-01-01' });
    assert.deepStrictEqual(r, { scanned: 1, recorded: 0, adopted: 0, published: 0, errors: 0 });
    assert.strictEqual(feedLines(env).length, 1);
  });

  test('a reference recorded but not yet published is published on the next run', async () => {
    const env = setup();
    const db = new TransactionDB(env.dbPath);
    db.insert({ date: '2026-01-01', merchant: 'A B**** C***** L', amount: 100, currency: 'HKD', source: 'HSBC',
      type: 'income', raw_subject: 's', email_id: 'm1', ref: REF_A, memo: 'SUPPLIERPAY' });
    db.close();
    const r = await run(env, fakeGraph([{ id: 'm1', receivedDateTime: '2026-01-02T00:00:00Z', from: SENDER, body: BODY(REF_A, '100.00') }]), { since: '2026-01-01' });
    assert.deepStrictEqual(r, { scanned: 1, recorded: 0, adopted: 0, published: 1, errors: 0 });
    assert.strictEqual(feedLines(env).length, 1);
  });

  test('only income with the feed memo is published; other mail from the sender is recorded but not published', async () => {
    const env = setup();
    const graph = fakeGraph([
      { id: 'm1', receivedDateTime: '2026-01-02T00:00:00Z', from: SENDER, body: BODY(REF_A, '100.00', 'OTHER') },
      { id: 'm2', receivedDateTime: '2026-01-02T00:00:00Z', from: SENDER, body: '將 HKD200.00 轉往 SOMEONE。' },
    ]);
    const r = await run(env, graph, { since: '2026-01-01' });
    assert.deepStrictEqual(r, { scanned: 2, recorded: 2, adopted: 0, published: 0, errors: 0 });
    assert.deepStrictEqual(feedLines(env), []);
  });

  test('a durable trailing fragment is closed off instead of being appended onto', async () => {
    // The writer's own append is atomic, so this state only arrives from
    // outside: an interrupted write, a truncated restore, a hand edit.
    const env = setup();
    const feedPath = path.join(env.feedDir, 'ride-dispatch.jsonl');
    fs.mkdirSync(env.feedDir, { recursive: true });
    fs.writeFileSync(feedPath, '{"v":1,"ref":"X"');
    const r = await run(env, fakeGraph([
      { id: 'm1', receivedDateTime: '2026-01-02T00:00:00Z', from: SENDER, body: BODY(REF_A, '100.00') },
    ]), { since: '2026-01-01' });
    assert.strictEqual(r.published, 1);
    const text = fs.readFileSync(feedPath, 'utf8');
    assert.ok(text.endsWith('\n'));
    const lines = text.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0], '{"v":1,"ref":"X"');
    assert.strictEqual(JSON.parse(lines[1]).ref, REF_A);
    // The fragment stays unreadable, which is the consumer's cue to log it;
    // the new credit is a complete line of its own.
    const parsed = lines.flatMap(l => { try { return [JSON.parse(l).ref]; } catch { return []; } });
    assert.deepStrictEqual(parsed, [REF_A]);
  });

  test('a credit the sorter already recorded without a reference is adopted, not duplicated', async () => {
    const env = setup();
    const db = new TransactionDB(env.dbPath);
    // What the old parser stored: amount only, typed as a payment, dated by the
    // email, keyed by the pre-move message id.
    db.insert({ date: '2026-01-02', merchant: null, amount: 100, currency: 'HKD', source: 'HSBC',
      type: 'payment', raw_subject: 'Fund transfer credit advice', email_id: 'pre-move-id' });
    db.close();
    const r = await run(env, fakeGraph([
      { id: 'post-move-id', receivedDateTime: '2026-01-02T00:00:00Z', from: SENDER, body: BODY(REF_A, '100.00') },
    ]), { since: '2026-01-01' });
    assert.deepStrictEqual(r, { scanned: 1, recorded: 0, adopted: 1, published: 1, errors: 0 });
    const check = new TransactionDB(env.dbPath);
    const rows = check.list(10);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].ref, REF_A);
    assert.strictEqual(rows[0].type, 'income');
    assert.strictEqual(rows[0].email_id, 'post-move-id');
    check.close();
    assert.strictEqual(feedLines(env).length, 1);
  });

  test('watermark uses a one hour overlap from the previous run', async () => {
    const env = setup();
    fs.writeFileSync(env.statePath, JSON.stringify({ processedThrough: '2026-01-02T12:00:00Z' }));
    const graph = fakeGraph([]);
    await run(env, graph);
    assert.match(graph.calls[0], /receivedDateTime ge 2026-01-02T11:00:00/);
  });

  test('a Graph failure leaves the watermark alone and reports an error', async () => {
    const env = setup();
    fs.writeFileSync(env.statePath, JSON.stringify({ processedThrough: '2026-01-02T12:00:00Z' }));
    const graph = async () => { throw new Error('503'); };
    const r = await run(env, graph);
    assert.strictEqual(r.errors, 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(env.statePath, 'utf8')).processedThrough, '2026-01-02T12:00:00Z');
  });

  test('--dry-run writes nothing', async () => {
    const env = setup();
    const r = await run(env, fakeGraph([{ id: 'm1', receivedDateTime: '2026-01-02T00:00:00Z', from: SENDER, body: BODY(REF_A, '100.00') }]), { since: '2026-01-01', dryRun: true });
    assert.deepStrictEqual(r, { scanned: 1, recorded: 1, adopted: 0, published: 1, errors: 0 });
    assert.strictEqual(fs.existsSync(env.dbPath), false);
    assert.strictEqual(fs.existsSync(env.feedDir), false);
    assert.strictEqual(fs.existsSync(env.statePath), false);
  });

  test('no feeds configured: nothing scanned', async () => {
    const env = setup([]);
    const r = await run(env, fakeGraph([]), { since: '2026-01-01' });
    assert.deepStrictEqual(r, { scanned: 0, recorded: 0, adopted: 0, published: 0, errors: 0 });
  });
});

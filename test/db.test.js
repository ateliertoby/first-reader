import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { TransactionDB } from '../src/sorter/db.js';

describe('TransactionDB', () => {
  let tmpDir, db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-reader-test-'));
    db = new TransactionDB(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  let dbSeq = 0;
  function tmpDbPath() {
    return path.join(tmpDir, `case-${dbSeq++}.db`);
  }

  test('creates transactions table on init', () => {
    const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    assert.ok(tables.some(t => t.name === 'transactions'));
  });

  test('inserts a transaction', () => {
    db.insert({
      date: '2026-03-07',
      merchant: 'SUPERMART',
      amount: 350.00,
      currency: 'HKD',
      source: 'Mox',
      type: 'payment',
      raw_subject: 'Mox Card交易成功',
      email_id: 'abc123'
    });
    const rows = db.db.prepare('SELECT * FROM transactions').all();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].merchant, 'SUPERMART');
    assert.strictEqual(rows[0].amount, 350.00);
  });

  test('rejects duplicate email_id', () => {
    const tx = {
      date: '2026-03-07', merchant: 'TEST', amount: 100,
      currency: 'HKD', source: 'Test', type: 'payment',
      raw_subject: 'test', email_id: 'dup123'
    };
    db.insert(tx);
    const inserted = db.insert(tx);
    assert.strictEqual(inserted, false);
  });

  test('lists transactions', () => {
    db.insert({
      date: '2026-03-07', merchant: 'A', amount: 100,
      currency: 'HKD', source: 'Mox', type: 'payment',
      raw_subject: 'test', email_id: 'id1'
    });
    db.insert({
      date: '2026-03-06', merchant: 'B', amount: 200,
      currency: 'HKD', source: 'HSBC', type: 'transfer',
      raw_subject: 'test', email_id: 'id2'
    });
    const rows = db.list(10);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].merchant, 'A'); // newest first
  });

  test('same source+ref from two message ids is one row', () => {
    const fresh = new TransactionDB(tmpDbPath());
    const base = {
      date: '2026-01-01', merchant: 'A B**** C***** L', amount: 1234.5, currency: 'HKD',
      source: 'HSBC', type: 'income', raw_subject: 'advice',
      ref: '202601010001234567', memo: 'SUPPLIERPAY'
    };
    assert.strictEqual(fresh.insert({ ...base, email_id: 'id-inbox' }), true);
    assert.strictEqual(fresh.insert({ ...base, email_id: 'id-after-move' }), false);
    assert.strictEqual(fresh.list(10).length, 1);
    assert.strictEqual(fresh.list(10)[0].ref, '202601010001234567');
    assert.strictEqual(fresh.list(10)[0].memo, 'SUPPLIERPAY');
    assert.strictEqual(fresh.hasRef('HSBC', '202601010001234567'), true);
    assert.strictEqual(fresh.hasRef('HSBC', '999'), false);
    fresh.close();
  });

  test('rows without ref still dedupe by email_id only', () => {
    const fresh = new TransactionDB(tmpDbPath());
    const base = {
      date: '2026-01-01', merchant: 'SHOP', amount: 10, currency: 'HKD',
      source: 'Mox', type: 'payment', raw_subject: 's'
    };
    assert.strictEqual(fresh.insert({ ...base, email_id: 'a' }), true);
    assert.strictEqual(fresh.insert({ ...base, email_id: 'b' }), true);
    assert.strictEqual(fresh.insert({ ...base, email_id: 'a' }), false);
    fresh.close();
  });

  test('adoptLegacy upgrades the row the sorter recorded without a reference', () => {
    const fresh = new TransactionDB(tmpDbPath());
    fresh.insert({
      date: '2026-01-02', merchant: null, amount: 1234.5, currency: 'HKD', source: 'HSBC',
      type: 'payment', raw_subject: 'Fund transfer credit advice轉賬存款通知書', email_id: 'old-inbox-id'
    });
    const tx = {
      date: '2026-01-01', merchant: 'A B**** C***** L', amount: 1234.5, currency: 'HKD',
      source: 'HSBC', type: 'income', raw_subject: 'Fund transfer credit advice轉賬存款通知書',
      ref: '202601010001234567', memo: 'SUPPLIERPAY'
    };
    assert.strictEqual(fresh.adoptLegacy(tx, 'post-move-id'), true);
    const rows = fresh.list(10);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].ref, '202601010001234567');
    assert.strictEqual(rows[0].memo, 'SUPPLIERPAY');
    assert.strictEqual(rows[0].type, 'income');
    assert.strictEqual(rows[0].merchant, 'A B**** C***** L');
    assert.strictEqual(rows[0].date, '2026-01-01');
    assert.strictEqual(rows[0].email_id, 'post-move-id');
    // Nothing left to adopt the second time round.
    assert.strictEqual(fresh.adoptLegacy(tx, 'post-move-id'), false);
    fresh.close();
  });

  test('adoptLegacy leaves a row dated well after the payment alone', () => {
    const fresh = new TransactionDB(tmpDbPath());
    fresh.insert({
      date: '2026-01-06', merchant: null, amount: 1234.5, currency: 'HKD', source: 'HSBC',
      type: 'payment', raw_subject: 'Fund transfer credit advice轉賬存款通知書', email_id: 'old-inbox-id'
    });
    const adopted = fresh.adoptLegacy({
      date: '2026-01-01', merchant: 'A B**** C***** L', amount: 1234.5, currency: 'HKD',
      source: 'HSBC', type: 'income', raw_subject: 'Fund transfer credit advice轉賬存款通知書',
      ref: '202601010001234567', memo: 'SUPPLIERPAY'
    }, 'post-move-id');
    assert.strictEqual(adopted, false);
    assert.strictEqual(fresh.list(10)[0].ref, null);
    fresh.close();
  });

  test('adoptLegacy leaves the legacy row alone when the reference is already taken', () => {
    const fresh = new TransactionDB(tmpDbPath());
    const ref = '202601010001234567';
    fresh.insert({
      date: '2026-01-01', merchant: 'A B**** C***** L', amount: 1234.5, currency: 'HKD',
      source: 'HSBC', type: 'income', raw_subject: 'Fund transfer credit advice轉賬存款通知書',
      email_id: 'ledger-id', ref, memo: 'SUPPLIERPAY'
    });
    fresh.insert({
      date: '2026-01-02', merchant: null, amount: 1234.5, currency: 'HKD', source: 'HSBC',
      type: 'payment', raw_subject: 'Fund transfer credit advice轉賬存款通知書', email_id: 'old-inbox-id'
    });
    const adopted = fresh.adoptLegacy({
      date: '2026-01-01', merchant: 'A B**** C***** L', amount: 1234.5, currency: 'HKD',
      source: 'HSBC', type: 'income', raw_subject: 'Fund transfer credit advice轉賬存款通知書',
      ref, memo: 'SUPPLIERPAY'
    }, 'post-move-id');
    assert.strictEqual(adopted, false);
    const legacy = fresh.db.prepare("SELECT * FROM transactions WHERE email_id = 'old-inbox-id'").get();
    assert.strictEqual(legacy.ref, null);
    assert.strictEqual(legacy.type, 'payment');
    fresh.close();
  });

  test('an existing database gains the ref and memo columns on open', () => {
    const dbPath = tmpDbPath();
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE transactions (id INTEGER PRIMARY KEY, date TEXT NOT NULL, merchant TEXT,
      amount REAL NOT NULL, currency TEXT DEFAULT 'HKD', source TEXT NOT NULL, type TEXT, raw_subject TEXT,
      email_id TEXT UNIQUE, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    raw.close();
    const migrated = new TransactionDB(dbPath);
    assert.strictEqual(migrated.insert({
      date: '2026-01-01', merchant: null, amount: 1, currency: 'HKD', source: 'HSBC',
      type: 'income', raw_subject: 's', email_id: 'x', ref: 'r1', memo: null
    }), true);
    migrated.close();
  });
});

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TransactionDB } from '../src/sorter/db.js';

describe('TransactionDB', () => {
  let tmpDir, db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-cli-test-'));
    db = new TransactionDB(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

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
});

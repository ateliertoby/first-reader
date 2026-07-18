import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TransactionDB, SortLogDB } from '../src/sorter/db.js';
import { reparseCommand } from '../src/commands/reparse.js';

describe('reparse command', () => {
  let tmpDir, dbPath, logDb, txDb;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-cli-reparse-'));
    dbPath = path.join(tmpDir, 'test.db');
    logDb = new SortLogDB(dbPath);
    txDb = new TransactionDB(dbPath);
  });

  afterEach(() => {
    logDb.close();
    txDb.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  function insertNoparse(overrides = {}) {
    const base = {
      run_at: '2026-07-13T10:00:00Z',
      email_id: 'msg-fal-001',
      sender: 'billing@fal.ai',
      domain: 'fal.ai',
      subject: 'Payment Confirmation',
      subject_key: 'payment confirmation',
      received_at: '2026-07-13T02:30:00Z',
      bucket: 'accounting',
      rule_id: 'fal-ai',
      action: 'moved',
      parsed: 0
    };
    logDb.insert({ ...base, ...overrides });
    return { ...base, ...overrides };
  }

  function runReparse({ fakeGraphGet, sender, dry = false }) {
    return reparseCommand({
      sender, dry,
      _dbPath: dbPath,
      _graphGet: fakeGraphGet,
    });
  }

  test('reparse flips parsed flag and inserts transaction', async () => {
    insertNoparse();

    const fakeGraphGet = async () => ({
      body: {
        contentType: 'html',
        content: '<div>Order Confirmation Hi Alex Chan! You have successfully added $10.00 to your balance.</div>'
      }
    });

    const result = await runReparse({ fakeGraphGet });
    assert.strictEqual(result.parsed, 1);

    // Verify parsed flag updated in sort_log
    const row = logDb.db.prepare(`SELECT parsed FROM sort_log WHERE email_id = 'msg-fal-001' AND action = 'moved'`).get();
    assert.strictEqual(row.parsed, 1);

    // Verify transaction inserted
    const txRows = txDb.list(10);
    assert.strictEqual(txRows.length, 1);
    assert.strictEqual(txRows[0].amount, 10.00);
    assert.strictEqual(txRows[0].currency, 'USD');
    assert.strictEqual(txRows[0].source, 'fal.ai');
  });

  test('reparse with --dry does not write to DB', async () => {
    insertNoparse();

    const fakeGraphGet = async () => ({
      body: {
        contentType: 'html',
        content: '<div>You have successfully added $10.00 to your balance.</div>'
      }
    });

    const result = await runReparse({ fakeGraphGet, dry: true });
    assert.strictEqual(result.parsed, 1);

    // Verify parsed flag NOT updated
    const row = logDb.db.prepare(`SELECT parsed FROM sort_log WHERE email_id = 'msg-fal-001' AND action = 'moved'`).get();
    assert.strictEqual(row.parsed, 0);

    // Verify no transaction inserted
    assert.strictEqual(txDb.list(10).length, 0);
  });

  test('reparse skips duplicate transaction (UNIQUE constraint)', async () => {
    insertNoparse();

    // Pre-insert the transaction
    txDb.insert({
      date: '2026-07-13',
      merchant: 'fal.ai',
      amount: 10.00,
      currency: 'USD',
      source: 'fal.ai',
      type: 'topup',
      raw_subject: 'Payment Confirmation',
      email_id: 'msg-fal-001'
    });

    const fakeGraphGet = async () => ({
      body: {
        contentType: 'html',
        content: '<div>You have successfully added $10.00 to your balance.</div>'
      }
    });

    const result = await runReparse({ fakeGraphGet });
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(result.parsed, 0);
  });

  test('reparse leaves NOPARSE rows unchanged', async () => {
    insertNoparse({ sender: 'unknown@example.com', email_id: 'msg-unknown' });

    const fakeGraphGet = async () => ({
      body: { contentType: 'text', content: 'No parseable content here' }
    });

    const result = await runReparse({ fakeGraphGet });
    assert.strictEqual(result.noparse, 1);

    // parsed flag stays 0
    const row = logDb.db.prepare(`SELECT parsed FROM sort_log WHERE email_id = 'msg-unknown' AND action = 'moved'`).get();
    assert.strictEqual(row.parsed, 0);
  });

  test('reparse handles Graph API errors per-row without aborting', async () => {
    insertNoparse({ email_id: 'msg-err' });
    insertNoparse({ email_id: 'msg-ok', sender: 'billing@fal.ai' });

    const fakeGraphGet = async (reqPath) => {
      if (reqPath.includes('msg-err')) throw new Error('404 Not Found');
      return {
        body: {
          contentType: 'html',
          content: '<div>You have successfully added $25.00 to your balance.</div>'
        }
      };
    };

    const result = await runReparse({ fakeGraphGet });
    assert.strictEqual(result.errors, 1);
    assert.strictEqual(result.parsed, 1);
  });

  test('reparse --sender filters by sender substring', async () => {
    insertNoparse({ email_id: 'msg-fal', sender: 'billing@fal.ai' });
    insertNoparse({ email_id: 'msg-other', sender: 'noreply@other.com' });

    const fakeGraphGet = async () => ({
      body: {
        contentType: 'html',
        content: '<div>You have successfully added $10.00 to your balance.</div>'
      }
    });

    const result = await runReparse({ fakeGraphGet, sender: 'fal.ai' });
    // Only the fal.ai row should be processed
    assert.strictEqual(result.parsed, 1);
    assert.strictEqual(result.noparse, 0);

    // msg-other still parsed=0
    const row = logDb.db.prepare(`SELECT parsed FROM sort_log WHERE email_id = 'msg-other' AND action = 'moved'`).get();
    assert.strictEqual(row.parsed, 0);
  });

  test('reparse cleans zero-width wall before parsing', async () => {
    insertNoparse();

    // Simulate the actual fal.ai email with zero-width wall
    const zwWall = '​'.repeat(200) + '&#65279;'.repeat(100);
    const fakeGraphGet = async () => ({
      body: {
        contentType: 'html',
        content: '<div>' + zwWall + 'Order Confirmation Hi Alex Chan! You have successfully added $10.00 to your balance.</div>'
      }
    });

    const result = await runReparse({ fakeGraphGet });
    assert.strictEqual(result.parsed, 1);
    const txRows = txDb.list(10);
    assert.strictEqual(txRows[0].amount, 10.00);
  });
});

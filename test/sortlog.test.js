import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SortLogDB } from '../src/sorter/db.js';

describe('SortLogDB', () => {
  let tmpDir, db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-cli-sortlog-'));
    db = new SortLogDB(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('creates sort_log table on init', () => {
    const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    assert.ok(tables.some(t => t.name === 'sort_log'));
  });

  test('inserts a log entry', () => {
    const inserted = db.insert({
      run_at: '2026-07-13T10:00:00Z',
      email_id: 'msg-001',
      sender: 'user@mox.com',
      domain: 'mox.com',
      subject: 'Mox Card交易成功',
      subject_key: 'mox card交易成功',
      received_at: '2026-07-13T09:00:00Z',
      bucket: 'accounting',
      rule_id: 'mox-tx',
      action: 'moved',
      parsed: 1
    });
    assert.strictEqual(inserted, true);
  });

  test('deduplicates on email_id + action', () => {
    const entry = {
      run_at: '2026-07-13T10:00:00Z',
      email_id: 'msg-001',
      sender: 'user@mox.com',
      domain: 'mox.com',
      subject: 'test',
      subject_key: 'test',
      received_at: '2026-07-13T09:00:00Z',
      bucket: 'accounting',
      rule_id: 'mox-tx',
      action: 'moved',
      parsed: 1
    };
    db.insert(entry);
    const second = db.insert(entry);
    assert.strictEqual(second, false);
  });

  test('same email_id with different action inserts', () => {
    const base = {
      run_at: '2026-07-13T10:00:00Z',
      email_id: 'msg-001',
      sender: 'user@mox.com',
      domain: 'mox.com',
      subject: 'test',
      subject_key: 'test',
      received_at: '2026-07-13T09:00:00Z',
      bucket: 'accounting',
      rule_id: 'mox-tx',
      parsed: null
    };
    db.insert({ ...base, action: 'moved', parsed: 1 });
    const second = db.insert({ ...base, action: 'unsorted' });
    assert.strictEqual(second, true);
  });

  test('movedSince filters by time', () => {
    db.insert({
      run_at: '2026-07-12T10:00:00Z', email_id: 'old',
      sender: 'a@x.com', domain: 'x.com', subject: 's', subject_key: 's',
      received_at: '2026-07-12T09:00:00Z', bucket: 'notifications',
      rule_id: 'github', action: 'moved', parsed: null
    });
    db.insert({
      run_at: '2026-07-13T10:00:00Z', email_id: 'new',
      sender: 'b@x.com', domain: 'x.com', subject: 's2', subject_key: 's#',
      received_at: '2026-07-13T09:00:00Z', bucket: 'notifications',
      rule_id: 'github', action: 'moved', parsed: null
    });
    const rows = db.movedSince('2026-07-13T00:00:00Z');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].email_id, 'new');
  });

  test('movedSince filters by ruleId', () => {
    db.insert({
      run_at: '2026-07-13T10:00:00Z', email_id: 'a',
      sender: 'a@mox.com', domain: 'mox.com', subject: 's', subject_key: 's',
      received_at: '2026-07-13T09:00:00Z', bucket: 'accounting',
      rule_id: 'mox-tx', action: 'moved', parsed: 1
    });
    db.insert({
      run_at: '2026-07-13T10:00:00Z', email_id: 'b',
      sender: 'b@github.com', domain: 'github.com', subject: 's2', subject_key: 's#',
      received_at: '2026-07-13T09:00:00Z', bucket: 'notifications',
      rule_id: 'github', action: 'moved', parsed: null
    });
    const rows = db.movedSince('2026-07-13T00:00:00Z', { ruleId: 'mox-tx' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].rule_id, 'mox-tx');
  });

  test('keptSince returns kept rows', () => {
    db.insert({
      run_at: '2026-07-13T10:00:00Z', email_id: 'kept1',
      sender: 'a@unknown.com', domain: 'unknown.com', subject: 'hello', subject_key: 'hello',
      received_at: '2026-07-13T09:00:00Z', bucket: null,
      rule_id: null, action: 'kept', parsed: null
    });
    const rows = db.keptSince('2026-07-13T00:00:00Z');
    assert.strictEqual(rows.length, 1);
  });

  test('domainHistory counts kept for a domain', () => {
    db.insert({
      run_at: '2026-07-10T10:00:00Z', email_id: 'k1',
      sender: 'a@test.com', domain: 'test.com', subject: 's1', subject_key: 's#',
      received_at: '2026-07-10T09:00:00Z', bucket: null,
      rule_id: null, action: 'kept', parsed: null
    });
    db.insert({
      run_at: '2026-07-11T10:00:00Z', email_id: 'k2',
      sender: 'b@test.com', domain: 'test.com', subject: 's2', subject_key: 's#',
      received_at: '2026-07-11T09:00:00Z', bucket: null,
      rule_id: null, action: 'kept', parsed: null
    });
    db.insert({
      run_at: '2026-07-11T10:00:00Z', email_id: 'm1',
      sender: 'c@test.com', domain: 'test.com', subject: 's3', subject_key: 's#',
      received_at: '2026-07-11T09:00:00Z', bucket: 'notifications',
      rule_id: 'x', action: 'moved', parsed: null
    });
    assert.strictEqual(db.domainHistory('test.com'), 2);
  });

  test('isNovelSubject detects new subject keys', () => {
    db.insert({
      run_at: '2026-07-10T10:00:00Z', email_id: 'old1',
      sender: 'a@mox.com', domain: 'mox.com', subject: 'Mox Card交易成功',
      subject_key: 'mox card交易成功', received_at: '2026-07-10T09:00:00Z',
      bucket: 'accounting', rule_id: 'mox-tx', action: 'moved', parsed: 1
    });
    // Known subject_key before cutoff
    assert.strictEqual(db.isNovelSubject('mox-tx', 'mox card交易成功', '2026-07-13T00:00:00Z'), false);
    // Unknown subject_key
    assert.strictEqual(db.isNovelSubject('mox-tx', 'some new subject', '2026-07-13T00:00:00Z'), true);
  });

  test('listUnsortable excludes already unsorted', () => {
    db.insert({
      run_at: '2026-07-13T10:00:00Z', email_id: 'msg-a',
      sender: 'a@x.com', domain: 'x.com', subject: 's', subject_key: 's',
      received_at: '2026-07-13T09:00:00Z', bucket: 'notifications',
      rule_id: 'github', action: 'moved', parsed: null
    });
    db.insert({
      run_at: '2026-07-13T10:00:00Z', email_id: 'msg-b',
      sender: 'b@x.com', domain: 'x.com', subject: 's2', subject_key: 's#',
      received_at: '2026-07-13T09:00:00Z', bucket: 'notifications',
      rule_id: 'github', action: 'moved', parsed: null
    });
    // Mark msg-a as unsorted
    db.insert({
      run_at: '2026-07-13T11:00:00Z', email_id: 'msg-a',
      sender: 'a@x.com', domain: 'x.com', subject: 's', subject_key: 's',
      received_at: '2026-07-13T09:00:00Z', bucket: 'notifications',
      rule_id: 'github', action: 'unsorted', parsed: null
    });
    const rows = db.listUnsortable({});
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].email_id, 'msg-b');
  });
});

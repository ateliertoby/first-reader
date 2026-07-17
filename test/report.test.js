import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { groupMoved, groupKept, markNovelty } from '../src/commands/report.js';
import { SortLogDB } from '../src/sorter/db.js';

describe('report grouping', () => {
  const mockConfig = {
    guards: [],
    rules: [
      { id: 'mox-tx', bucket: 'accounting', domains: ['mox.com'], subjectRe: /交易/i, probationUntil: null },
      { id: 'github', bucket: 'notifications', domains: ['github.com'], subjectRe: null, probationUntil: null },
      { id: 'new-rule', bucket: 'notifications', domains: ['new.com'], subjectRe: null, probationUntil: '2026-07-20' }
    ]
  };

  test('groupMoved groups by ruleId', () => {
    const rows = [
      { action: 'moved', rule_id: 'mox-tx', bucket: 'accounting', subject: '交易1' },
      { action: 'moved', rule_id: 'mox-tx', bucket: 'accounting', subject: '交易2' },
      { action: 'moved', rule_id: 'github', bucket: 'notifications', subject: 'PR' },
      { action: 'kept', rule_id: null, bucket: null, subject: 'other' }
    ];
    const groups = groupMoved(rows, mockConfig);
    assert.strictEqual(groups.length, 2);
    const mox = groups.find(g => g.ruleId === 'mox-tx');
    assert.strictEqual(mox.count, 2);
    assert.strictEqual(mox.bucket, 'accounting');
    const gh = groups.find(g => g.ruleId === 'github');
    assert.strictEqual(gh.count, 1);
  });

  test('groupMoved includes subjects for probation rules', () => {
    const rows = [
      { action: 'moved', rule_id: 'new-rule', bucket: 'notifications', subject: 'Welcome' },
      { action: 'moved', rule_id: 'new-rule', bucket: 'notifications', subject: 'Update' }
    ];
    const groups = groupMoved(rows, mockConfig, '2026-07-13T00:00:00Z');
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].probation, '2026-07-20');
    assert.deepStrictEqual(groups[0].subjects, ['Welcome', 'Update']);
  });

  test('groupMoved treats expired probation as normal rule', () => {
    const rows = [
      { action: 'moved', rule_id: 'new-rule', bucket: 'notifications', subject: 'Welcome' }
    ];
    const groups = groupMoved(rows, mockConfig, '2026-08-01T00:00:00Z');
    assert.strictEqual(groups[0].probation, null);
    assert.deepStrictEqual(groups[0].subjects, []);
  });

  test('groupMoved collects rows for novelty detection', () => {
    const rows = [
      { action: 'moved', rule_id: 'github', bucket: 'notifications', subject: 'PR 1', subject_key: 'pr #' },
      { action: 'moved', rule_id: 'github', bucket: 'notifications', subject: 'PR 2', subject_key: 'pr #' }
    ];
    const groups = groupMoved(rows, mockConfig, '2026-07-13T00:00:00Z');
    assert.strictEqual(groups[0]._rows.length, 2);
  });

  test('markNovelty flags subjects unseen before window', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sortlog-')), 't.db');
    const logDb = new SortLogDB(dbPath);
    // history: github rule saw "release notes #" before the window
    logDb.insert({
      run_at: '2026-07-01T00:00:00Z', email_id: 'old1', sender: 'x@github.com',
      domain: 'github.com', subject: 'Release notes 1', subject_key: 'release notes #',
      received_at: '2026-07-01T00:00:00Z', bucket: 'notifications', rule_id: 'github',
      action: 'moved', parsed: null
    });
    const groups = groupMoved([
      { action: 'moved', rule_id: 'github', bucket: 'notifications', subject: 'Release notes 2', subject_key: 'release notes #' },
      { action: 'moved', rule_id: 'github', bucket: 'notifications', subject: 'Security advisory', subject_key: 'security advisory' }
    ], mockConfig, '2026-07-13T00:00:00Z');
    markNovelty(groups, logDb, '2026-07-12T00:00:00Z');
    logDb.close();
    assert.deepStrictEqual(groups[0].noveltySubjects, ['Security advisory']);
  });

  test('groupKept groups by domain with samples', () => {
    const rows = [
      { action: 'kept', domain: 'example.com', subject: 'A', received_at: '2026-07-13T01:00:00Z' },
      { action: 'kept', domain: 'example.com', subject: 'B', received_at: '2026-07-13T02:00:00Z' },
      { action: 'kept', domain: 'example.com', subject: 'C', received_at: '2026-07-13T03:00:00Z' },
      { action: 'kept', domain: 'example.com', subject: 'D', received_at: '2026-07-13T04:00:00Z' },
      { action: 'kept', domain: 'other.com', subject: 'X', received_at: '2026-07-13T01:00:00Z' },
      { action: 'moved', domain: 'moved.com', subject: 'Y', received_at: '2026-07-13T01:00:00Z' }
    ];
    const groups = groupKept(rows);
    assert.strictEqual(groups.length, 2);
    const ex = groups.find(g => g.domain === 'example.com');
    assert.strictEqual(ex.count, 4);
    assert.strictEqual(ex.samples.length, 3); // capped at 3
    const ot = groups.find(g => g.domain === 'other.com');
    assert.strictEqual(ot.count, 1);
  });

  test('groupKept sorts by count descending', () => {
    const rows = [
      { action: 'kept', domain: 'a.com', subject: '1', received_at: '' },
      { action: 'kept', domain: 'b.com', subject: '2', received_at: '' },
      { action: 'kept', domain: 'b.com', subject: '3', received_at: '' }
    ];
    const groups = groupKept(rows);
    assert.strictEqual(groups[0].domain, 'b.com');
  });

  test('markNovelty skips rule with no pre-window history (bootstrap gate)', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sortlog-')), 't.db');
    const logDb = new SortLogDB(dbPath);
    // NO pre-window history for 'hsbc-tx' — rule is brand new
    const groups = groupMoved([
      { action: 'moved', rule_id: 'hsbc-tx', bucket: 'accounting', subject: 'HSBC payment', subject_key: 'hsbc payment' },
      { action: 'moved', rule_id: 'hsbc-tx', bucket: 'accounting', subject: 'HSBC transfer', subject_key: 'hsbc transfer' }
    ], mockConfig, '2026-07-13T00:00:00Z');
    markNovelty(groups, logDb, '2026-07-12T00:00:00Z');
    logDb.close();
    // Without the bootstrap gate, both subjects would be flagged as novel
    assert.deepStrictEqual(groups[0].noveltySubjects, []);
  });

  test('markNovelty reports novel subjects for rule WITH pre-window history', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sortlog-')), 't.db');
    const logDb = new SortLogDB(dbPath);
    // Pre-window history exists for 'github'
    logDb.insert({
      run_at: '2026-07-01T00:00:00Z', email_id: 'hist1', sender: 'x@github.com',
      domain: 'github.com', subject: 'PR merged', subject_key: 'pr merged',
      received_at: '2026-07-01T00:00:00Z', bucket: 'notifications', rule_id: 'github',
      action: 'moved', parsed: null
    });
    const groups = groupMoved([
      { action: 'moved', rule_id: 'github', bucket: 'notifications', subject: 'PR merged #2', subject_key: 'pr merged' },
      { action: 'moved', rule_id: 'github', bucket: 'notifications', subject: 'New: Dependabot', subject_key: 'new: dependabot' }
    ], mockConfig, '2026-07-13T00:00:00Z');
    markNovelty(groups, logDb, '2026-07-12T00:00:00Z');
    logDb.close();
    // 'pr merged' is known, 'new: dependabot' is novel
    assert.deepStrictEqual(groups[0].noveltySubjects, ['New: Dependabot']);
  });

  test('runErrors included in report rows', () => {
    // Verify run-error rows are filtered correctly from a mixed set
    const rows = [
      { action: 'moved', rule_id: 'github', bucket: 'notifications', subject: 'PR' },
      { action: 'kept', rule_id: null, bucket: null, subject: 'hello', domain: 'x.com', received_at: '' },
      { action: 'run-error', run_at: '2026-07-13T10:00:00Z', email_id: 'run-2026-07-13T10:00:00Z', subject: 'Graph API error: Backend Unknown', sender: null, domain: null },
      { action: 'run-error', run_at: '2026-07-13T14:00:00Z', email_id: 'run-2026-07-13T14:00:00Z', subject: 'ECONNRESET', sender: null, domain: null }
    ];
    const runErrors = rows.filter(r => r.action === 'run-error');
    assert.strictEqual(runErrors.length, 2);
    assert.strictEqual(runErrors[0].subject, 'Graph API error: Backend Unknown');
    assert.strictEqual(runErrors[1].subject, 'ECONNRESET');
    // Ensure run-errors don't leak into other groups
    const moved = groupMoved(rows, mockConfig);
    assert.strictEqual(moved.length, 1);
    const kept = groupKept(rows);
    assert.strictEqual(kept.length, 1);
  });
});

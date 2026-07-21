import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentDB } from '../src/agent/db.js';

describe('AgentDB', () => {
  let tmpDir, db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-reader-agent-'));
    db = new AgentDB(path.join(tmpDir, 'agent.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('creates all tables on init', () => {
    const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const names = tables.map(t => t.name);
    for (const expected of ['agent_questions', 'agent_reminders', 'junk_dismissed', 'agent_engagement', 'agent_runs', 'pending_renders', 'agent_state', 'agent_seen']) {
      assert.ok(names.includes(expected), `missing table: ${expected}`);
    }
  });

  // --- Questions ---

  describe('questions', () => {
    test('addQuestion inserts and openQuestions returns it', () => {
      const added = db.addQuestion({ domain: 'billing', question: 'Keep or sort?', now: '2026-07-18T08:00:00Z' });
      assert.strictEqual(added, true);
      const open = db.openQuestions();
      assert.strictEqual(open.length, 1);
      assert.strictEqual(open[0].domain, 'billing');
      assert.strictEqual(open[0].question, 'Keep or sort?');
      assert.strictEqual(open[0].status, 'open');
    });

    test('addQuestion with null domain always inserts', () => {
      db.addQuestion({ domain: null, question: 'q1', now: '2026-07-18T08:00:00Z' });
      const added = db.addQuestion({ domain: null, question: 'q2', now: '2026-07-18T08:01:00Z' });
      assert.strictEqual(added, true);
      assert.strictEqual(db.openQuestions().length, 2);
    });

    test('dedupe: skips if open question for same domain exists', () => {
      db.addQuestion({ domain: 'billing', question: 'q1', now: '2026-07-18T08:00:00Z' });
      const second = db.addQuestion({ domain: 'billing', question: 'q2', now: '2026-07-18T08:01:00Z' });
      assert.strictEqual(second, false);
      assert.strictEqual(db.openQuestions().length, 1);
    });

    test('dedupe allows after answering previous question', () => {
      db.addQuestion({ domain: 'billing', question: 'q1', now: '2026-07-18T08:00:00Z' });
      const q = db.openQuestions()[0];
      db.answerQuestion(q.id, 'sort it', '2026-07-18T09:00:00Z');
      const added = db.addQuestion({ domain: 'billing', question: 'q2', now: '2026-07-18T10:00:00Z' });
      assert.strictEqual(added, true);
    });

    test('different domains do not collide', () => {
      db.addQuestion({ domain: 'billing', question: 'q1', now: '2026-07-18T08:00:00Z' });
      const added = db.addQuestion({ domain: 'shipping', question: 'q2', now: '2026-07-18T08:01:00Z' });
      assert.strictEqual(added, true);
      assert.strictEqual(db.openQuestions().length, 2);
    });

    test('answerQuestion marks answered', () => {
      db.addQuestion({ domain: 'billing', question: 'q1', now: '2026-07-18T08:00:00Z' });
      const q = db.openQuestions()[0];
      const ok = db.answerQuestion(q.id, 'keep', '2026-07-18T09:00:00Z');
      assert.strictEqual(ok, true);
      assert.strictEqual(db.openQuestions().length, 0);
    });

    test('answerQuestion returns false for non-open question', () => {
      db.addQuestion({ domain: 'd', question: 'q', now: '2026-07-18T08:00:00Z' });
      const q = db.openQuestions()[0];
      db.answerQuestion(q.id, 'a', '2026-07-18T09:00:00Z');
      const again = db.answerQuestion(q.id, 'b', '2026-07-18T10:00:00Z');
      assert.strictEqual(again, false);
    });

    test('expireQuestions expires questions older than 7 days', () => {
      // asked_at exactly 7 days before "now" -> cutoff = now - 7d = asked_at -> should expire (<=)
      db.addQuestion({ domain: 'd1', question: 'old', now: '2026-07-11T08:00:00Z' });
      // asked_at 6 days 23 hours before "now" -> should NOT expire
      db.addQuestion({ domain: 'd2', question: 'recent', now: '2026-07-11T09:00:00Z' });
      const count = db.expireQuestions('2026-07-18T08:00:00Z');
      assert.strictEqual(count, 1);
      const open = db.openQuestions();
      assert.strictEqual(open.length, 1);
      assert.strictEqual(open[0].domain, 'd2');
    });

    test('expireQuestions boundary: exactly 7 days ago expires', () => {
      db.addQuestion({ domain: 'edge', question: 'boundary', now: '2026-07-11T12:00:00.000Z' });
      // now = exactly 7 days later
      const count = db.expireQuestions('2026-07-18T12:00:00.000Z');
      assert.strictEqual(count, 1);
      assert.strictEqual(db.openQuestions().length, 0);
    });

    test('expireQuestions boundary: 1ms before 7 days does not expire', () => {
      db.addQuestion({ domain: 'edge', question: 'boundary', now: '2026-07-11T12:00:00.001Z' });
      const count = db.expireQuestions('2026-07-18T12:00:00.000Z');
      assert.strictEqual(count, 0);
      assert.strictEqual(db.openQuestions().length, 1);
    });
  });

  // --- Reminders ---

  describe('reminders', () => {
    test('addReminder inserts and openReminders returns it', () => {
      const added = db.addReminder({
        kind: 'hketoll-reminder', source_email_id: 'email-001',
        subject: 'Toll payment due', now: '2026-07-18T08:00:00Z'
      });
      assert.strictEqual(added, true);
      const open = db.openReminders();
      assert.strictEqual(open.length, 1);
      assert.strictEqual(open[0].kind, 'hketoll-reminder');
      assert.strictEqual(open[0].source_email_id, 'email-001');
      assert.strictEqual(open[0].status, 'open');
    });

    test('OR IGNORE dedupe on source_email_id', () => {
      db.addReminder({
        kind: 'hketoll-reminder', source_email_id: 'email-001',
        subject: 'Toll 1', now: '2026-07-18T08:00:00Z'
      });
      const second = db.addReminder({
        kind: 'hketoll-reminder', source_email_id: 'email-001',
        subject: 'Toll 1 rescan', now: '2026-07-18T09:00:00Z'
      });
      assert.strictEqual(second, false);
      assert.strictEqual(db.openReminders().length, 1);
    });

    test('different source_email_id inserts both', () => {
      db.addReminder({
        kind: 'hketoll-reminder', source_email_id: 'email-001',
        subject: 'Toll 1', now: '2026-07-18T08:00:00Z'
      });
      db.addReminder({
        kind: 'hketoll-reminder', source_email_id: 'email-002',
        subject: 'Toll 2', now: '2026-07-18T09:00:00Z'
      });
      assert.strictEqual(db.openReminders().length, 2);
    });

    test('resolveReminder marks resolved', () => {
      db.addReminder({
        kind: 'test', source_email_id: 'e1',
        subject: 's', now: '2026-07-18T08:00:00Z'
      });
      const r = db.openReminders()[0];
      const ok = db.resolveReminder(r.id, 'alex', '2026-07-18T10:00:00Z');
      assert.strictEqual(ok, true);
      assert.strictEqual(db.openReminders().length, 0);
    });

    test('resolveReminder returns false for non-open', () => {
      db.addReminder({ kind: 'test', source_email_id: 'e1', subject: 's', now: '2026-07-18T08:00:00Z' });
      const r = db.openReminders()[0];
      db.resolveReminder(r.id, 'alex', '2026-07-18T10:00:00Z');
      const again = db.resolveReminder(r.id, 'auto', '2026-07-18T11:00:00Z');
      assert.strictEqual(again, false);
    });

    test('expireReminders expires open > 14 days and returns rows', () => {
      db.addReminder({ kind: 'old', source_email_id: 'e-old', subject: 'old', now: '2026-07-01T08:00:00Z' });
      db.addReminder({ kind: 'fresh', source_email_id: 'e-fresh', subject: 'fresh', now: '2026-07-18T07:00:00Z' });
      const expired = db.expireReminders('2026-07-18T08:00:00Z');
      assert.strictEqual(expired.length, 1);
      assert.strictEqual(expired[0].source_email_id, 'e-old');
      // Verify DB state
      const open = db.openReminders();
      assert.strictEqual(open.length, 1);
      assert.strictEqual(open[0].source_email_id, 'e-fresh');
    });

    test('expireReminders returns expired rows with their data', () => {
      db.addReminder({ kind: 'hketoll-reminder', source_email_id: 'e-x', subject: 'Toll overdue', now: '2026-07-01T00:00:00Z' });
      const expired = db.expireReminders('2026-07-18T08:00:00Z');
      assert.strictEqual(expired.length, 1);
      assert.strictEqual(expired[0].kind, 'hketoll-reminder');
      assert.strictEqual(expired[0].subject, 'Toll overdue');
    });

    test('expireReminders boundary: exactly 14 days ago expires', () => {
      db.addReminder({ kind: 'edge', source_email_id: 'e-edge', subject: 'boundary', now: '2026-07-04T12:00:00.000Z' });
      const expired = db.expireReminders('2026-07-18T12:00:00.000Z');
      assert.strictEqual(expired.length, 1);
    });

    test('openReminders returns created_at for caller to compute age', () => {
      db.addReminder({ kind: 'test', source_email_id: 'e1', subject: 's', now: '2026-07-15T08:00:00Z' });
      const open = db.openReminders();
      assert.strictEqual(open[0].created_at, '2026-07-15T08:00:00Z');
    });
  });

  // --- Junk ---

  describe('junk', () => {
    test('dismissJunk + isJunkDismissed', () => {
      assert.strictEqual(db.isJunkDismissed('junk-001'), false);
      db.dismissJunk('junk-001', '2026-07-18T08:00:00Z');
      assert.strictEqual(db.isJunkDismissed('junk-001'), true);
    });

    test('dismissJunk is idempotent (OR IGNORE)', () => {
      db.dismissJunk('junk-001', '2026-07-18T08:00:00Z');
      db.dismissJunk('junk-001', '2026-07-18T09:00:00Z');
      assert.strictEqual(db.isJunkDismissed('junk-001'), true);
      // Only one row
      const count = db.db.prepare('SELECT COUNT(*) as c FROM junk_dismissed WHERE email_id = ?').get('junk-001').c;
      assert.strictEqual(count, 1);
    });

    test('isJunkDismissed returns false for unknown', () => {
      assert.strictEqual(db.isJunkDismissed('nonexistent'), false);
    });
  });

  // --- Engagement ---

  describe('engagement', () => {
    test('logEngagement inserts and engagementSince returns it', () => {
      db.logEngagement('2026-07-18T08:00:00Z', 'reply');
      db.logEngagement('2026-07-18T09:00:00Z', 'command');
      const rows = db.engagementSince('2026-07-18T07:00:00Z');
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].kind, 'reply');
    });

    test('engagementSince filters by timestamp', () => {
      db.logEngagement('2026-07-17T08:00:00Z', 'reply');
      db.logEngagement('2026-07-18T08:00:00Z', 'command');
      const rows = db.engagementSince('2026-07-18T00:00:00Z');
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].kind, 'command');
    });

    test('logEngagement rejects invalid kind', () => {
      assert.throws(() => db.logEngagement('2026-07-18T08:00:00Z', 'invalid'), {
        message: /Invalid engagement kind: invalid/
      });
    });

    test('logEngagement accepts all valid kinds', () => {
      db.logEngagement('2026-07-18T08:00:00Z', 'reply');
      db.logEngagement('2026-07-18T08:01:00Z', 'command');
      db.logEngagement('2026-07-18T08:02:00Z', 'spontaneous');
      assert.strictEqual(db.engagementSince('2026-07-18T00:00:00Z').length, 3);
    });
  });

  // --- Runs ---

  describe('runs', () => {
    test('logRun inserts and lastRun returns it', () => {
      db.logRun({
        run_at: '2026-07-18T08:30:00Z', kind: 'report',
        window_start: '2026-07-17T08:30:00Z', window_end: '2026-07-18T08:30:00Z',
        status: 'ok', detail: null
      });
      const last = db.lastRun('report');
      assert.ok(last);
      assert.strictEqual(last.kind, 'report');
      assert.strictEqual(last.status, 'ok');
    });

    test('lastRun picks most recent of that kind', () => {
      db.logRun({
        run_at: '2026-07-17T08:30:00Z', kind: 'report',
        window_start: null, window_end: null, status: 'ok', detail: null
      });
      db.logRun({
        run_at: '2026-07-18T08:30:00Z', kind: 'report',
        window_start: null, window_end: null, status: 'degraded', detail: 'API down'
      });
      db.logRun({
        run_at: '2026-07-18T10:00:00Z', kind: 'audit',
        window_start: null, window_end: null, status: 'ok', detail: null
      });
      const lastReport = db.lastRun('report');
      assert.strictEqual(lastReport.status, 'degraded');
      assert.strictEqual(lastReport.run_at, '2026-07-18T08:30:00Z');

      const lastAudit = db.lastRun('audit');
      assert.strictEqual(lastAudit.kind, 'audit');
    });

    test('lastRun returns null when no runs', () => {
      assert.strictEqual(db.lastRun('report'), null);
    });

    test('logRun rejects invalid kind', () => {
      assert.throws(() => db.logRun({
        run_at: '2026-07-18T08:30:00Z', kind: 'unknown',
        window_start: null, window_end: null, status: 'ok', detail: null
      }), { message: /Invalid run kind: unknown/ });
    });

    test('logRun rejects invalid status', () => {
      assert.throws(() => db.logRun({
        run_at: '2026-07-18T08:30:00Z', kind: 'report',
        window_start: null, window_end: null, status: 'broken', detail: null
      }), { message: /Invalid run status: broken/ });
    });

    test('lastRun rejects invalid kind', () => {
      assert.throws(() => db.lastRun('invalid'), {
        message: /Invalid run kind: invalid/
      });
    });
  });

  // --- State KV ---

  describe('state KV', () => {
    test('getState returns null for missing key', () => {
      assert.strictEqual(db.getState('nonexistent'), null);
    });

    test('setState + getState round-trip', () => {
      db.setState('read_watermark', '2026-07-18T08:00:00Z');
      assert.strictEqual(db.getState('read_watermark'), '2026-07-18T08:00:00Z');
    });

    test('setState overwrites existing value', () => {
      db.setState('read_watermark', '2026-07-17T00:00:00Z');
      db.setState('read_watermark', '2026-07-18T08:00:00Z');
      assert.strictEqual(db.getState('read_watermark'), '2026-07-18T08:00:00Z');
    });
  });

  // --- Seen dedupe ---

  describe('seen dedupe', () => {
    test('isSeen returns false for unknown', () => {
      assert.strictEqual(db.isSeen('inet-unknown'), false);
    });

    test('markSeen + isSeen round-trip', () => {
      db.markSeen('inet-001', '2026-07-18T08:00:00Z');
      assert.strictEqual(db.isSeen('inet-001'), true);
    });

    test('markSeen is idempotent (OR IGNORE)', () => {
      db.markSeen('inet-001', '2026-07-18T08:00:00Z');
      db.markSeen('inet-001', '2026-07-18T09:00:00Z');
      assert.strictEqual(db.isSeen('inet-001'), true);
    });

    test('pruneSeen removes entries older than 14 days', () => {
      db.markSeen('inet-old', '2026-07-01T00:00:00Z');
      db.markSeen('inet-recent', '2026-07-18T00:00:00Z');
      const pruned = db.pruneSeen('2026-07-18T08:00:00Z');
      assert.strictEqual(pruned, 1);
      assert.strictEqual(db.isSeen('inet-old'), false);
      assert.strictEqual(db.isSeen('inet-recent'), true);
    });
  });

  // --- Atomic watermark + pending + seen ---

  describe('insertPendingWithWatermark', () => {
    test('atomically sets watermark, inserts pending, and records seen', () => {
      db.insertPendingWithWatermark({
        pending: {
          created_at: '2026-07-18T08:30:00Z', origin: 'check',
          window_start: '2026-07-17T08:30:00Z', window_end: '2026-07-18T08:15:00Z',
          request_id: 'req-1', report_json: '{}', status: 'open',
        },
        watermark: '2026-07-18T08:15:00Z',
        seen: [
          { id: 'inet-a', ts: '2026-07-18T08:30:00Z' },
          { id: 'inet-b', ts: '2026-07-18T08:30:00Z' },
        ],
      });

      assert.strictEqual(db.getState('read_watermark'), '2026-07-18T08:15:00Z');
      assert.strictEqual(db.openPendings().length, 1);
      assert.strictEqual(db.isSeen('inet-a'), true);
      assert.strictEqual(db.isSeen('inet-b'), true);
    });

    test('rolls back entirely on invalid pending status', () => {
      assert.throws(() => {
        db.insertPendingWithWatermark({
          pending: {
            created_at: '2026-07-18T08:30:00Z', origin: 'check',
            window_start: '2026-07-17T08:30:00Z', window_end: '2026-07-18T08:15:00Z',
            request_id: 'req-bad', report_json: '{}', status: 'invalid',
          },
          watermark: '2026-07-18T08:15:00Z',
          seen: [{ id: 'inet-c', ts: '2026-07-18T08:30:00Z' }],
        });
      });

      // All rolled back
      assert.strictEqual(db.getState('read_watermark'), null);
      assert.strictEqual(db.openPendings().length, 0);
      assert.strictEqual(db.isSeen('inet-c'), false);
    });
  });
});

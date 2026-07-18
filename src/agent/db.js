import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const VALID_ENGAGEMENT_KINDS = new Set(['reply', 'command', 'spontaneous']);
const VALID_RUN_KINDS = new Set(['report', 'audit']);
const VALID_RUN_STATUSES = new Set(['ok', 'degraded', 'failed']);

export class AgentDB {
  constructor(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_questions (
        id INTEGER PRIMARY KEY,
        asked_at TEXT NOT NULL,
        domain TEXT,
        question TEXT NOT NULL,
        status TEXT NOT NULL,
        answer TEXT,
        answered_at TEXT
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_reminders (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_email_id TEXT UNIQUE,
        subject TEXT,
        status TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS junk_dismissed (
        id INTEGER PRIMARY KEY,
        email_id TEXT UNIQUE,
        dismissed_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_engagement (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id INTEGER PRIMARY KEY,
        run_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        window_start TEXT,
        window_end TEXT,
        status TEXT NOT NULL,
        detail TEXT
      )
    `);

    // Questions
    this._addQuestion = this.db.prepare(`
      INSERT INTO agent_questions (asked_at, domain, question, status)
      VALUES (@asked_at, @domain, @question, 'open')
    `);
    this._openQuestionByDomain = this.db.prepare(
      `SELECT 1 FROM agent_questions WHERE domain = @domain AND status = 'open' LIMIT 1`
    );
    this._openQuestions = this.db.prepare(
      `SELECT * FROM agent_questions WHERE status = 'open' ORDER BY asked_at`
    );
    this._answerQuestion = this.db.prepare(
      `UPDATE agent_questions SET status = 'answered', answer = @answer, answered_at = @answered_at WHERE id = @id AND status = 'open'`
    );
    this._expireQuestions = this.db.prepare(
      `UPDATE agent_questions SET status = 'expired' WHERE status = 'open' AND julianday(asked_at) <= julianday(@cutoff)`
    );

    // Reminders
    this._addReminder = this.db.prepare(`
      INSERT OR IGNORE INTO agent_reminders (created_at, kind, source_email_id, subject, status)
      VALUES (@created_at, @kind, @source_email_id, @subject, 'open')
    `);
    this._openReminders = this.db.prepare(
      `SELECT * FROM agent_reminders WHERE status = 'open' ORDER BY created_at`
    );
    this._resolveReminder = this.db.prepare(
      `UPDATE agent_reminders SET status = 'resolved', resolved_at = @resolved_at, resolved_by = @resolved_by WHERE id = @id AND status = 'open'`
    );
    this._expireReminders = this.db.prepare(
      `SELECT * FROM agent_reminders WHERE status = 'open' AND julianday(created_at) <= julianday(@cutoff)`
    );
    this._markRemindersExpired = this.db.prepare(
      `UPDATE agent_reminders SET status = 'expired', resolved_by = 'expired' WHERE status = 'open' AND julianday(created_at) <= julianday(@cutoff)`
    );

    // Junk
    this._dismissJunk = this.db.prepare(
      `INSERT OR IGNORE INTO junk_dismissed (email_id, dismissed_at) VALUES (@email_id, @dismissed_at)`
    );
    this._isJunkDismissed = this.db.prepare(
      `SELECT 1 FROM junk_dismissed WHERE email_id = @email_id LIMIT 1`
    );

    // Engagement
    this._logEngagement = this.db.prepare(
      `INSERT INTO agent_engagement (ts, kind) VALUES (@ts, @kind)`
    );
    this._engagementSince = this.db.prepare(
      `SELECT * FROM agent_engagement WHERE ts >= @ts ORDER BY ts`
    );

    // Runs
    this._logRun = this.db.prepare(`
      INSERT INTO agent_runs (run_at, kind, window_start, window_end, status, detail)
      VALUES (@run_at, @kind, @window_start, @window_end, @status, @detail)
    `);
    this._lastRun = this.db.prepare(
      `SELECT * FROM agent_runs WHERE kind = @kind ORDER BY run_at DESC LIMIT 1`
    );
  }

  // --- Questions ---

  addQuestion({ domain, question, now }) {
    if (domain != null) {
      const existing = this._openQuestionByDomain.get({ domain });
      if (existing) return false;
    }
    this._addQuestion.run({ asked_at: now, domain: domain ?? null, question });
    return true;
  }

  openQuestions() {
    return this._openQuestions.all();
  }

  answerQuestion(id, answer, now) {
    const result = this._answerQuestion.run({ id, answer, answered_at: now });
    return result.changes > 0;
  }

  expireQuestions(now) {
    const cutoff = _subtractDays(now, 7);
    const result = this._expireQuestions.run({ cutoff });
    return result.changes;
  }

  // --- Reminders ---

  addReminder({ kind, source_email_id, subject, now }) {
    const result = this._addReminder.run({
      created_at: now, kind, source_email_id, subject: subject ?? null
    });
    return result.changes > 0;
  }

  openReminders() {
    return this._openReminders.all();
  }

  resolveReminder(id, resolvedBy, now) {
    const result = this._resolveReminder.run({ id, resolved_by: resolvedBy, resolved_at: now });
    return result.changes > 0;
  }

  expireReminders(now) {
    const cutoff = _subtractDays(now, 14);
    const rows = this._expireReminders.all({ cutoff });
    this._markRemindersExpired.run({ cutoff });
    return rows;
  }

  // --- Junk ---

  dismissJunk(emailId, now) {
    this._dismissJunk.run({ email_id: emailId, dismissed_at: now });
  }

  isJunkDismissed(emailId) {
    return !!this._isJunkDismissed.get({ email_id: emailId });
  }

  // --- Engagement ---

  logEngagement(ts, kind) {
    if (!VALID_ENGAGEMENT_KINDS.has(kind)) {
      throw new Error(`Invalid engagement kind: ${kind} (expected: ${[...VALID_ENGAGEMENT_KINDS].join(', ')})`);
    }
    this._logEngagement.run({ ts, kind });
  }

  engagementSince(ts) {
    return this._engagementSince.all({ ts });
  }

  // --- Runs ---

  logRun({ run_at, kind, window_start, window_end, status, detail }) {
    if (!VALID_RUN_KINDS.has(kind)) {
      throw new Error(`Invalid run kind: ${kind} (expected: ${[...VALID_RUN_KINDS].join(', ')})`);
    }
    if (!VALID_RUN_STATUSES.has(status)) {
      throw new Error(`Invalid run status: ${status} (expected: ${[...VALID_RUN_STATUSES].join(', ')})`);
    }
    this._logRun.run({
      run_at, kind,
      window_start: window_start ?? null,
      window_end: window_end ?? null,
      status,
      detail: detail ?? null
    });
  }

  lastRun(kind) {
    if (!VALID_RUN_KINDS.has(kind)) {
      throw new Error(`Invalid run kind: ${kind} (expected: ${[...VALID_RUN_KINDS].join(', ')})`);
    }
    return this._lastRun.get({ kind }) ?? null;
  }

  close() {
    this.db.close();
  }
}

function _subtractDays(isoString, days) {
  const d = new Date(isoString);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

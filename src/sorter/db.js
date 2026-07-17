import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

export class TransactionDB {
  constructor(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY,
        date TEXT NOT NULL,
        merchant TEXT,
        amount REAL NOT NULL,
        currency TEXT DEFAULT 'HKD',
        source TEXT NOT NULL,
        type TEXT,
        raw_subject TEXT,
        email_id TEXT UNIQUE,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this._insert = this.db.prepare(`
      INSERT OR IGNORE INTO transactions (date, merchant, amount, currency, source, type, raw_subject, email_id)
      VALUES (@date, @merchant, @amount, @currency, @source, @type, @raw_subject, @email_id)
    `);

    this._list = this.db.prepare('SELECT * FROM transactions ORDER BY date DESC, id DESC LIMIT ?');
  }

  insert(tx) {
    const result = this._insert.run(tx);
    return result.changes > 0;
  }

  list(limit = 50) {
    return this._list.all(limit);
  }

  close() {
    this.db.close();
  }
}

export class SortLogDB {
  constructor(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sort_log (
        id INTEGER PRIMARY KEY,
        run_at TEXT NOT NULL,
        email_id TEXT NOT NULL,
        sender TEXT, domain TEXT, subject TEXT, subject_key TEXT,
        received_at TEXT,
        bucket TEXT, rule_id TEXT,
        action TEXT NOT NULL,
        parsed INTEGER,
        UNIQUE(email_id, action)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sortlog_rule ON sort_log(rule_id, subject_key)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sortlog_domain ON sort_log(domain, run_at)`);

    this._insert = this.db.prepare(`
      INSERT OR IGNORE INTO sort_log (run_at, email_id, sender, domain, subject, subject_key, received_at, bucket, rule_id, action, parsed)
      VALUES (@run_at, @email_id, @sender, @domain, @subject, @subject_key, @received_at, @bucket, @rule_id, @action, @parsed)
    `);
  }

  insert(entry) {
    const result = this._insert.run(entry);
    return result.changes > 0;
  }

  isUnsorted(emailId) {
    const row = this.db.prepare(
      `SELECT 1 FROM sort_log WHERE email_id = ? AND action = 'unsorted' LIMIT 1`
    ).get(emailId);
    return !!row;
  }

  movedSince(since, { ruleId, sender, domain } = {}) {
    let sql = `SELECT * FROM sort_log WHERE action = 'moved' AND run_at >= ?`;
    const params = [since];
    if (ruleId) { sql += ' AND rule_id = ?'; params.push(ruleId); }
    if (sender) { sql += ' AND sender = ?'; params.push(sender); }
    if (domain) { sql += ' AND domain = ?'; params.push(domain); }
    return this.db.prepare(sql).all(...params);
  }

  keptSince(since) {
    return this.db.prepare(
      `SELECT * FROM sort_log WHERE action = 'kept' AND run_at >= ?`
    ).all(since);
  }

  domainHistory(domain) {
    return this.db.prepare(
      `SELECT COUNT(*) as count FROM sort_log WHERE domain = ? AND action = 'kept'`
    ).get(domain).count;
  }

  isNovelSubject(ruleId, subjectKey, before) {
    const row = this.db.prepare(
      `SELECT 1 FROM sort_log WHERE rule_id = ? AND subject_key = ? AND run_at < ? LIMIT 1`
    ).get(ruleId, subjectKey, before);
    return !row;
  }

  ruleHasMovedBefore(ruleId, before) {
    const row = this.db.prepare(
      `SELECT 1 FROM sort_log WHERE rule_id = ? AND action = 'moved' AND run_at < ? LIMIT 1`
    ).get(ruleId, before);
    return !!row;
  }

  listUnsortable({ sender, ruleId, emailId, since } = {}) {
    let sql = `SELECT * FROM sort_log WHERE action = 'moved' AND email_id NOT IN (SELECT email_id FROM sort_log WHERE action = 'unsorted')`;
    const params = [];
    if (sender) { sql += ' AND sender = ?'; params.push(sender); }
    if (ruleId) { sql += ' AND rule_id = ?'; params.push(ruleId); }
    if (emailId) { sql += ' AND email_id = ?'; params.push(emailId); }
    if (since) { sql += ' AND run_at >= ?'; params.push(since); }
    return this.db.prepare(sql).all(...params);
  }

  close() {
    this.db.close();
  }
}

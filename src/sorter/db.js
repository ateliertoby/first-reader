import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

// The sorter records an accounting email before it moves it, so a credit advice
// it filed under an older parser sits in the table with no reference, keyed by
// the pre-move message id, and dated by the email rather than by the payment.
// The ledger meets that same email later under its post-move id, which is why
// matching is on the event (source, amount, subject, date range) and not on id.
const LEGACY_MATCH = `SELECT id FROM transactions
   WHERE source = @source AND ref IS NULL
     AND abs(amount - @amount) < 0.005
     AND raw_subject = @raw_subject
     AND date BETWEEN @lo AND @hi
   ORDER BY id LIMIT 1`;

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function legacyParams(tx) {
  // The old row's date is the email's received date, never earlier than the
  // payment date and, given the bank sends the advice the next morning, within
  // a couple of days of it.
  return {
    source: tx.source,
    amount: tx.amount,
    raw_subject: tx.raw_subject ?? '',
    lo: tx.date,
    hi: addDays(tx.date, 2)
  };
}

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

    // Databases created before the reference columns existed migrate on open;
    // ALTER is the only migration mechanism this project has.
    for (const col of ['ref TEXT', 'memo TEXT']) {
      try { this.db.exec(`ALTER TABLE transactions ADD COLUMN ${col}`); } catch { /* already present */ }
    }
    // The same bank event can be recorded under two message ids, because a
    // message id changes when the message is moved between folders. The
    // provider's reference is the identity whenever there is one; rows without
    // a reference are left to dedupe by email_id alone, hence the partial index.
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_source_ref
                  ON transactions(source, ref) WHERE ref IS NOT NULL`);

    this._insert = this.db.prepare(`
      INSERT OR IGNORE INTO transactions (date, merchant, amount, currency, source, type, raw_subject, email_id, ref, memo)
      VALUES (@date, @merchant, @amount, @currency, @source, @type, @raw_subject, @email_id, @ref, @memo)
    `);

    this._list = this.db.prepare('SELECT * FROM transactions ORDER BY date DESC, id DESC LIMIT ?');
    this._hasRef = this.db.prepare('SELECT 1 FROM transactions WHERE source = ? AND ref = ? LIMIT 1');
    this._findLegacy = this.db.prepare(LEGACY_MATCH);
    // OR IGNORE: when the reference already sits on another row, the legacy row
    // is left as it is rather than aborting the run on the unique index.
    this._adoptLegacy = this.db.prepare(`
      UPDATE OR IGNORE transactions
         SET ref = @ref, memo = @memo, type = @type, merchant = @merchant,
             date = @date, email_id = @email_id
       WHERE id = (${LEGACY_MATCH})
    `);
  }

  insert(tx) {
    // Parsers that know nothing about references keep working unchanged.
    const result = this._insert.run({ ref: null, memo: null, ...tx });
    return result.changes > 0;
  }

  hasRef(source, ref) {
    return !!this._hasRef.get(source, ref);
  }

  findLegacy(tx) {
    if (!tx.ref) return null;
    return this._findLegacy.get(legacyParams(tx))?.id ?? null;
  }

  // Upgrade in place the one row that recorded this same event without a
  // reference, so a re-read under a newer parser does not duplicate it.
  adoptLegacy(tx, emailId) {
    if (!tx.ref) return false;
    const result = this._adoptLegacy.run({
      ...legacyParams(tx),
      ref: tx.ref,
      memo: tx.memo ?? null,
      type: tx.type,
      merchant: tx.merchant ?? null,
      date: tx.date,
      email_id: emailId
    });
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

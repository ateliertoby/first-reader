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

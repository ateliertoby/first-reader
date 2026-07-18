import { graphGet } from '../graph.js';
import { parseTransaction } from '../sorter/parsers.js';
import { htmlToText } from '../sorter/html-text.js';
import { TransactionDB, SortLogDB } from '../sorter/db.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'transactions.db');

// Re-parse accounting emails that moved but yielded no transaction (parsed=0).
// Generic channel: add a parser, then reparse --sender X to backfill.
export async function reparseCommand(options = {}) {
  const dry = options.dry || false;
  // Test injection points (underscore = internal)
  const dbPath = options._dbPath ?? DB_PATH;
  const graphGetFn = options._graphGet ?? graphGet;
  const logDb = new SortLogDB(dbPath);
  const txDb = dry ? null : new TransactionDB(dbPath);

  try {
    // sort_log.id is INTEGER PRIMARY KEY (rowid alias)
    let sql = `SELECT * FROM sort_log WHERE action = 'moved' AND bucket = 'accounting' AND parsed = 0`;
    const params = [];
    if (options.sender) {
      sql += ` AND sender LIKE ?`;
      params.push(`%${options.sender}%`);
    }

    const rows = logDb.db.prepare(sql).all(...params);
    if (rows.length === 0) {
      console.log('No unparsed accounting emails to reparse.');
      return { parsed: 0, skipped: 0, noparse: 0, errors: 0 };
    }

    console.log(`Found ${rows.length} unparsed accounting email(s).${dry ? ' (dry run)' : ''}`);

    let parsed = 0, skipped = 0, noparse = 0, errors = 0;

    for (const row of rows) {
      try {
        const fullMsg = await graphGetFn(`/me/messages/${row.email_id}`);
        const body = htmlToText(fullMsg.body?.content, fullMsg.body?.contentType);
        const tx = parseTransaction(row.sender, row.subject, body, row.received_at);

        if (tx) {
          if (!dry) {
            const inserted = txDb.insert({ ...tx, raw_subject: row.subject, email_id: row.email_id });
            if (!inserted) {
              console.log(`  SKIP-dup ${row.sender} — ${row.subject}`);
              skipped++;
              continue;
            }
            logDb.db.prepare('UPDATE sort_log SET parsed = 1 WHERE id = ?').run(row.id);
          }
          console.log(`  PARSED $${tx.amount} ${tx.currency} ${tx.merchant || tx.source} — ${row.subject}`);
          parsed++;
        } else {
          console.log(`  NOPARSE ${row.sender} — ${row.subject}`);
          noparse++;
        }
      } catch (err) {
        console.log(`  ERROR ${row.email_id} — ${err.message}`);
        errors++;
      }
    }

    console.log(`\nReparse: ${parsed} parsed, ${skipped} dup-skipped, ${noparse} still-noparse, ${errors} errors.`);
    return { parsed, skipped, noparse, errors };
  } finally {
    logDb.close();
    if (txDb) txDb.close();
  }
}

import { TransactionDB } from '../sorter/db.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'transactions.db');

export async function transactions(options) {
  const db = new TransactionDB(DB_PATH);
  const limit = parseInt(options.number) || 20;
  const rows = db.list(limit);
  db.close();

  if (rows.length === 0) {
    console.log('No transactions recorded.');
    return;
  }

  for (const row of rows) {
    const amount = `${row.currency} ${row.amount.toFixed(2)}`.padStart(15);
    const merchant = (row.merchant || '—').padEnd(25).slice(0, 25);
    const source = row.source.padEnd(12).slice(0, 12);
    console.log(`${row.date}  ${source}  ${merchant}  ${amount}`);
  }
  console.log(`\n${rows.length} transactions.`);
}

import { graphGet as realGraphGet, buildGraphUrl } from '../graph.js';
import { loadRules } from '../sorter/rules.js';
import { parseTransaction } from '../sorter/parsers.js';
import { htmlToText } from '../sorter/html-text.js';
import { TransactionDB } from '../sorter/db.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'transactions.db');
const STATE_PATH = path.join(DATA_DIR, 'ledger-state.json');
const FEED_DIR = path.join(DATA_DIR, 'feed');
const OVERLAP_MS = 3600_000;

// Scan window. Same idea as the sorter's: a watermark with a one-hour overlap
// absorbs clock skew between the mail server and this machine, and the
// reference dedupe absorbs the repeat. There is no dwell here — this pass
// records, it never moves mail, so nothing has to be visible to a human first.
export function ledgerWindow({ state, since, now }) {
  if (since) return { start: since.includes('T') ? since : `${since}T00:00:00Z`, end: now };
  if (state?.processedThrough) {
    return { start: new Date(new Date(state.processedThrough).getTime() - OVERLAP_MS).toISOString(), end: now };
  }
  return { initialize: true };
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function saveState(statePath, now) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ processedThrough: now }, null, 2));
}

function publishedRefs(feedPath) {
  // The feed file, not the transactions table, is the record of what has been
  // published: a crash between insert and append is repaired by the next run
  // re-reading it. A trailing fragment without a newline is a line the writer
  // has not finished, so it is not a published reference.
  if (!fs.existsSync(feedPath)) return new Set();
  const text = fs.readFileSync(feedPath, 'utf8');
  const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
  const refs = new Set();
  for (const line of complete.split('\n')) {
    if (!line) continue;
    try { refs.add(JSON.parse(line).ref); } catch { /* corrupt line: never a published ref */ }
  }
  return refs;
}

function ensureTerminated(feedPath) {
  // An interrupted write can leave a durable line without its newline; appending
  // onto it would fuse two records into one line neither side can read.
  if (!fs.existsSync(feedPath)) return;
  const size = fs.statSync(feedPath).size;
  if (size === 0) return;
  const fd = fs.openSync(feedPath, 'r');
  try {
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    if (last[0] !== 0x0a) fs.appendFileSync(feedPath, '\n');
  } finally {
    fs.closeSync(fd);
  }
}

async function fetchSenderMessages(graphGetFn, sender, start) {
  // /me/messages spans every folder, so a message the sorter has already filed
  // into Accounting is still found. The combined receivedDateTime + sender
  // filter with an orderby is accepted by the mail server (verified against the
  // live mailbox); if it ever starts being rejected as an inefficient filter,
  // drop the sender clause and rely on the client-side filter below.
  const params = {
    top: 100,
    select: 'id,subject,from,receivedDateTime',
    filter: `receivedDateTime ge ${start} and from/emailAddress/address eq '${sender}'`,
    orderby: 'receivedDateTime asc'
  };
  let result = await graphGetFn(buildGraphUrl('/me/messages', params));
  const messages = [...result.value];
  while (result['@odata.nextLink']) {
    result = await graphGetFn(result['@odata.nextLink']);
    messages.push(...result.value);
  }
  return messages.filter(m => (m.from?.emailAddress?.address || '').toLowerCase() === sender);
}

export async function ledgerCommand(options = {}) {
  const dryRun = options.dryRun || false;
  const graphGetFn = options._graphGet ?? realGraphGet;
  const dbPath = options._dbPath ?? DB_PATH;
  const statePath = options._statePath ?? STATE_PATH;
  const feedDir = options._feedDir ?? FEED_DIR;
  const now = options._now ?? new Date().toISOString();
  const totals = { scanned: 0, recorded: 0, adopted: 0, published: 0, errors: 0 };

  const config = loadRules(options._rulesPath);
  if (config.feeds.length === 0) {
    console.log('No feeds configured (rules.json "feeds"); nothing to do.');
    return totals;
  }

  const window = ledgerWindow({ state: readJson(statePath), since: options.since, now });
  if (window.initialize) {
    if (!dryRun) saveState(statePath, now);
    console.log('First run: watermark initialized. Use --since to backfill.');
    return totals;
  }

  const txDb = dryRun ? null : new TransactionDB(dbPath);
  let failed = false;
  try {
    for (const feed of config.feeds) {
      const feedPath = path.join(feedDir, `${feed.id}.jsonl`);
      const published = publishedRefs(feedPath);
      const counts = { scanned: 0, recorded: 0, adopted: 0, published: 0 };
      let messages;
      try {
        messages = await fetchSenderMessages(graphGetFn, feed.sender, window.start);
      } catch (e) {
        console.error(`ledger ${feed.id}: Graph error: ${e.message}`);
        totals.errors++;
        failed = true;
        continue;
      }
      for (const msg of messages) {
        counts.scanned++;
        let tx;
        try {
          const full = await graphGetFn(`/me/messages/${msg.id}`);
          const body = htmlToText(full.body?.content, full.body?.contentType);
          tx = parseTransaction(feed.sender, msg.subject || '', body, msg.receivedDateTime || '');
        } catch (e) {
          console.error(`ledger ${feed.id}: Graph error on ${msg.id}: ${e.message}`);
          totals.errors++;
          failed = true;
          break;
        }
        if (!tx) {
          if (dryRun) console.log(`  NOPARSE ${msg.subject}`);
          continue;
        }
        const row = { ...tx, raw_subject: msg.subject || '', email_id: msg.id };
        let adopted, isNew;
        if (dryRun) {
          const existing = peekExisting(dbPath, row);
          adopted = existing.legacy;
          isNew = !existing.legacy && !existing.recorded;
        } else {
          adopted = txDb.adoptLegacy(row, msg.id);
          isNew = adopted ? false : txDb.insert(row);
        }
        if (adopted) {
          counts.adopted++;
          if (dryRun) console.log(`  WOULD ADOPT ${msg.subject} ${tx.amount}`);
        } else if (isNew) {
          counts.recorded++;
        }
        const claimed = tx.type === 'income' && tx.ref && tx.memo === feed.memo;
        if (!claimed) {
          if (dryRun) console.log(`  SKIP (not ${feed.id}'s) ${msg.subject} ${tx.amount}`);
          continue;
        }
        if (published.has(tx.ref)) continue;
        const line = {
          v: 1, feed: feed.id, ref: tx.ref, platform: feed.platform,
          amount: tx.amount, currency: tx.currency, value_date: tx.date,
          payer: tx.merchant, memo: tx.memo, email_id: msg.id,
          received_at: msg.receivedDateTime || '', recorded_at: now,
        };
        if (dryRun) {
          console.log(`  WOULD PUBLISH ${JSON.stringify(line)}`);
        } else {
          fs.mkdirSync(feedDir, { recursive: true });
          ensureTerminated(feedPath);
          // One appendFileSync per line, well under PIPE_BUF: the append is
          // atomic on POSIX, so a concurrent reader never sees a half line
          // followed by a newline.
          fs.appendFileSync(feedPath, JSON.stringify(line) + '\n');
        }
        published.add(tx.ref);
        counts.published++;
      }
      console.log(`ledger ${feed.id}: scanned ${counts.scanned}, recorded ${counts.recorded}, adopted ${counts.adopted}, published ${counts.published}`);
      totals.scanned += counts.scanned;
      totals.recorded += counts.recorded;
      totals.adopted += counts.adopted;
      totals.published += counts.published;
    }
  } finally {
    txDb?.close();
  }
  // Advance only after a clean run: a partial scan must be repeated from the
  // old watermark, and the reference dedupe makes the repeat harmless.
  if (!failed && !dryRun) saveState(statePath, now);
  return totals;
}

function peekExisting(dbPath, tx) {
  // A dry run must not bring the database into existence.
  if (!fs.existsSync(dbPath) || !tx.ref) return { legacy: false, recorded: false };
  const db = new TransactionDB(dbPath);
  try {
    return { legacy: db.findLegacy(tx) !== null, recorded: db.hasRef(tx.source, tx.ref) };
  } finally {
    db.close();
  }
}

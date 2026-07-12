import { graphGet, graphPost, buildGraphUrl } from '../graph.js';
import { loadRules, classify, subjectKey } from './rules.js';
import { parseTransaction } from './parsers.js';
import { TransactionDB, SortLogDB } from './db.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'transactions.db');
const STATE_PATH = path.join(__dirname, '..', '..', 'data', 'sort-state.json');

export function computeWindow({ state, since, now }) {
  if (since) {
    const start = since.includes('T') ? since : `${since}T00:00:00Z`;
    return { start };
  }
  if (state && state.lastRun) {
    const d = new Date(state.lastRun);
    d.setHours(d.getHours() - 1);
    return { start: d.toISOString() };
  }
  return { initialize: true };
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch { return null; }
}

function saveState(state) {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function ensureFolder(name) {
  const result = await graphGet(`/me/mailFolders?$filter=displayName eq '${name}'`);
  if (result.value.length > 0) return result.value[0].id;
  const created = await graphPost('/me/mailFolders', { displayName: name });
  return created.id;
}

async function fetchAllMessages(startFilter, limit) {
  const params = {
    top: 100,
    orderby: 'receivedDateTime desc',
    select: 'id,subject,from,receivedDateTime,isRead',
    filter: `receivedDateTime ge ${startFilter}`
  };
  const url = buildGraphUrl('/me/mailFolders/inbox/messages', params);
  let result = await graphGet(url);
  let messages = [...result.value];

  while (result['@odata.nextLink'] && (!limit || messages.length < limit)) {
    result = await graphGet(result['@odata.nextLink']);
    messages.push(...result.value);
  }

  if (limit && messages.length > limit) {
    messages = messages.slice(0, limit);
  }
  return messages;
}

export async function sort(options = {}) {
  const dryRun = options.dryRun || false;
  const now = new Date().toISOString();

  const state = loadState();
  const window = computeWindow({ state, since: options.since, now });

  if (window.initialize) {
    if (!dryRun) saveState({ lastRun: now });
    console.log('First run: watermark initialized. No messages processed.');
    return { moved: 0, kept: 0, guardBlocked: 0 };
  }

  const config = loadRules();
  const [accountingFolderId, notificationsFolderId] = await Promise.all([
    ensureFolder('Accounting'),
    ensureFolder('Notifications')
  ]);

  const messages = await fetchAllMessages(window.start, options.limit || null);
  if (messages.length === 0) {
    console.log('No messages to sort.');
    if (!dryRun) saveState({ lastRun: now });
    return { moved: 0, kept: 0, guardBlocked: 0 };
  }

  const txDb = new TransactionDB(DB_PATH);
  const logDb = new SortLogDB(DB_PATH);

  const counts = { moved: 0, kept: 0, guardBlocked: 0, keptRule: 0, noparse: 0 };
  const guardedLines = [];
  const noparseLines = [];

  for (const msg of messages) {
    const senderAddr = msg.from?.emailAddress?.address || '';
    const subject = msg.subject || '';
    const domain = senderAddr.toLowerCase().split('@').pop() || '';
    const receivedAt = msg.receivedDateTime || '';
    const sk = subjectKey(subject);

    const result = classify(senderAddr, subject, config);
    const logEntry = {
      run_at: now,
      email_id: msg.id,
      sender: senderAddr,
      domain,
      subject,
      subject_key: sk,
      received_at: receivedAt,
      bucket: result.bucket,
      rule_id: result.ruleId || null,
      action: null,
      parsed: null
    };

    if (!result.bucket) {
      logEntry.action = 'kept';
      if (!dryRun) logDb.insert(logEntry);
      counts.kept++;
      continue;
    }

    if (result.guarded) {
      logEntry.action = 'guard-blocked';
      if (!dryRun) logDb.insert(logEntry);
      counts.guardBlocked++;
      guardedLines.push(`  [GUARD] ${senderAddr} — ${subject}`);
      continue;
    }

    if (result.bucket === 'keep') {
      logEntry.action = 'kept-rule';
      if (!dryRun) logDb.insert(logEntry);
      counts.keptRule++;
      continue;
    }

    if (result.bucket === 'accounting') {
      const fullMsg = await graphGet(`/me/messages/${msg.id}`);
      let body = fullMsg.body?.content || '';
      if (fullMsg.body?.contentType === 'html') {
        body = body.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
      }
      const tx = parseTransaction(senderAddr, subject, body, receivedAt);
      logEntry.parsed = tx ? 1 : 0;
      if (!tx) noparseLines.push(`  [NOPARSE] ${senderAddr} — ${subject}`);
      if (!dryRun) {
        if (tx) txDb.insert({ ...tx, raw_subject: subject, email_id: msg.id });
        await graphPost(`/me/messages/${msg.id}/move`, { destinationId: accountingFolderId });
      }
      logEntry.action = 'moved';
      if (!dryRun) logDb.insert(logEntry);
      else console.log(`  [would-move accounting] ${senderAddr} — ${subject}`);
      counts.moved++;
    } else if (result.bucket === 'notifications') {
      if (!dryRun) {
        await graphPost(`/me/messages/${msg.id}/move`, { destinationId: notificationsFolderId });
      }
      logEntry.action = 'moved';
      logEntry.parsed = null;
      if (!dryRun) logDb.insert(logEntry);
      else console.log(`  [would-move notifications] ${senderAddr} — ${subject}`);
      counts.moved++;
    }
  }

  txDb.close();
  logDb.close();

  // Summary
  console.log(`Sorted ${messages.length} emails: ${counts.moved} moved, ${counts.kept} kept, ${counts.guardBlocked} guard-blocked, ${counts.keptRule} kept-rule.`);
  for (const line of guardedLines) console.log(line);
  for (const line of noparseLines) console.log(line);
  if (noparseLines.length > 0) console.log(`${noparseLines.length} accounting emails with no parse result.`);

  if (!dryRun) saveState({ lastRun: now });
  return counts;
}

import { graphGet, graphPost, buildGraphUrl } from '../graph.js';
import { loadRules, classify, subjectKey } from './rules.js';
import { parseTransaction } from './parsers.js';
import { htmlToText } from './html-text.js';
import { TransactionDB, SortLogDB } from './db.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'transactions.db');
const STATE_PATH = path.join(__dirname, '..', '..', 'data', 'sort-state.json');

export function computeWindow({ state, since, now, minAgeHours }) {
  const ageMs = (minAgeHours || 0) * 3600_000;
  const end = new Date(new Date(now).getTime() - ageMs).toISOString();

  if (since) {
    const start = since.includes('T') ? since : `${since}T00:00:00Z`;
    return { start, end };
  }
  if (state && state.processedThrough) {
    const d = new Date(state.processedThrough);
    d.setHours(d.getHours() - 1); // 1h overlap
    const start = d.toISOString();
    if (new Date(end) <= new Date(start)) {
      return { tooSoon: true };
    }
    return { start, end };
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

async function fetchAllMessages(startFilter, endFilter, limit) {
  // lastModifiedDateTime ge start: catches emails moved INTO inbox after receivedDateTime (junk rescue, unsort, manual drag)
  // receivedDateTime le end: preserves min-age dwell gate on fresh emails
  const params = {
    top: 100,
    orderby: 'lastModifiedDateTime desc',
    select: 'id,subject,from,receivedDateTime,lastModifiedDateTime,isRead',
    filter: `lastModifiedDateTime ge ${startFilter} and receivedDateTime le ${endFilter}`
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

  try {
    const config = loadRules();
    const minAgeHours = options.minAge !== undefined ? options.minAge : config.settings.minAgeHours;

    const state = loadState();
    const window = computeWindow({ state, since: options.since, now, minAgeHours });

    if (window.initialize) {
      const initEnd = new Date(new Date(now).getTime() - minAgeHours * 3600_000).toISOString();
      if (!dryRun) saveState({ processedThrough: initEnd });
      console.log('First run: watermark initialized. No messages processed.');
      return { moved: 0, kept: 0, guardBlocked: 0 };
    }

    if (window.tooSoon) {
      console.log('Too soon: not enough time elapsed since last run. No messages processed.');
      return { moved: 0, kept: 0, guardBlocked: 0 };
    }
    const [accountingFolderId, notificationsFolderId] = await Promise.all([
      ensureFolder('Accounting'),
      ensureFolder('Notifications')
    ]);

    const messages = await fetchAllMessages(window.start, window.end, options.limit || null);
    if (messages.length === 0) {
      console.log('No messages to sort.');
      if (!dryRun) saveState({ processedThrough: window.end });
      return { moved: 0, kept: 0, guardBlocked: 0 };
    }

    const txDb = new TransactionDB(DB_PATH);
    const logDb = new SortLogDB(DB_PATH);

    const counts = { moved: 0, kept: 0, guardBlocked: 0, keptRule: 0, noparse: 0, pinned: 0 };
    const guardedLines = [];
    const noparseLines = [];
    const pinnedLines = [];

    for (const msg of messages) {
      // Unsorted emails are pinned — skip classification so they stay in inbox
      if (logDb.isUnsorted(msg.id)) {
        counts.pinned++;
        pinnedLines.push(`  [PINNED] ${msg.from?.emailAddress?.address || ''} — ${msg.subject || ''}`);
        if (!dryRun) {
          const pinAddr = msg.from?.emailAddress?.address || '';
          logDb.insert({
            run_at: now, email_id: msg.id, sender: pinAddr,
            domain: pinAddr.toLowerCase().split('@').pop() || '',
            subject: msg.subject || '', subject_key: subjectKey(msg.subject || ''),
            received_at: msg.receivedDateTime || '',
            bucket: null, rule_id: null, action: 'pinned', parsed: null
          });
        }
        continue;
      }

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
        const body = htmlToText(fullMsg.body?.content, fullMsg.body?.contentType);
        const tx = parseTransaction(senderAddr, subject, body, receivedAt);
        logEntry.parsed = tx ? 1 : 0;
        if (!tx) noparseLines.push(`  [NOPARSE] ${senderAddr} — ${subject}`);
        if (!dryRun) {
          if (tx) txDb.insert({ ...tx, raw_subject: subject, email_id: msg.id });
          // move 會改 message id — audit log 要記新 id，unsort 先搵得返
          const movedMsg = await graphPost(`/me/messages/${msg.id}/move`, { destinationId: accountingFolderId });
          if (movedMsg?.id) logEntry.email_id = movedMsg.id;
        }
        logEntry.action = 'moved';
        if (!dryRun) logDb.insert(logEntry);
        else console.log(`  [would-move accounting] ${senderAddr} — ${subject}`);
        counts.moved++;
      } else if (result.bucket === 'notifications') {
        if (!dryRun) {
          const movedMsg = await graphPost(`/me/messages/${msg.id}/move`, { destinationId: notificationsFolderId });
          if (movedMsg?.id) logEntry.email_id = movedMsg.id;
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
    console.log(`Sorted ${messages.length} emails: ${counts.moved} moved, ${counts.kept} kept, ${counts.guardBlocked} guard-blocked, ${counts.keptRule} kept-rule, ${counts.pinned} pinned.`);
    for (const line of pinnedLines) console.log(line);
    for (const line of guardedLines) console.log(line);
    for (const line of noparseLines) console.log(line);
    if (noparseLines.length > 0) console.log(`${noparseLines.length} accounting emails with no parse result.`);

    if (!dryRun) saveState({ processedThrough: window.end });
    return counts;
  } catch (err) {
    // Record run error to sort_log — best effort
    try {
      const logDb = new SortLogDB(DB_PATH);
      try {
        logDb.insert({
          run_at: now,
          email_id: `run-${now}`,
          sender: null,
          domain: null,
          subject: err.message,
          subject_key: null,
          received_at: null,
          bucket: null,
          rule_id: null,
          action: 'run-error',
          parsed: null
        });
      } finally {
        logDb.close();
      }
    } catch {
      // Swallow — the failure may be SortLogDB itself
    }
    throw err;
  }
}

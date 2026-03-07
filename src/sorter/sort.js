import { graphGet, graphPost, buildGraphUrl } from '../graph.js';
import { classify } from './rules.js';
import { parseTransaction } from './parsers.js';
import { TransactionDB } from './db.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'transactions.db');

async function ensureFolder(name) {
  const result = await graphGet(`/me/mailFolders?$filter=displayName eq '${name}'`);
  if (result.value.length > 0) return result.value[0].id;

  const created = await graphPost('/me/mailFolders', { displayName: name });
  return created.id;
}

export async function sort(options = {}) {
  const verbose = options.verbose || false;
  const dryRun = options.dryRun || false;

  // Ensure target folders exist
  const [accountingFolderId, notificationsFolderId] = await Promise.all([
    ensureFolder('Accounting'),
    ensureFolder('Notifications')
  ]);

  // Fetch unread inbox messages
  const limit = options.limit || 100;
  const url = buildGraphUrl('/me/mailFolders/inbox/messages', {
    top: limit,
    filter: 'isRead eq false',
    orderby: 'receivedDateTime desc',
    select: 'id,subject,from,receivedDateTime,isRead'
  });
  const result = await graphGet(url);
  const messages = result.value;

  if (messages.length === 0) {
    if (verbose) console.log('No unread messages.');
    return { accounting: 0, notifications: 0, skipped: 0 };
  }

  const db = new TransactionDB(DB_PATH);
  let counts = { accounting: 0, notifications: 0, skipped: 0 };

  for (const msg of messages) {
    const senderAddr = msg.from?.emailAddress?.address || '';
    const subject = msg.subject || '';
    const bucket = classify(senderAddr, subject);

    if (bucket === 'accounting') {
      // Read full body for parsing
      const fullMsg = await graphGet(`/me/messages/${msg.id}`);
      let body = fullMsg.body?.content || '';
      // Strip HTML
      if (fullMsg.body?.contentType === 'html') {
        body = body.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
      }

      const tx = parseTransaction(senderAddr, subject, body, msg.receivedDateTime);
      if (tx) {
        db.insert({ ...tx, raw_subject: subject, email_id: msg.id });
      }

      if (!dryRun) {
        await graphPost(`/me/messages/${msg.id}/move`, { destinationId: accountingFolderId });
      }
      counts.accounting++;
      if (verbose) console.log(`  [Accounting] ${subject}`);

    } else if (bucket === 'notifications') {
      if (!dryRun) {
        await graphPost(`/me/messages/${msg.id}/move`, { destinationId: notificationsFolderId });
      }
      counts.notifications++;
      if (verbose) console.log(`  [Notification] ${subject}`);

    } else {
      counts.skipped++;
      if (verbose) console.log(`  [Inbox] ${subject}`);
    }
  }

  db.close();

  console.log(`Sorted ${messages.length} emails: ${counts.accounting} accounting, ${counts.notifications} notifications, ${counts.skipped} kept in inbox.`);
  return counts;
}

import { graphGet, graphPost } from '../graph.js';
import { SortLogDB } from '../sorter/db.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'transactions.db');

export async function unsortCommand(options) {
  const dryRun = options.dryRun || false;
  const logDb = new SortLogDB(DB_PATH);

  const rows = logDb.listUnsortable({
    sender: options.sender || undefined,
    ruleId: options.rule || undefined,
    emailId: options.emailId || undefined,
    since: options.since || undefined
  });

  if (rows.length === 0) {
    console.log('No messages to unsort.');
    logDb.close();
    return;
  }

  // Get inbox folder id
  const inboxResult = await graphGet(`/me/mailFolders?$filter=displayName eq 'Inbox'`);
  const inboxId = inboxResult.value[0]?.id;
  if (!inboxId) {
    // Try well-known name
    const wk = await graphGet('/me/mailFolders/inbox');
    if (!wk?.id) throw new Error('Cannot find inbox folder');
  }
  const destId = inboxResult.value[0]?.id || (await graphGet('/me/mailFolders/inbox')).id;

  let moved = 0;
  const ruleBlame = new Map();

  for (const row of rows) {
    if (!dryRun) {
      try {
        // Graph move returns a new message object with a different id
        const movedMsg = await graphPost(`/me/messages/${row.email_id}/move`, { destinationId: destId });
        const newId = movedMsg?.id || row.email_id;
        logDb.insert({ ...row, email_id: newId, action: 'unsorted', run_at: new Date().toISOString(), parsed: null });
        moved++;
      } catch (e) {
        console.log(`  Failed: ${row.email_id} — ${e.message}`);
        continue;
      }
    } else {
      moved++;
    }
    console.log(`  ${row.sender} — ${row.subject}`);
    ruleBlame.set(row.rule_id, (ruleBlame.get(row.rule_id) || 0) + 1);
  }

  console.log(`\n${moved} messages ${dryRun ? 'would be ' : ''}moved back to inbox.`);
  if (ruleBlame.size > 0) {
    console.log('Blame:');
    for (const [ruleId, count] of ruleBlame) {
      console.log(`  rule "${ruleId}" moved ${count} — consider \`email rule rm ${ruleId}\` or narrowing`);
    }
  }

  logDb.close();
}

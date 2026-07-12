import { graphGet, buildGraphUrl } from '../graph.js';
import { loadRules } from '../sorter/rules.js';

async function scanFolder(folderName, guards, since) {
  const foldersResult = await graphGet(`/me/mailFolders?$filter=displayName eq '${folderName}'`);
  if (foldersResult.value.length === 0) {
    console.log(`Folder "${folderName}" not found.`);
    return [];
  }
  const folderId = foldersResult.value[0].id;

  const params = {
    top: 100,
    orderby: 'receivedDateTime desc',
    select: 'id,subject,from,receivedDateTime'
  };
  if (since) {
    params.filter = `receivedDateTime ge ${since.includes('T') ? since : since + 'T00:00:00Z'}`;
  }

  const url = buildGraphUrl(`/me/mailFolders/${folderId}/messages`, params);
  let result = await graphGet(url);
  let messages = [...result.value];
  while (result['@odata.nextLink']) {
    result = await graphGet(result['@odata.nextLink']);
    messages.push(...result.value);
  }

  const candidates = [];
  for (const msg of messages) {
    const subject = (msg.subject || '').toLowerCase();
    for (const g of guards) {
      if (subject.includes(g)) {
        candidates.push({
          folder: folderName,
          date: msg.receivedDateTime,
          sender: msg.from?.emailAddress?.address || '',
          subject: msg.subject,
          email_id: msg.id,
          guard: g
        });
        break;
      }
    }
  }
  return candidates;
}

export async function rescueScanCommand(options) {
  const { guards } = loadRules();
  const since = options.since || null;
  const folders = options.folder ? [options.folder] : ['Accounting', 'Notifications'];

  let allCandidates = [];
  for (const f of folders) {
    const candidates = await scanFolder(f, guards, since);
    allCandidates.push(...candidates);
  }

  if (allCandidates.length === 0) {
    console.log('No guard-matching messages found in target folders.');
    return;
  }

  console.log(`Found ${allCandidates.length} potential rescue candidates:\n`);
  for (const c of allCandidates) {
    console.log(`  [${c.folder}] ${c.date}  ${c.sender}`);
    console.log(`    ${c.subject}`);
    console.log(`    id: ${c.email_id}  (guard: "${c.guard}")`);
    console.log('');
  }
}

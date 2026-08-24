import { graphGet, graphPost } from '../graph.js';
import { resolveInboxIndex } from '../inbox-listing.js';

export async function move(index, options) {
  if (!options.to) {
    console.error('Required: --to <folder>');
    process.exit(1);
  }

  const msg = await resolveInboxIndex(index);

  const foldersResult = await graphGet('/me/mailFolders?$top=50');
  const folder = foldersResult.value.find(f =>
    f.displayName.toLowerCase() === options.to.toLowerCase()
  );
  if (!folder) {
    console.error(`Folder not found: ${options.to}`);
    console.error('Use "email folders" to see available folders.');
    process.exit(1);
  }

  await graphPost(`/me/messages/${msg.id}/move`, { destinationId: folder.id });

  console.log(`Moved "${msg.subject || '(no subject)'}" to ${folder.displayName}.`);
}

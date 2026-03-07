import { graphGet, graphPost, buildGraphUrl } from '../graph.js';

export async function move(index, options) {
  if (!options.to) {
    console.error('Required: --to <folder>');
    process.exit(1);
  }

  const count = Math.max(parseInt(index), 20);
  const url = buildGraphUrl('/me/messages', { top: count, orderby: 'receivedDateTime desc', select: 'id,subject' });
  const result = await graphGet(url);

  const idx = parseInt(index) - 1;
  if (idx < 0 || idx >= result.value.length) {
    console.error(`Invalid message number: ${index}`);
    process.exit(1);
  }

  const foldersResult = await graphGet('/me/mailFolders?$top=50');
  const folder = foldersResult.value.find(f =>
    f.displayName.toLowerCase() === options.to.toLowerCase()
  );
  if (!folder) {
    console.error(`Folder not found: ${options.to}`);
    console.error('Use "email folders" to see available folders.');
    process.exit(1);
  }

  const msg = result.value[idx];
  await graphPost(`/me/messages/${msg.id}/move`, { destinationId: folder.id });

  console.log(`Moved "${msg.subject || '(no subject)'}" to ${folder.displayName}.`);
}

import { graphGet, graphPost, buildGraphUrl } from '../graph.js';

export async function del(index) {
  const count = Math.max(parseInt(index), 20);
  const url = buildGraphUrl('/me/messages', { top: count, orderby: 'receivedDateTime desc', select: 'id,subject' });
  const result = await graphGet(url);

  const idx = parseInt(index) - 1;
  if (idx < 0 || idx >= result.value.length) {
    console.error(`Invalid message number: ${index}`);
    process.exit(1);
  }

  const msg = result.value[idx];
  await graphPost(`/me/messages/${msg.id}/move`, { destinationId: 'deleteditems' });

  console.log(`Deleted: ${msg.subject || '(no subject)'}`);
}

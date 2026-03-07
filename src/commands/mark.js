import { graphGet, graphPatch, buildGraphUrl } from '../graph.js';

export async function markRead(index) {
  await setReadStatus(index, true);
  console.log(`Marked message ${index} as read.`);
}

export async function markUnread(index) {
  await setReadStatus(index, false);
  console.log(`Marked message ${index} as unread.`);
}

async function setReadStatus(index, isRead) {
  const count = Math.max(parseInt(index), 20);
  const url = buildGraphUrl('/me/messages', { top: count, orderby: 'receivedDateTime desc', select: 'id' });
  const result = await graphGet(url);

  const idx = parseInt(index) - 1;
  if (idx < 0 || idx >= result.value.length) {
    console.error(`Invalid message number: ${index}`);
    process.exit(1);
  }

  await graphPatch(`/me/messages/${result.value[idx].id}`, { isRead });
}

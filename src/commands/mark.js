import { graphPatch } from '../graph.js';
import { resolveInboxIndex } from '../inbox-listing.js';

export async function markRead(index) {
  await setReadStatus(index, true);
  console.log(`Marked message ${index} as read.`);
}

export async function markUnread(index) {
  await setReadStatus(index, false);
  console.log(`Marked message ${index} as unread.`);
}

async function setReadStatus(index, isRead) {
  const msg = await resolveInboxIndex(index);
  await graphPatch(`/me/messages/${msg.id}`, { isRead });
}

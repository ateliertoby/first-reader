import { graphGet, graphPatch } from '../graph.js';
import { resolveInboxIndex } from '../inbox-listing.js';
import { formatEmailBody } from '../format.js';

export async function read(index, options) {
  const msgId = (await resolveInboxIndex(index)).id;
  const msg = await graphGet(`/me/messages/${msgId}`);

  if (!msg.isRead) {
    await graphPatch(`/me/messages/${msgId}`, { isRead: true });
  }

  console.log(formatEmailBody(msg));
}

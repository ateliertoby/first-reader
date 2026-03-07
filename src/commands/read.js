import { graphGet, buildGraphUrl } from '../graph.js';
import { graphPatch } from '../graph.js';
import { formatEmailBody } from '../format.js';

export async function read(index, options) {
  const count = Math.max(parseInt(index), 20);
  const url = buildGraphUrl('/me/messages', { top: count, orderby: 'receivedDateTime desc', select: 'id' });
  const result = await graphGet(url);

  const idx = parseInt(index) - 1;
  if (idx < 0 || idx >= result.value.length) {
    console.error(`Invalid message number: ${index}`);
    process.exit(1);
  }

  const msgId = result.value[idx].id;
  const msg = await graphGet(`/me/messages/${msgId}`);

  if (!msg.isRead) {
    await graphPatch(`/me/messages/${msgId}`, { isRead: true });
  }

  console.log(formatEmailBody(msg));
}

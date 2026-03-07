import { graphGet, buildGraphUrl } from '../graph.js';
import { formatInboxRow } from '../format.js';

export async function inbox(options) {
  const count = options.number || 20;
  const params = { top: count, orderby: 'receivedDateTime desc', select: 'id,subject,from,receivedDateTime,isRead' };
  if (options.unread) params.filter = 'isRead eq false';

  const url = buildGraphUrl('/me/messages', params);
  const result = await graphGet(url);
  const messages = result.value;

  if (messages.length === 0) {
    console.log('No messages.');
    return;
  }

  messages.forEach((msg, i) => console.log(formatInboxRow(msg, i + 1)));
  console.log(`\n${messages.length} messages shown.`);
}

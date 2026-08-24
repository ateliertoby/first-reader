import { listInboxMessages } from '../inbox-listing.js';
import { formatInboxRow } from '../format.js';

export async function inbox(options) {
  const messages = await listInboxMessages({ count: options.number, unread: options.unread });

  if (messages.length === 0) {
    console.log('No messages.');
    return;
  }

  messages.forEach((msg, i) => console.log(formatInboxRow(msg, i + 1)));
  console.log(`\n${messages.length} messages shown.`);
}

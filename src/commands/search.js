import { graphGet, buildGraphUrl } from '../graph.js';
import { formatInboxRow } from '../format.js';

export async function search(query, options) {
  const count = options.number || 20;
  const url = buildGraphUrl('/me/messages', { top: count, search: `"${query}"` });
  const result = await graphGet(url);

  if (result.value.length === 0) {
    console.log('No messages found.');
    return;
  }

  result.value.forEach((msg, i) => console.log(formatInboxRow(msg, i + 1)));
  console.log(`\n${result.value.length} results.`);
}

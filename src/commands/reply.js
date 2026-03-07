import { graphGet, graphPost, buildGraphUrl } from '../graph.js';

export async function reply(index, options) {
  if (!options.body) {
    console.error('Required: --body');
    process.exit(1);
  }

  const count = Math.max(parseInt(index), 20);
  const url = buildGraphUrl('/me/messages', { top: count, orderby: 'receivedDateTime desc', select: 'id' });
  const result = await graphGet(url);

  const idx = parseInt(index) - 1;
  if (idx < 0 || idx >= result.value.length) {
    console.error(`Invalid message number: ${index}`);
    process.exit(1);
  }

  const msgId = result.value[idx].id;
  await graphPost(`/me/messages/${msgId}/reply`, { comment: options.body });

  console.log('Reply sent.');
}

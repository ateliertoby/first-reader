import { graphPost } from '../graph.js';
import { resolveInboxIndex } from '../inbox-listing.js';

export async function reply(index, options) {
  if (!options.body) {
    console.error('Required: --body');
    process.exit(1);
  }

  const msg = await resolveInboxIndex(index);
  await graphPost(`/me/messages/${msg.id}/reply`, { comment: options.body });

  console.log('Reply sent.');
}

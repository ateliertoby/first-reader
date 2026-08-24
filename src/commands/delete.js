import { graphPost } from '../graph.js';
import { resolveInboxIndex } from '../inbox-listing.js';

export async function del(index) {
  const msg = await resolveInboxIndex(index);
  await graphPost(`/me/messages/${msg.id}/move`, { destinationId: 'deleteditems' });

  console.log(`Deleted: ${msg.subject || '(no subject)'}`);
}

import { graphGet, buildGraphUrl } from './graph.js';

const INBOX_PATH = '/me/mailFolders/inbox/messages';
const INBOX_SELECT = 'id,subject,from,receivedDateTime,isRead';

export const DEFAULT_INBOX_COUNT = 20;

// Single definition of the listing whose row numbers users type back at the CLI.
// Folder scope, ordering and page size must be identical for the command that
// prints the numbers and every command that accepts one: the unscoped
// /me/messages collection spans all folders, so once mail has been sorted out of
// the inbox the same number denotes a different message there.
export function buildInboxListUrl({ count, unread = false } = {}) {
  const params = {
    top: count || DEFAULT_INBOX_COUNT,
    orderby: 'receivedDateTime desc',
    select: INBOX_SELECT
  };
  if (unread) params.filter = 'isRead eq false';
  return buildGraphUrl(INBOX_PATH, params);
}

export async function listInboxMessages(options = {}) {
  const result = await graphGet(buildInboxListUrl(options));
  return result.value;
}

// Resolves a 1-based inbox row number to the message shown on that row.
export async function resolveInboxIndex(index) {
  const position = parseInt(index, 10);
  if (!Number.isInteger(position) || position < 1) return invalidIndex(index);

  const messages = await listInboxMessages({ count: Math.max(position, DEFAULT_INBOX_COUNT) });
  const message = messages[position - 1];
  if (!message) return invalidIndex(index);

  return message;
}

function invalidIndex(index) {
  console.error(`Invalid message number: ${index}`);
  process.exit(1);
}

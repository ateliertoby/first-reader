export function formatInboxRow(msg, index) {
  const unread = msg.isRead ? ' ' : '*';
  const from = (msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || 'Unknown').padEnd(25).slice(0, 25);
  const subject = (msg.subject || '(no subject)').padEnd(40).slice(0, 40);
  const date = new Date(msg.receivedDateTime).toLocaleString('en-HK', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  return `${unread} ${String(index).padStart(3)}  ${from}  ${subject}  ${date}`;
}

export function formatEmailBody(msg) {
  const from = `${msg.from?.emailAddress?.name || ''} <${msg.from?.emailAddress?.address || ''}>`;
  const date = new Date(msg.receivedDateTime).toLocaleString();
  let body = msg.body?.content || '';

  if (msg.body?.contentType === 'html') {
    body = body
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<li[^>]*>/gi, '  - ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  return [
    `From:    ${from}`,
    `Subject: ${msg.subject || '(no subject)'}`,
    `Date:    ${date}`,
    `${'─'.repeat(60)}`,
    body
  ].join('\n');
}

export function formatFolderRow(folder) {
  const name = folder.displayName.padEnd(30);
  const total = String(folder.totalItemCount).padStart(5);
  const unread = folder.unreadItemCount > 0 ? ` (${folder.unreadItemCount} unread)` : '';
  return `${name} ${total} msgs${unread}`;
}

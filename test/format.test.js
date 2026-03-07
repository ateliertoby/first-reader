import { test, describe } from 'node:test';
import assert from 'node:assert';
import { formatInboxRow, formatEmailBody, formatFolderRow } from '../src/format.js';

describe('formatInboxRow', () => {
  test('formats unread email with marker', () => {
    const msg = {
      id: 'abc123',
      isRead: false,
      from: { emailAddress: { name: 'Alice', address: 'alice@test.com' } },
      subject: 'Hello',
      receivedDateTime: '2026-03-07T10:30:00Z'
    };
    const row = formatInboxRow(msg, 1);
    assert.ok(row.includes('*'));
    assert.ok(row.includes('Alice'));
    assert.ok(row.includes('Hello'));
  });

  test('formats read email without marker', () => {
    const msg = {
      id: 'abc123',
      isRead: true,
      from: { emailAddress: { name: 'Bob', address: 'bob@test.com' } },
      subject: 'Hi',
      receivedDateTime: '2026-03-07T10:30:00Z'
    };
    const row = formatInboxRow(msg, 2);
    assert.ok(!row.includes('*'));
    assert.ok(row.includes('Bob'));
  });
});

describe('formatEmailBody', () => {
  test('formats email with sender, subject, date, and body', () => {
    const msg = {
      from: { emailAddress: { name: 'Alice', address: 'alice@test.com' } },
      subject: 'Test Subject',
      receivedDateTime: '2026-03-07T10:30:00Z',
      body: { content: '<p>Hello world</p>', contentType: 'html' }
    };
    const output = formatEmailBody(msg);
    assert.ok(output.includes('Alice'));
    assert.ok(output.includes('Test Subject'));
    assert.ok(output.includes('Hello world'));
  });
});

describe('formatFolderRow', () => {
  test('formats folder with message counts', () => {
    const folder = {
      displayName: 'Inbox',
      totalItemCount: 100,
      unreadItemCount: 5
    };
    const row = formatFolderRow(folder);
    assert.ok(row.includes('Inbox'));
    assert.ok(row.includes('5'));
  });
});

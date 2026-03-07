import { test, describe } from 'node:test';
import assert from 'node:assert';
import { buildGraphUrl } from '../src/graph.js';

describe('buildGraphUrl', () => {
  test('builds messages URL with defaults', () => {
    const url = buildGraphUrl('/me/messages', { top: 20 });
    assert.strictEqual(url, '/me/messages?$top=20');
  });

  test('builds URL with multiple params', () => {
    const url = buildGraphUrl('/me/messages', { top: 10, filter: "isRead eq false", orderby: 'receivedDateTime desc' });
    assert.ok(url.includes('$top=10'));
    assert.ok(url.includes('$filter=isRead eq false'));
    assert.ok(url.includes('$orderby=receivedDateTime desc'));
  });

  test('builds URL with no params', () => {
    const url = buildGraphUrl('/me/mailFolders');
    assert.strictEqual(url, '/me/mailFolders');
  });
});

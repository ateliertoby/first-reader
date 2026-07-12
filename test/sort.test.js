import { test, describe } from 'node:test';
import assert from 'node:assert';
import { computeWindow } from '../src/sorter/sort.js';
import { addRule, removeRule, addGuard, removeGuard } from '../src/commands/rule.js';

describe('computeWindow', () => {
  test('--since overrides everything', () => {
    const result = computeWindow({
      state: { lastRun: '2026-07-12T10:00:00Z' },
      since: '2026-07-01',
      now: '2026-07-13T12:00:00Z'
    });
    assert.strictEqual(result.start, '2026-07-01T00:00:00Z');
    assert.strictEqual(result.initialize, undefined);
  });

  test('since with T is passed through', () => {
    const result = computeWindow({
      state: null,
      since: '2026-07-01T05:30:00Z',
      now: '2026-07-13T12:00:00Z'
    });
    assert.strictEqual(result.start, '2026-07-01T05:30:00Z');
  });

  test('state.lastRun minus 1h becomes start', () => {
    const result = computeWindow({
      state: { lastRun: '2026-07-13T10:00:00Z' },
      since: null,
      now: '2026-07-13T12:00:00Z'
    });
    assert.strictEqual(result.start, '2026-07-13T09:00:00.000Z');
  });

  test('no since + no state → initialize', () => {
    const result = computeWindow({
      state: null,
      since: null,
      now: '2026-07-13T12:00:00Z'
    });
    assert.strictEqual(result.initialize, true);
    assert.strictEqual(result.start, undefined);
  });
});

describe('rule mutations (pure functions)', () => {
  const baseConfig = {
    version: 1,
    guards: ['failed', 'declined'],
    rules: [
      { id: 'mox-tx', bucket: 'accounting', domains: ['mox.com'], subject: '交易' }
    ]
  };

  test('addRule generates id from first domain', () => {
    const { config, id } = addRule(baseConfig, {
      bucket: 'notifications',
      domains: ['test.com'],
      subject: null,
      note: null
    });
    assert.strictEqual(id, 'test-com');
    assert.strictEqual(config.rules.length, 2);
    assert.strictEqual(config.rules[1].bucket, 'notifications');
    assert.ok(config.rules[1].added);
    assert.ok(config.rules[1].probationUntil);
  });

  test('addRule deduplicates id with -2 suffix', () => {
    const config = {
      ...baseConfig,
      rules: [
        ...baseConfig.rules,
        { id: 'test-com', bucket: 'notifications', domains: ['test.com'] }
      ]
    };
    const { id } = addRule(config, {
      bucket: 'notifications',
      domains: ['test.com'],
      subject: null,
      note: null
    });
    assert.strictEqual(id, 'test-com-2');
  });

  test('removeRule removes by id', () => {
    const config = removeRule(baseConfig, 'mox-tx');
    assert.strictEqual(config.rules.length, 0);
  });

  test('removeRule throws on missing id', () => {
    assert.throws(() => removeRule(baseConfig, 'nonexistent'), /not found/);
  });

  test('addGuard adds lowercase', () => {
    const config = addGuard(baseConfig, 'OVERDUE');
    assert.ok(config.guards.includes('overdue'));
    assert.strictEqual(config.guards.length, 3);
  });

  test('addGuard throws on duplicate', () => {
    assert.throws(() => addGuard(baseConfig, 'failed'), /already exists/);
  });

  test('removeGuard removes', () => {
    const config = removeGuard(baseConfig, 'failed');
    assert.strictEqual(config.guards.length, 1);
    assert.ok(!config.guards.includes('failed'));
  });

  test('removeGuard throws on missing', () => {
    assert.throws(() => removeGuard(baseConfig, 'xyz'), /not found/);
  });
});

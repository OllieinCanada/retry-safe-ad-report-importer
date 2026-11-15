import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Mongoose, mongo } from 'mongoose';
import { CORRECTION, INITIAL_PAGE, pageOf } from '../src/fixtures.js';
import { accountHistoryQuery } from '../src/history.js';
import { importPage, isIdentityInsertConflict } from '../src/importer.js';
import {
  IDENTITY_INDEX, normalizeSnapshot, parseReportingDay, snapshotSchema,
  type Snapshot, type SnapshotIdentity,
} from '../src/snapshot.js';

const identity: SnapshotIdentity = {
  workspaceId: 'workspace-a', provider: 'synthetic-ads', accountId: 'account-1',
  day: new Date('2026-01-05T00:00:00.000Z'), campaignId: 'campaign-alpha',
};

function conflict(overrides: Record<string, unknown> = {}) {
  return new mongo.MongoServerError({
    message: 'E11000 injected identity insert race',
    code: 11000, keyPattern: { ...IDENTITY_INDEX }, keyValue: { ...identity },
    ...overrides,
  });
}

// Fault injection exercises error branches which MongoDB's own upsert retry
// may hide. No database behavior or stored-state proof relies on these mocks.
function mockWriter(responses: (Error | { matchedCount: number })[]) {
  const model = new Mongoose().model<Snapshot>('UnitSnapshot', snapshotSchema);
  const calls: { filter: unknown; pipeline: unknown; options: { upsert: boolean } }[] = [];
  mock.method(model, 'updateOne', (
    filter: unknown, pipeline: unknown, options: { upsert: boolean },
  ) => {
    calls.push({ filter, pipeline, options });
    const response = responses[calls.length - 1];
    return {
      exec: async () => {
        if (!response) throw new Error('Unexpected extra write');
        if (response instanceof Error) throw response;
        return response;
      },
    };
  });
  return { model, calls };
}

test('duplicate-key guard accepts only the exact ordered identity pattern and values', () => {
  assert.equal(isIdentityInsertConflict(conflict(), identity), true);
  const unrelated = [
    conflict({ code: 121 }),
    conflict({ keyPattern: { _id: 1 }, keyValue: { _id: 'other' } }),
    conflict({ keyPattern: undefined }),
    conflict({ keyValue: undefined }),
    conflict({ keyValue: { ...identity, workspaceId: 'another-workspace' } }),
    conflict({ keyValue: { ...identity, day: new Date('2026-01-06T00:00:00.000Z') } }),
    conflict({ keyPattern: { campaignId: 1, day: 1, accountId: 1, provider: 1, workspaceId: 1 } }),
    { code: 11000, keyPattern: IDENTITY_INDEX, keyValue: identity },
    new Error('network failure'),
  ];
  for (const error of unrelated) assert.equal(isIdentityInsertConflict(error, identity), false);
});

test('an expected insert race retries the same conditional pipeline once without upsert', async () => {
  const { model, calls } = mockWriter([conflict(), { matchedCount: 1 }]);
  await importPage(model, pageOf(CORRECTION));
  assert.deepEqual(calls.map(call => call.options.upsert), [true, false]);
  assert.deepEqual(calls[0]!.filter, identity);
  assert.deepEqual(calls[1]!.filter, identity);
  assert.deepEqual(calls[0]!.pipeline, calls[1]!.pipeline);
});

test('a missing document after the race retry rethrows the original conflict', async () => {
  const original = conflict();
  const { model, calls } = mockWriter([original, { matchedCount: 0 }]);
  await assert.rejects(importPage(model, pageOf(CORRECTION)), error => error === original);
  assert.equal(calls.length, 2);
});

test('an unrelated initial write error propagates unchanged without retry', async () => {
  for (const original of [
    new Error('connection failed'),
    conflict({ keyPattern: { _id: 1 }, keyValue: { _id: 'other' } }),
    conflict({ code: 121 }),
  ]) {
    const { model, calls } = mockWriter([original]);
    await assert.rejects(importPage(model, pageOf(CORRECTION)), error => error === original);
    assert.equal(calls.length, 1);
  }
});

test('a database error during the race retry propagates unchanged', async () => {
  const retryError = new Error('retry connection failed');
  const { model, calls } = mockWriter([conflict(), retryError]);
  await assert.rejects(importPage(model, pageOf(CORRECTION)), error => error === retryError);
  assert.equal(calls.length, 2);
});

test('invalid day strings and nonexistent UTC calendar dates are rejected', () => {
  for (const day of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-01-00',
    '2026-1-05', '2026-01-05T00:00:00Z', 'not-a-day']) {
    assert.throws(() => parseReportingDay(day), TypeError);
  }
  assert.equal(parseReportingDay('2024-02-29').toISOString(), '2024-02-29T00:00:00.000Z');
});

test('unsafe, fractional, and negative counters or revisions are rejected before any write', async () => {
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    assert.throws(() => normalizeSnapshot({ ...CORRECTION, sourceRevision: invalid }), TypeError);
    for (const metric of ['impressions', 'clicks', 'spendMinor'] as const) {
      const badSnapshot = { ...CORRECTION, metrics: { ...CORRECTION.metrics, [metric]: invalid } };
      const { model, calls } = mockWriter([]);
      // Even a valid row earlier in the page is not sent before validation.
      await assert.rejects(importPage(model, pageOf(INITIAL_PAGE.snapshots[0]!, badSnapshot)), TypeError);
      assert.equal(calls.length, 0);
    }
  }
});

test('empty scope identifiers and invalid history ranges are rejected', () => {
  for (const field of ['workspaceId', 'provider', 'accountId', 'campaignId'] as const) {
    assert.throws(() => normalizeSnapshot({ ...CORRECTION, [field]: ' ' }), TypeError);
  }
  const model = new Mongoose().model<Snapshot>('HistoryUnitSnapshot', snapshotSchema);
  for (const toDayExclusive of ['2026-01-05', '2026-01-04']) {
    assert.throws(() => accountHistoryQuery(model, {
      workspaceId: 'workspace-a', provider: 'synthetic-ads', accountId: 'account-1',
      fromDay: '2026-01-05', toDayExclusive,
    }), RangeError);
  }
});

import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose, { mongo } from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { connectStore, type SnapshotStore } from '../src/database.js';
import { MONGODB_VERSION, startDisposableMongo } from '../src/disposable.js';
import { summarizeExplain } from '../src/explain.js';
import {
  CORRECTION, DELAYED_OLDER, HISTORY_PARAMS, INITIAL_PAGE, pageOf, querySeedPage,
} from '../src/fixtures.js';
import { accountHistoryQuery, getAccountHistory } from '../src/history.js';
import { importPage } from '../src/importer.js';
import { IDENTITY_INDEX, IDENTITY_INDEX_NAME, type Metrics } from '../src/snapshot.js';

let server: MongoMemoryServer;
let store: SnapshotStore;
let secondWorker: SnapshotStore;

before(async () => {
  server = await startDisposableMongo();
  store = await connectStore(server.getUri(), 'ad_report_importer_integration');
  secondWorker = await connectStore(server.getUri(), 'ad_report_importer_integration');
  const indexes = await store.snapshots.collection.listIndexes().toArray();
  const index = indexes.find(item => item.name === IDENTITY_INDEX_NAME);
  assert.ok(index, 'identity index must exist before any importer test runs');
  assert.deepEqual(Object.entries(index.key), Object.entries(IDENTITY_INDEX));
  assert.equal(index.unique, true);
  const buildInfo = await store.connection.db!.admin().command({ buildInfo: 1 });
  assert.equal(buildInfo.version, MONGODB_VERSION);
  console.info(`Real integration server: MongoDB ${buildInfo.version}; Mongoose ${mongoose.version}; Node ${process.version}`);
}, { timeout: 180_000 });

after(async () => {
  try {
    await Promise.all([store?.connection.close(), secondWorker?.connection.close()]);
  } finally {
    await server?.stop();
  }
});

beforeEach(async () => {
  await store.snapshots.deleteMany({}).exec();
});

// Explicit expected database values, independent of the importer/pipeline.
const BASE_VALUES = [
  ['workspace-a', 'synthetic-ads', 'account-1', '2026-01-05', 'campaign-alpha', 1, 1000, 50, 1234],
  ['workspace-a', 'synthetic-ads', 'account-1', '2026-01-05', 'campaign-beta', 1, 600, 20, 500],
  ['workspace-a', 'synthetic-ads', 'account-1', '2026-01-06', 'campaign-alpha', 2, 800, 30, 900],
  ['workspace-a', 'synthetic-ads', 'account-1', '2026-01-06', 'campaign-beta', 1, 200, 10, 200],
];
const CORRECTED_VALUES = [
  ['workspace-a', 'synthetic-ads', 'account-1', '2026-01-05', 'campaign-alpha', 3, 1200, 60, 1400],
  ...BASE_VALUES.slice(1),
];

async function storedDocuments() {
  return store.snapshots.find().sort(IDENTITY_INDEX).lean().exec();
}

async function storedValues() {
  return (await storedDocuments()).map(row => [
    row.workspaceId, row.provider, row.accountId, row.day.toISOString().slice(0, 10),
    row.campaignId, row.sourceRevision,
    row.metrics.impressions, row.metrics.clicks, row.metrics.spendMinor,
  ]);
}

async function totals(): Promise<Metrics> {
  return (await storedDocuments()).reduce<Metrics>((sum, row) => ({
    impressions: sum.impressions + row.metrics.impressions,
    clicks: sum.clicks + row.metrics.clicks,
    spendMinor: sum.spendMinor + row.metrics.spendMinor,
  }), { impressions: 0, clicks: 0, spendMinor: 0 });
}

test('first import stores all expected snapshot values and totals', async () => {
  await importPage(store.snapshots, INITIAL_PAGE);
  assert.deepEqual(await storedValues(), BASE_VALUES);
  assert.equal(await store.snapshots.countDocuments(), 4);
  assert.deepEqual(await totals(), { impressions: 2600, clicks: 110, spendMinor: 2834 });
});

test('identical replay preserves documents, IDs, row count, and totals', async () => {
  await importPage(store.snapshots, INITIAL_PAGE);
  const beforeReplay = await storedDocuments();
  await importPage(store.snapshots, { ...INITIAL_PAGE, pageId: 'a-different-delivery-id' });
  assert.deepEqual(await storedDocuments(), beforeReplay);
  assert.deepEqual(await storedValues(), BASE_VALUES);
  assert.equal(await store.snapshots.countDocuments(), 4);
  assert.deepEqual(await totals(), { impressions: 2600, clicks: 110, spendMinor: 2834 });
});

test('two concurrent worker connections importing the same page create no duplicates', async () => {
  await Promise.all([
    importPage(store.snapshots, INITIAL_PAGE),
    importPage(secondWorker.snapshots, INITIAL_PAGE),
  ]);
  assert.deepEqual(await storedValues(), BASE_VALUES);
  assert.equal(await store.snapshots.countDocuments(), 4);
  assert.deepEqual(await totals(), { impressions: 2600, clicks: 110, spendMinor: 2834 });
});

test('a newer correction replaces all metrics without adding to the old snapshot', async () => {
  await importPage(store.snapshots, INITIAL_PAGE);
  await importPage(store.snapshots, pageOf(CORRECTION));
  assert.deepEqual(await storedValues(), CORRECTED_VALUES);
  assert.equal(await store.snapshots.countDocuments(), 4);
  assert.deepEqual(await totals(), { impressions: 2800, clicks: 120, spendMinor: 3000 });
});

test('a delayed older snapshot cannot undo the stored correction', async () => {
  await importPage(store.snapshots, INITIAL_PAGE);
  await importPage(store.snapshots, pageOf(CORRECTION));
  const corrected = await storedDocuments();
  await importPage(store.snapshots, pageOf(DELAYED_OLDER));
  assert.deepEqual(await storedDocuments(), corrected);
  assert.deepEqual(await storedValues(), CORRECTED_VALUES);
  assert.deepEqual(await totals(), { impressions: 2800, clicks: 120, spendMinor: 3000 });
});

test('different metrics at an equal revision preserve the first accepted payload', async () => {
  await importPage(store.snapshots, INITIAL_PAGE);
  const firstAccepted = await storedDocuments();
  await importPage(store.snapshots, pageOf({
    ...INITIAL_PAGE.snapshots[0]!,
    metrics: { impressions: 9999, clicks: 999, spendMinor: 99999 },
  }));
  assert.deepEqual(await storedDocuments(), firstAccepted);
  assert.deepEqual(await storedValues(), BASE_VALUES);
});

test('concurrent correction and older delivery leave the highest revision stored', async () => {
  await importPage(store.snapshots, INITIAL_PAGE);
  await Promise.all([
    importPage(store.snapshots, pageOf(CORRECTION)),
    importPage(secondWorker.snapshots, pageOf(DELAYED_OLDER)),
  ]);
  assert.deepEqual(await storedValues(), CORRECTED_VALUES);
  assert.deepEqual(await totals(), { impressions: 2800, clicks: 120, spendMinor: 3000 });
});

test('concurrent first inserts with different revisions converge on the newer snapshot', async () => {
  await Promise.all([
    importPage(store.snapshots, pageOf(CORRECTION)),
    importPage(secondWorker.snapshots, pageOf(DELAYED_OLDER)),
  ]);
  assert.deepEqual(await storedValues(), [CORRECTED_VALUES[0]]);
  assert.equal(await store.snapshots.countDocuments(), 1);
  assert.deepEqual(await totals(), { impressions: 1200, clicks: 60, spendMinor: 1400 });
});

test('matching campaign/account identifiers stay isolated across workspaces', async () => {
  await importPage(store.snapshots, INITIAL_PAGE);
  await importPage(store.snapshots, pageOf({
    ...CORRECTION, workspaceId: 'workspace-b', sourceRevision: 100,
    metrics: { impressions: 77, clicks: 7, spendMinor: 70 },
  }));
  await importPage(store.snapshots, pageOf(CORRECTION));
  assert.deepEqual(await storedValues(), [
    ...CORRECTED_VALUES,
    ['workspace-b', 'synthetic-ads', 'account-1', '2026-01-05', 'campaign-alpha', 100, 77, 7, 70],
  ]);
  assert.equal((await getAccountHistory(store.snapshots, HISTORY_PARAMS)).length, 4);
  const otherWorkspace = await getAccountHistory(store.snapshots, {
    ...HISTORY_PARAMS, workspaceId: 'workspace-b',
  });
  assert.equal(otherWorkspace.length, 1);
  assert.deepEqual(otherWorkspace[0]!.metrics, { impressions: 77, clicks: 7, spendMinor: 70 });
});

test('revision zero and dollar-prefixed identifiers insert as literal values', async () => {
  await importPage(store.snapshots, pageOf({
    ...INITIAL_PAGE.snapshots[0]!, workspaceId: '$workspace', provider: '$provider',
    accountId: '$account', campaignId: '$campaign', sourceRevision: 0,
  }));
  assert.deepEqual(await storedValues(), [
    ['$workspace', '$provider', '$account', '2026-01-05', '$campaign', 0, 1000, 50, 1234],
  ]);
});

test('unrelated duplicate-key errors propagate; a partial page can be safely replayed', async () => {
  const first = INITIAL_PAGE.snapshots[0]!;
  const page = pageOf(first, { ...first, campaignId: 'campaign-conflict' });
  // This extra index exists only for this fault test, in the same collection.
  await store.snapshots.collection.createIndex({ 'metrics.clicks': 1 }, {
    unique: true, name: 'test_unrelated_clicks_unique',
  });
  try {
    await assert.rejects(importPage(store.snapshots, page), (error: unknown) => {
      assert.ok(error instanceof mongo.MongoServerError);
      assert.equal(error.code, 11000);
      assert.deepEqual(error.keyPattern, { 'metrics.clicks': 1 });
      return true;
    });
    assert.deepEqual(await storedValues(), [BASE_VALUES[0]]);
  } finally {
    await store.snapshots.collection.dropIndex('test_unrelated_clicks_unique');
  }
  await importPage(store.snapshots, page);
  assert.deepEqual(await storedValues(), [
    BASE_VALUES[0],
    ['workspace-a', 'synthetic-ads', 'account-1', '2026-01-05', 'campaign-conflict', 1, 1000, 50, 1234],
  ]);
  assert.deepEqual(await totals(), { impressions: 2000, clicks: 100, spendMinor: 2468 });
});

test('account history scopes and bounds results and uses the identity index on seeded data', async () => {
  await importPage(store.snapshots, querySeedPage());
  assert.equal(await store.snapshots.countDocuments(), 840);
  const rows = await getAccountHistory(store.snapshots, HISTORY_PARAMS);
  assert.ok(rows.every(row => row.workspaceId === 'workspace-a'
    && row.provider === 'synthetic-ads' && row.accountId === 'account-1'));
  assert.deepEqual(rows.map(row => [
    row.day.toISOString().slice(0, 10), row.campaignId, row.sourceRevision,
    row.metrics.impressions, row.metrics.clicks, row.metrics.spendMinor,
  ]), [
    ['2026-01-05', 'campaign-1', 1, 1410, 15, 141],
    ['2026-01-05', 'campaign-2', 1, 1420, 16, 142],
    ['2026-01-05', 'campaign-3', 1, 1430, 17, 143],
    ['2026-01-06', 'campaign-1', 1, 1510, 16, 151],
    ['2026-01-06', 'campaign-2', 1, 1520, 17, 152],
    ['2026-01-06', 'campaign-3', 1, 1530, 18, 153],
    ['2026-01-07', 'campaign-1', 1, 1610, 17, 161],
    ['2026-01-07', 'campaign-2', 1, 1620, 18, 162],
    ['2026-01-07', 'campaign-3', 1, 1630, 19, 163],
  ]);
  const plan = summarizeExplain(await accountHistoryQuery(store.snapshots, HISTORY_PARAMS)
    .explain('executionStats'));
  assert.deepEqual(plan.indexesUsed, [IDENTITY_INDEX_NAME]);
  assert.ok(plan.winningPlanStages.includes('IXSCAN'));
  assert.ok(!plan.winningPlanStages.includes('SORT'));
  assert.equal(plan.nReturned, 9);
  assert.equal(plan.totalDocsExamined, 9);
  assert.ok(plan.totalKeysExamined >= 9);
  console.info(`Unhinted history explain: ${JSON.stringify(plan)}`);
});

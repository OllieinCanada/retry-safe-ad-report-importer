import mongoose from 'mongoose';
import { connectStore } from './database.js';
import { startDisposableMongo } from './disposable.js';
import { summarizeExplain } from './explain.js';
import { CORRECTION, DELAYED_OLDER, HISTORY_PARAMS, INITIAL_PAGE, pageOf, querySeedPage } from './fixtures.js';
import { accountHistoryQuery, getAccountHistory } from './history.js';
import { importPage } from './importer.js';
import type { Metrics } from './snapshot.js';

async function main(): Promise<void> {
  const server = await startDisposableMongo();
  try {
    const store = await connectStore(server.getUri(), 'ad_report_importer_demo');
    try {
      const buildInfo = await store.connection.db!.admin().command({ buildInfo: 1 });
      async function state() {
        const rows = await store.snapshots.find().lean().exec();
        const totals = rows.reduce<Metrics>((sum, row) => ({
          impressions: sum.impressions + row.metrics.impressions,
          clicks: sum.clicks + row.metrics.clicks,
          spendMinor: sum.spendMinor + row.metrics.spendMinor,
        }), { impressions: 0, clicks: 0, spendMinor: 0 });
        return { rows: rows.length, totals };
      }

      await importPage(store.snapshots, INITIAL_PAGE);
      const initial = await state();
      await importPage(store.snapshots, INITIAL_PAGE);
      const replay = await state();
      await importPage(store.snapshots, pageOf(CORRECTION));
      const corrected = await state();
      await importPage(store.snapshots, pageOf(DELAYED_OLDER));
      const delayedOlder = await state();
      const history = (await getAccountHistory(store.snapshots, HISTORY_PARAMS)).map(row => ({
        day: row.day.toISOString().slice(0, 10), campaignId: row.campaignId,
        sourceRevision: row.sourceRevision, metrics: row.metrics,
      }));

      // Reset only this disposable fixture, then explain the same history query
      // against a larger, selective seed in the one snapshots collection.
      await store.snapshots.deleteMany({}).exec();
      await importPage(store.snapshots, querySeedPage());
      const explain = await accountHistoryQuery(store.snapshots, HISTORY_PARAMS)
        .explain('executionStats');

      console.log(JSON.stringify({
        versions: { node: process.version, mongoose: mongoose.version, mongodb: buildInfo.version },
        importExample: { initial, replay, corrected, delayedOlder, history },
        queryExample: {
          seededSnapshots: await store.snapshots.countDocuments().exec(),
          params: HISTORY_PARAMS,
          sort: { day: 1, campaignId: 1 },
          explain: summarizeExplain(explain),
        },
      }, null, 2));
    } finally {
      await store.connection.close();
    }
  } finally {
    await server.stop();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

import type { AccountHistoryParams } from './history.js';
import type { ReportPage, SnapshotInput } from './snapshot.js';

export const INITIAL_PAGE: ReportPage = {
  pageId: 'initial-page',
  snapshots: [
    { workspaceId: 'workspace-a', provider: 'synthetic-ads', accountId: 'account-1',
      day: '2026-01-05', campaignId: 'campaign-alpha', sourceRevision: 1,
      metrics: { impressions: 1000, clicks: 50, spendMinor: 1234 } },
    { workspaceId: 'workspace-a', provider: 'synthetic-ads', accountId: 'account-1',
      day: '2026-01-05', campaignId: 'campaign-beta', sourceRevision: 1,
      metrics: { impressions: 600, clicks: 20, spendMinor: 500 } },
    { workspaceId: 'workspace-a', provider: 'synthetic-ads', accountId: 'account-1',
      day: '2026-01-06', campaignId: 'campaign-alpha', sourceRevision: 2,
      metrics: { impressions: 800, clicks: 30, spendMinor: 900 } },
    { workspaceId: 'workspace-a', provider: 'synthetic-ads', accountId: 'account-1',
      day: '2026-01-06', campaignId: 'campaign-beta', sourceRevision: 1,
      metrics: { impressions: 200, clicks: 10, spendMinor: 200 } },
  ],
};

export const CORRECTION: SnapshotInput = {
  workspaceId: 'workspace-a', provider: 'synthetic-ads', accountId: 'account-1',
  day: '2026-01-05', campaignId: 'campaign-alpha', sourceRevision: 3,
  metrics: { impressions: 1200, clicks: 60, spendMinor: 1400 },
};

export const DELAYED_OLDER: SnapshotInput = {
  ...CORRECTION, sourceRevision: 2,
  metrics: { impressions: 1100, clicks: 55, spendMinor: 1300 },
};

export function pageOf(...snapshots: SnapshotInput[]): ReportPage {
  return { pageId: 'synthetic-page', snapshots };
}

export const HISTORY_PARAMS: AccountHistoryParams = {
  workspaceId: 'workspace-a', provider: 'synthetic-ads', accountId: 'account-1',
  fromDay: '2026-01-05', toDayExclusive: '2026-01-08',
};

// A fixed Cartesian fixture: 2 workspaces × 2 providers × 5 accounts × 14 days
// × 3 campaigns = 840 rows. No randomness or clock-dependent data.
export function querySeedPage(): ReportPage {
  const snapshots: SnapshotInput[] = [];
  for (const workspaceId of ['workspace-a', 'workspace-b']) {
    for (const provider of ['synthetic-ads', 'other-synthetic-ads']) {
      for (let account = 1; account <= 5; account++) {
        for (let day = 0; day < 14; day++) {
          for (let campaign = 1; campaign <= 3; campaign++) {
            snapshots.push({
              workspaceId, provider, accountId: `account-${account}`,
              day: `2026-01-${String(day + 1).padStart(2, '0')}`,
              campaignId: `campaign-${campaign}`, sourceRevision: 1,
              metrics: {
                impressions: 1000 + day * 100 + campaign * 10,
                clicks: 10 + day + campaign,
                spendMinor: 100 + day * 10 + campaign,
              },
            });
          }
        }
      }
    }
  }
  return { pageId: 'query-seed', snapshots };
}

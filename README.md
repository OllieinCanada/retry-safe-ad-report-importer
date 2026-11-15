# Retry-safe MongoDB ad report importer

## Problem

An ads API returns daily campaign metrics in pages. Queue retries, overlapping workers, and delayed reports can duplicate totals or undo corrections. This standalone portfolio exercise uses synthetic data to demonstrate an AdKit-relevant backend problem; it makes no claim about AdKit's implementation or product.

## Fix

One `snapshots` collection holds the current snapshot for each campaign/day. The unique `snapshot_identity` index is ordered **workspaceId → provider → accountId → day → campaignId**, all ascending. Its first three fields match the account query's equality filters; `day` supports the date range, and `(day, campaignId)` supplies the sort. Each write matches only that identity and uses one atomic update pipeline: a strictly higher revision replaces the revision and entire metrics object together. There is no increment or read-before-write. The index also prevents duplicate identities under competing inserts.

Fixture assumptions:

- Each row is a complete snapshot, not a delta. Transport `pageId` is not a deduplication key.
- Input days are real `YYYY-MM-DD` UTC calendar days, stored as UTC-midnight BSON dates. Counters, spend, and revisions are nonnegative safe integers. All synthetic accounts use USD; `spendMinor` is cents.
- Revisions are ordered **within each snapshot identity**. Larger means newer; arrival time and page order do not establish freshness. Revision zero is valid.
- Equal revisions keep the first accepted payload, even if metrics differ. Concurrent ties have no guaranteed winner. An authoritative correction must increase its revision.

The importer validates inputs before constructing pipelines because Mongoose does not cast or validate pipeline updates. It awaits index creation before use. An exposed duplicate-key insert race is retried once without upsert only when error `11000` has the exact identity index pattern and attempted key values. Other errors propagate; a retry that finds no winner also fails.

Atomicity is per document. A page can partially complete before a database error, then be safely replayed under these rules. Upstream delivery is not assumed to be exactly once. “History” means current snapshots across reporting days; prior revisions are discarded.

## Tests

Requires Node.js 24 (`.nvmrc` pins 24.22.1). From this directory, run these exact verified commands:

```bash
npm ci --no-audit --no-fund
npm run typecheck
npm run build
npm test
npm run demo
```

The first test run downloads and checksum-verifies MongoDB 8.0.12 (about 96 MiB), cached under `.cache/`. `mongodb-memory-server` launches a **real `mongod` process** using WiredTiger on loopback with temporary storage. Tests and the compiled demo each start their own server, close connections, stop it, and remove its temporary data. Docker, credentials, and an existing database are unnecessary. Download/startup failures fail the run rather than skipping database verification.

**Result: 20 passed, 0 failed, 0 cancelled, 0 skipped.** Strict type checking and the build also passed.

The **12 integration tests** assert stored values and totals for first import, replay, two concurrent worker connections, correction replacement, delayed stale delivery, equal-revision conflicts, concurrent revision ordering (existing and new documents), workspace isolation, and revision-zero/literal identifiers. They also prove that an unrelated unique-index error propagates after partial page completion, replay safely finishes that page, and the account history query respects scope, bounds, ordering, and index use. Setup verifies the ordered unique index before any importer test.

The **8 unit tests** use fault injection for rare duplicate-key recovery/error branches and validate inputs. All stored-state and query-plan proofs come from the integration tests against MongoDB.

## Evidence

Verified on Debian 13/x86_64 with Node **24.22.1**, npm **11.9.0**, TypeScript **7.0.2**, Mongoose **9.12.1**, and MongoDB **8.0.12**. See the [command transcript](evidence/verification.txt) and [captured demo JSON](evidence/demo.json).

The compiled demo produced:

| Import step | Rows | Impressions | Clicks | Spend, USD cents |
| --- | ---: | ---: | ---: | ---: |
| Initial | 4 | 2600 | 110 | 2834 |
| Identical replay | 4 | 2600 | 110 | 2834 |
| Revision 3 correction | 4 | 2800 | 120 | 3000 |
| Delayed revision 2 | 4 | 2800 | 120 | 3000 |

For the query example, the demo resets its disposable collection and seeds **840** fixed snapshots: 2 workspaces × 2 providers × 5 accounts × 14 days × 3 campaigns. It queries `workspace-a / synthetic-ads / account-1`, from `2026-01-05` inclusive to `2026-01-08` exclusive, sorted by day and campaign. This is the same full-document history query used by the importer example, with no index hint.

Compact projection of its actual `explain('executionStats')` output:

```json
{
  "winningPlanStages": ["FETCH", "IXSCAN"],
  "indexesUsed": ["snapshot_identity"],
  "nReturned": 9,
  "totalKeysExamined": 9,
  "totalDocsExamined": 9
}
```

These counters establish index use on this fixture; no timing-based speedup is claimed. The project runs locally, with no live ad API, real credentials, UI, or cloud deployment.

I built a standalone TypeScript and Mongoose importer for a hypothetical daily ads reporting workflow, using a compound unique index and atomic revision checks to prevent retry inflation and stale overwrites. I verified its behavior with 12 integration tests against disposable MongoDB, added 8 focused unit tests, and confirmed that the account/date-range query used the intended index and examined 9 documents for 9 results on an 840-snapshot fixture.

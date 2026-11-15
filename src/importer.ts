import { mongo, type Model, type UpdateWithAggregationPipeline } from 'mongoose';
import {
  IDENTITY_INDEX,
  normalizeSnapshot,
  type ReportPage,
  type Snapshot,
  type SnapshotIdentity,
} from './snapshot.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Fail closed: an E11000 on _id, another index, another identity, or without
// structured key metadata is not an expected insert race.
export function isIdentityInsertConflict(error: unknown, identity: SnapshotIdentity): boolean {
  if (!(error instanceof mongo.MongoServerError) || error.code !== 11000) return false;
  const pattern: unknown = error.keyPattern;
  const values: unknown = error.keyValue;
  if (!isRecord(pattern) || !isRecord(values)) return false;

  const keys = Object.keys(IDENTITY_INDEX) as (keyof SnapshotIdentity)[];
  const patternKeys = Object.keys(pattern);
  if (patternKeys.length !== keys.length || Object.keys(values).length !== keys.length) return false;

  return keys.every((key, position) => {
    if (patternKeys[position] !== key || pattern[key] !== 1) return false;
    const value = values[key];
    return key === 'day'
      ? value instanceof Date && value.getTime() === identity.day.getTime()
      : value === identity[key];
  });
}

function replacementPipeline(snapshot: Snapshot): UpdateWithAggregationPipeline {
  // Valid revisions start at zero, so -1 represents a new document. All $set
  // expressions evaluate the same pre-update revision, including under races.
  const isNewer = {
    $gt: [{ $literal: snapshot.sourceRevision }, { $ifNull: ['$sourceRevision', -1] }],
  };
  return [{
    $set: {
      workspaceId: { $literal: snapshot.workspaceId },
      provider: { $literal: snapshot.provider },
      accountId: { $literal: snapshot.accountId },
      day: { $literal: snapshot.day },
      campaignId: { $literal: snapshot.campaignId },
      sourceRevision: { $cond: [isNewer, { $literal: snapshot.sourceRevision }, '$sourceRevision'] },
      metrics: { $cond: [isNewer, { $literal: snapshot.metrics }, '$metrics'] },
    },
  }];
}

async function upsertSnapshot(model: Model<Snapshot>, snapshot: Snapshot): Promise<void> {
  const { workspaceId, provider, accountId, day, campaignId } = snapshot;
  const identity: SnapshotIdentity = { workspaceId, provider, accountId, day, campaignId };
  const pipeline = replacementPipeline(snapshot);
  try {
    await model.updateOne(identity, pipeline, {
      upsert: true,
      updatePipeline: true,
      setDefaultsOnInsert: false,
    }).exec();
  } catch (error) {
    if (!isIdentityInsertConflict(error, identity)) throw error;

    // Another insert won. Re-evaluate the revision atomically on its document;
    // do not read it and then blindly overwrite it or mask unrelated errors.
    const result = await model.updateOne(identity, pipeline, {
      upsert: false,
      updatePipeline: true,
      setDefaultsOnInsert: false,
    }).exec();
    if (result.matchedCount !== 1) throw error;
  }
}

export async function importPage(model: Model<Snapshot>, page: ReportPage): Promise<void> {
  const snapshots = page.snapshots.map(normalizeSnapshot);
  for (const snapshot of snapshots) {
    await upsertSnapshot(model, snapshot);
  }
}

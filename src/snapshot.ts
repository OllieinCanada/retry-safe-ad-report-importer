import { Schema } from 'mongoose';

export interface Metrics {
  impressions: number;
  clicks: number;
  spendMinor: number;
}

export interface SnapshotIdentity {
  workspaceId: string;
  provider: string;
  accountId: string;
  day: Date;
  campaignId: string;
}

export interface Snapshot extends SnapshotIdentity {
  sourceRevision: number;
  metrics: Metrics;
}

export interface SnapshotInput extends Omit<Snapshot, 'day'> {
  day: string;
}

export interface ReportPage {
  pageId: string;
  snapshots: readonly SnapshotInput[];
}

export const IDENTITY_INDEX_NAME = 'snapshot_identity';
export const IDENTITY_INDEX = {
  workspaceId: 1,
  provider: 1,
  accountId: 1,
  day: 1,
  campaignId: 1,
} as const;

const counter = {
  type: Number,
  required: true,
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
  validate: Number.isSafeInteger,
};

const metricsSchema = new Schema<Metrics>(
  { impressions: counter, clicks: counter, spendMinor: counter },
  { _id: false },
);

export const snapshotSchema = new Schema<Snapshot>(
  {
    workspaceId: { type: String, required: true },
    provider: { type: String, required: true },
    accountId: { type: String, required: true },
    day: { type: Date, required: true },
    campaignId: { type: String, required: true },
    sourceRevision: counter,
    metrics: { type: metricsSchema, required: true },
  },
  {
    collection: 'snapshots',
    versionKey: false,
    timestamps: false,
    autoIndex: false,
    autoCreate: false,
    bufferCommands: false,
  },
);

snapshotSchema.index(IDENTITY_INDEX, { unique: true, name: IDENTITY_INDEX_NAME });

export function requireIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a nonempty string`);
  }
  return value;
}

export function parseReportingDay(value: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError('day must be a UTC calendar day in YYYY-MM-DD format');
  }
  const day = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) {
    throw new TypeError('day must be a real UTC calendar day');
  }
  return day;
}

function requireCounter(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

// Mongoose does not cast or validate aggregation update pipelines. Validate and
// copy the complete input here, before any pipeline is sent to MongoDB.
export function normalizeSnapshot(input: SnapshotInput): Snapshot {
  return {
    workspaceId: requireIdentifier(input.workspaceId, 'workspaceId'),
    provider: requireIdentifier(input.provider, 'provider'),
    accountId: requireIdentifier(input.accountId, 'accountId'),
    day: parseReportingDay(input.day),
    campaignId: requireIdentifier(input.campaignId, 'campaignId'),
    sourceRevision: requireCounter(input.sourceRevision, 'sourceRevision'),
    metrics: {
      impressions: requireCounter(input.metrics.impressions, 'impressions'),
      clicks: requireCounter(input.metrics.clicks, 'clicks'),
      spendMinor: requireCounter(input.metrics.spendMinor, 'spendMinor'),
    },
  };
}

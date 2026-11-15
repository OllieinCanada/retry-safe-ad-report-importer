import type { Model } from 'mongoose';
import { parseReportingDay, requireIdentifier, type Snapshot } from './snapshot.js';

export interface AccountHistoryParams {
  workspaceId: string;
  provider: string;
  accountId: string;
  fromDay: string;
  toDayExclusive: string;
}

// The demo explains this exact query, with no hint or alternate projection.
export function accountHistoryQuery(model: Model<Snapshot>, params: AccountHistoryParams) {
  const from = parseReportingDay(params.fromDay);
  const to = parseReportingDay(params.toDayExclusive);
  if (from >= to) throw new RangeError('fromDay must precede toDayExclusive');
  return model.find({
    workspaceId: requireIdentifier(params.workspaceId, 'workspaceId'),
    provider: requireIdentifier(params.provider, 'provider'),
    accountId: requireIdentifier(params.accountId, 'accountId'),
    day: { $gte: from, $lt: to },
  }).sort({ day: 1, campaignId: 1 }).lean();
}

export async function getAccountHistory(model: Model<Snapshot>, params: AccountHistoryParams) {
  return accountHistoryQuery(model, params).exec();
}

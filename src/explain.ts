export interface ExplainSummary {
  winningPlanStages: string[];
  indexesUsed: string[];
  nReturned: number;
  totalKeysExamined: number;
  totalDocsExamined: number;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected an explain plan object');
  }
  return value as Record<string, unknown>;
}

export function summarizeExplain(explain: unknown): ExplainSummary {
  const root = record(explain);
  const planner = record(root.queryPlanner);
  const stats = record(root.executionStats);
  const stages = new Set<string>();
  const indexes = new Set<string>();
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (typeof value === 'object' && value !== null) {
      const node = value as Record<string, unknown>;
      if (typeof node.stage === 'string') stages.add(node.stage);
      if (typeof node.indexName === 'string') indexes.add(node.indexName);
      Object.values(node).forEach(visit);
    }
  }
  // Rejected plans must never be reported as the index actually used.
  visit(planner.winningPlan);
  function count(name: string): number {
    const value = stats[name];
    if (typeof value !== 'number') throw new TypeError(`Missing executionStats.${name}`);
    return value;
  }
  return {
    winningPlanStages: [...stages],
    indexesUsed: [...indexes],
    nReturned: count('nReturned'),
    totalKeysExamined: count('totalKeysExamined'),
    totalDocsExamined: count('totalDocsExamined'),
  };
}

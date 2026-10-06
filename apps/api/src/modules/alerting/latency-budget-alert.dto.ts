/** T9: "Instrument and enforce p95 <5s on the agent respond path... alert/log if p95 exceeds budget." */
export interface LatencyBudgetAlert {
  tenantId: string;
  p95LatencyMs: number;
  budgetMs: number;
  windowMinutes: number;
  sampleSize: number;
}

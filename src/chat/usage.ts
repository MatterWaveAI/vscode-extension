import type { AnswerUsage } from "./protocol";

/**
 * One answer's usage as the line under it reads: tokens in and out, and the
 * cost at list price when the model has one -- four places for a fraction
 * of a cent, two for anything larger, and "under" for less than shows.
 */
export function answerUsageLabel(usage: AnswerUsage): string {
  const tokens = `${usage.promptTokens.toLocaleString("en-US")} in · ${usage.completionTokens.toLocaleString("en-US")} out`;
  if (usage.costUsd === null) return tokens;
  const cost = usage.costUsd;
  const money = cost === 0 ? "$0" : cost < 0.0001 ? "under $0.0001" : `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
  return `${tokens} · ${money}`;
}

import type { WorkSource } from "./state";

export interface FailureSummary {
  count: number;
  reason: string;
  detail: string;
  sources: string[];
}

const NOT_CHECKED_OUT = /can't cd to|No such file or directory/i;
const NO_HIVE = /error_type": "ConfigError|requires setup|not a beads/i;
const DOLT_DOWN = /Dolt server unreachable|connection refused/i;

export function failureReason(error: string): string {
  if (DOLT_DOWN.test(error)) return "Dolt is not running";
  if (NOT_CHECKED_OUT.test(error)) return "not checked out";
  if (NO_HIVE.test(error)) return "not a working hive";
  return "unreachable";
}

export function summarizeFailures(sources: readonly WorkSource[]): FailureSummary[] {
  const byReason = new Map<string, FailureSummary>();
  for (const source of sources) {
    if (source.state !== "failed") continue;
    const reason = failureReason(source.error ?? "");
    const existing = byReason.get(reason);
    if (existing) {
      existing.count++;
      existing.sources.push(source.key);
    } else {
      byReason.set(reason, { count: 1, reason, detail: source.error ?? "", sources: [source.key] });
    }
  }
  return [...byReason.values()].sort((a, b) => b.count - a.count);
}

export function onboardingHint(summaries: readonly FailureSummary[], totalSources: number): string {
  if (!summaries.length) return "";
  const failed = summaries.reduce((sum, s) => sum + s.count, 0);
  if (failed < totalSources) return "";
  if (summaries.every((s) => s.reason === "not checked out")) {
    return "This agent computer knows the fleet but has no repos checked out — it was never onboarded.";
  }
  if (summaries.some((s) => s.reason === "Dolt is not running")) {
    return "The bead store is not running on this agent computer.";
  }
  return "This agent computer cannot read any hive in the fleet.";
}

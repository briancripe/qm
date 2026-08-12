import { shq } from "../util/shell.ts";
import { enumerateBeadhiveHives, type BeadhiveHive, type HiveExec } from "../projects/beadhive-hives.ts";
import { errMessage } from "../util/errors.ts";
import { withScopeExec } from "./scope-exec.ts";
import type { Sandbox } from "../sandbox/sandbox.ts";
import type { ScopeId } from "../types.ts";
import type { ProjectWorkItem, ProjectWorkSnapshot, ProjectWorkSource } from "../projects/project-provider.ts";

export const READY_TRUNCATED_EXIT = 3;
export const WORK_ITEMS_PER_HIVE = 25;
export const BEADHIVE_PROVIDER_ID = "beadhive";

interface RawBead {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  priority?: unknown;
  issue_type?: unknown;
  owner?: unknown;
  updated_at?: unknown;
  dependency_count?: unknown;
  dependent_count?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function shapeReadyBeads(
  stdout: string,
  limit = WORK_ITEMS_PER_HIVE,
): { items: ProjectWorkItem[]; total: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim() || "[]");
  } catch {
    return { items: [], total: 0 };
  }
  if (!Array.isArray(parsed)) return { items: [], total: 0 };
  const items = parsed
    .filter((b): b is RawBead => typeof b === "object" && b !== null)
    .filter((b) => str(b.id))
    .slice(0, limit)
    .map((b) => ({
      id: str(b.id),
      title: str(b.title),
      status: str(b.status),
      priority: num(b.priority),
      kind: str(b.issue_type),
      ...(str(b.owner) ? { owner: str(b.owner) } : {}),
      ...(str(b.updated_at) ? { updatedAt: str(b.updated_at) } : {}),
      blockedBy: num(b.dependency_count),
      blocks: num(b.dependent_count),
    }));
  return { items, total: parsed.length };
}

export function hiveKey(hive: BeadhiveHive): string {
  return `${hive.provider}/${hive.org}/${hive.repo}`;
}

export function hiveRepoPath(workspacePath: string, hive: BeadhiveHive): string {
  return `${workspacePath.replace(/\/+$/, "")}/${hiveKey(hive)}`;
}

export function readyCommand(workspacePath: string, hive: BeadhiveHive): string {
  return `cd ${shq(hiveRepoPath(workspacePath, hive))} && bh work ready --json`;
}

export function prepareCommand(bhHome: string, override?: string): string {
  const configured = override?.trim();
  if (configured) return configured;
  const hq = `${bhHome.replace(/\/+$/, "")}/hq`;
  return `cd ${shq(hq)} && { bd dolt start >/dev/null 2>&1 || true; bh setup check >/dev/null 2>&1 || true; }`;
}

const WARNING_LINE = /^\s*(warning|note|hint)\b[:\s]/i;

export function failureMessage(stderr: string, code: number): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const signalled = lines.find((line) => /^(error|✗|✖)\b|^error:/i.test(line));
  if (signalled) return signalled;
  const substantive = lines.filter((line) => !WARNING_LINE.test(line));
  return substantive[0] ?? lines[0] ?? `exit ${code}`;
}

export interface CollectWorkOptions {
  exec: HiveExec;
  hives: readonly BeadhiveHive[];
  workspacePath: string;
  now: number;
  itemsPerHive?: number;
}

export async function collectBeadhiveWork(opts: CollectWorkOptions): Promise<ProjectWorkSnapshot> {
  const limit = opts.itemsPerHive ?? WORK_ITEMS_PER_HIVE;
  const sources: ProjectWorkSource[] = [];
  for (const hive of opts.hives) {
    const base = { key: hiveKey(hive), name: hive.repo };
    try {
      const r = await opts.exec(readyCommand(opts.workspacePath, hive));
      if (r.code !== 0 && r.code !== READY_TRUNCATED_EXIT) {
        sources.push({
          ...base,
          state: "failed",
          items: [],
          total: 0,
          error: failureMessage(r.stderr, r.code),
        });
        continue;
      }
      const { items, total } = shapeReadyBeads(r.stdout, limit);
      sources.push({
        ...base,
        state: r.code === READY_TRUNCATED_EXIT || total > items.length ? "truncated" : "ok",
        items,
        total,
      });
    } catch (e) {
      sources.push({ ...base, state: "failed", items: [], total: 0, error: errMessage(e) });
    }
  }
  return {
    providerId: BEADHIVE_PROVIDER_ID,
    asOf: opts.now,
    sources,
    total: sources.reduce((sum, s) => sum + s.total, 0),
    reachedEvery: sources.every((s) => s.state !== "failed"),
  };
}

export interface ScopeWorkOptions {
  sandbox: Sandbox;
  scope: ScopeId;
  bhHome: string;
  workspacePath: string;
  now: () => number;
  prepare?: string;
}

export async function collectScopeWork(opts: ScopeWorkOptions): Promise<ProjectWorkSnapshot> {
  return withScopeExec(opts.sandbox, opts.scope, async (exec) => {
    await exec(prepareCommand(opts.bhHome, opts.prepare));
    const hives = await enumerateBeadhiveHives(exec, opts.bhHome);
    return collectBeadhiveWork({ exec, hives, workspacePath: opts.workspacePath, now: opts.now() });
  });
}

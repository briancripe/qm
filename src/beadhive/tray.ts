import { shq } from "../util/shell.ts";
import { enumerateBeadhiveHives, type BeadhiveHive, type HiveExec } from "../projects/beadhive-hives.ts";
import { errMessage } from "../util/errors.ts";
import { withScopeExec } from "./scope-exec.ts";
import type { Sandbox } from "../sandbox/sandbox.ts";
import type { ScopeId } from "../types.ts";

export const READY_TRUNCATED_EXIT = 3;
export const TRAY_BEADS_PER_HIVE = 25;

export interface TrayBead {
  id: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
  owner?: string;
  updatedAt?: string;
  blockedBy: number;
  blocks: number;
}

export type TrayHiveState = "ok" | "truncated" | "failed";

export interface TrayHive {
  provider: string;
  org: string;
  repo: string;
  state: TrayHiveState;
  ready: TrayBead[];
  readyTotal: number;
  error?: string;
}

export interface TraySnapshot {
  asOf: number;
  hives: TrayHive[];
  readyTotal: number;
  reachedEvery: boolean;
}

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

export function shapeReadyBeads(stdout: string, limit = TRAY_BEADS_PER_HIVE): { beads: TrayBead[]; total: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim() || "[]");
  } catch {
    return { beads: [], total: 0 };
  }
  if (!Array.isArray(parsed)) return { beads: [], total: 0 };
  const beads = parsed
    .filter((b): b is RawBead => typeof b === "object" && b !== null)
    .filter((b) => str(b.id))
    .slice(0, limit)
    .map((b) => ({
      id: str(b.id),
      title: str(b.title),
      status: str(b.status),
      priority: num(b.priority),
      issueType: str(b.issue_type),
      ...(str(b.owner) ? { owner: str(b.owner) } : {}),
      ...(str(b.updated_at) ? { updatedAt: str(b.updated_at) } : {}),
      blockedBy: num(b.dependency_count),
      blocks: num(b.dependent_count),
    }));
  return { beads, total: parsed.length };
}

export function hiveRepoPath(workspacePath: string, hive: BeadhiveHive): string {
  return `${workspacePath.replace(/\/+$/, "")}/${hive.provider}/${hive.org}/${hive.repo}`;
}

export function readyCommand(workspacePath: string, hive: BeadhiveHive): string {
  return `cd ${shq(hiveRepoPath(workspacePath, hive))} && bh work ready --json`;
}

export interface CollectTrayOptions {
  exec: HiveExec;
  hives: readonly BeadhiveHive[];
  workspacePath: string;
  now: number;
  beadsPerHive?: number;
}

export async function collectTraySnapshot(opts: CollectTrayOptions): Promise<TraySnapshot> {
  const limit = opts.beadsPerHive ?? TRAY_BEADS_PER_HIVE;
  const hives: TrayHive[] = [];
  for (const hive of opts.hives) {
    const base = { provider: hive.provider, org: hive.org, repo: hive.repo };
    try {
      const r = await opts.exec(readyCommand(opts.workspacePath, hive));
      if (r.code !== 0 && r.code !== READY_TRUNCATED_EXIT) {
        hives.push({
          ...base,
          state: "failed",
          ready: [],
          readyTotal: 0,
          error: r.stderr.trim().split("\n")[0] || `exit ${r.code}`,
        });
        continue;
      }
      const { beads, total } = shapeReadyBeads(r.stdout, limit);
      hives.push({
        ...base,
        state: r.code === READY_TRUNCATED_EXIT || total > beads.length ? "truncated" : "ok",
        ready: beads,
        readyTotal: total,
      });
    } catch (e) {
      hives.push({ ...base, state: "failed", ready: [], readyTotal: 0, error: errMessage(e) });
    }
  }
  return {
    asOf: opts.now,
    hives,
    readyTotal: hives.reduce((sum, h) => sum + h.readyTotal, 0),
    reachedEvery: hives.every((h) => h.state !== "failed"),
  };
}

export interface ScopeTrayOptions {
  sandbox: Sandbox;
  scope: ScopeId;
  bhHome: string;
  workspacePath: string;
  now: () => number;
}

export async function collectScopeTray(opts: ScopeTrayOptions): Promise<TraySnapshot> {
  return withScopeExec(opts.sandbox, opts.scope, async (exec) => {
    const hives = await enumerateBeadhiveHives(exec, opts.bhHome);
    return collectTraySnapshot({ exec, hives, workspacePath: opts.workspacePath, now: opts.now() });
  });
}

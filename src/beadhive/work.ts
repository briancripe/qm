import { shq } from "../util/shell.ts";
import { enumerateBeadhiveHives, type BeadhiveHive, type HiveExec } from "../projects/beadhive-hives.ts";
import { errMessage } from "../util/errors.ts";
import { withScopeExec } from "./scope-exec.ts";
import type { LocalSandboxVolumeMount, Sandbox } from "../sandbox/sandbox.ts";
import type { ScopeId } from "../types.ts";
import type { ProjectWorkItem, ProjectWorkSnapshot, ProjectWorkSource } from "../projects/project-provider.ts";

export const READY_TRUNCATED_EXIT = 3;
export const WORK_ITEMS_PER_HIVE = 300;
export const BEADHIVE_PROVIDER_ID = "beadhive";

interface RawBead {
  id?: unknown;
  dependencies?: unknown;
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

export function hiveKey(hive: BeadhiveHive): string {
  return `${hive.provider}/${hive.org}/${hive.repo}`;
}

export function hiveRepoPath(workspacePath: string, hive: BeadhiveHive): string {
  return `${workspacePath.replace(/\/+$/, "")}/${hiveKey(hive)}`;
}

export function readyCommand(workspacePath: string, hive: BeadhiveHive): string {
  return `cd ${shq(hiveRepoPath(workspacePath, hive))} && bh work ready --json`;
}

export function listCommand(workspacePath: string, hive: BeadhiveHive): string {
  return `cd ${shq(hiveRepoPath(workspacePath, hive))} && bh work list --json`;
}

export function gateCommand(workspacePath: string, hive: BeadhiveHive): string {
  return `cd ${shq(hiveRepoPath(workspacePath, hive))} && bd gate list --json`;
}

const CONTAINER_KINDS = new Set(["molecule", "epic"]);

export function parentOf(id: string, known: ReadonlySet<string>): string | undefined {
  const cut = id.lastIndexOf(".");
  if (cut <= 0) return undefined;
  const parent = id.slice(0, cut);
  return known.has(parent) ? parent : undefined;
}

export function shapeTasks(
  listStdout: string,
  readyStdout: string,
  gateStdout: string,
  limit = WORK_ITEMS_PER_HIVE,
): { items: ProjectWorkItem[]; total: number } {
  const rows = parseRows(listStdout);
  if (!rows.length) return { items: [], total: 0 };
  const readyIds = new Set(parseRows(readyStdout).map((r) => str(r.id)));
  const gatedIds = new Set(
    parseRows(gateStdout)
      .filter((r) => str(r.status) !== "closed")
      .flatMap((r) => [str(r.id), ...(Array.isArray(r.dependencies) ? r.dependencies.map(str) : [])])
      .filter(Boolean),
  );
  const known = new Set(rows.map((r) => str(r.id)).filter(Boolean));
  const items = rows
    .filter((r) => str(r.id))
    .slice(0, limit)
    .map((r) => {
      const id = str(r.id);
      const kind = str(r.issue_type);
      const parent = parentOf(id, known);
      return {
        id,
        title: str(r.title),
        status: str(r.status),
        priority: num(r.priority),
        kind,
        ...(str(r.owner) ? { owner: str(r.owner) } : {}),
        ...(str(r.updated_at) ? { updatedAt: str(r.updated_at) } : {}),
        blockedBy: num(r.dependency_count),
        blocks: num(r.dependent_count),
        ...(parent ? { parentId: parent } : {}),
        state: taskState(id, str(r.status), readyIds, gatedIds, num(r.dependency_count)),
        ...(CONTAINER_KINDS.has(kind) ? { container: true } : {}),
      };
    });
  return { items, total: rows.length };
}

function taskState(
  id: string,
  status: string,
  readyIds: ReadonlySet<string>,
  gatedIds: ReadonlySet<string>,
  blockedBy: number,
): ProjectWorkItem["state"] {
  if (gatedIds.has(id)) return "needs_review";
  if (status === "in_progress") return "in_progress";
  if (readyIds.has(id)) return "ready";
  return blockedBy > 0 ? "blocked" : "ready";
}

function parseRows(stdout: string): RawBead[] {
  try {
    const parsed: unknown = JSON.parse(stdout.trim() || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((b): b is RawBead => typeof b === "object" && b !== null);
  } catch {
    return [];
  }
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
      const list = await opts.exec(listCommand(opts.workspacePath, hive));
      if (list.code !== 0 && list.code !== READY_TRUNCATED_EXIT) {
        sources.push({ ...base, state: "failed", items: [], total: 0, error: failureMessage(list.stderr, list.code) });
        continue;
      }
      const ready = await opts.exec(readyCommand(opts.workspacePath, hive));
      const gates = await opts.exec(gateCommand(opts.workspacePath, hive));
      const { items, total } = shapeTasks(list.stdout, ready.stdout, gates.stdout, limit);
      sources.push({
        ...base,
        state: total > items.length ? "truncated" : "ok",
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
  volumes?: readonly LocalSandboxVolumeMount[];
}

export async function collectScopeWork(opts: ScopeWorkOptions): Promise<ProjectWorkSnapshot> {
  return withScopeExec(
    opts.sandbox,
    opts.scope,
    async (exec) => {
      await exec(prepareCommand(opts.bhHome, opts.prepare));
      const hives = await enumerateBeadhiveHives(exec, opts.bhHome);
      return collectBeadhiveWork({ exec, hives, workspacePath: opts.workspacePath, now: opts.now() });
    },
    opts.volumes?.length ? { volumes: opts.volumes } : {},
  );
}

import type { DurableMap } from "../persistence/durable-map.ts";
import { errMessage } from "../util/errors.ts";
import type { ProjectWorkSnapshot } from "./project-provider.ts";

export const WORK_MIN_REFRESH_MS = 30_000;
export const WORK_EXEC_TIMEOUT_MS = 120_000;

export interface PersistedProjectWorkSnapshot {
  scopeId: string;
  snapshot: ProjectWorkSnapshot;
}

export type WorkRefresh =
  | { status: "refreshed"; snapshot: ProjectWorkSnapshot }
  | { status: "in_flight"; snapshot: ProjectWorkSnapshot | null }
  | { status: "rate_limited"; snapshot: ProjectWorkSnapshot; retryAfterMs: number }
  | { status: "failed"; snapshot: ProjectWorkSnapshot | null; message: string };

export interface WorkStore {
  get(scopeId: string): Promise<ProjectWorkSnapshot | null>;
  refresh(scopeId: string, opts?: { force?: boolean }): Promise<WorkRefresh>;
}

export interface WorkStoreOptions {
  backing: DurableMap<PersistedProjectWorkSnapshot>;
  collect: (scopeId: string) => Promise<ProjectWorkSnapshot>;
  now?: () => number;
  minRefreshMs?: number;
}

export function createWorkStore(opts: WorkStoreOptions): WorkStore {
  const now = opts.now ?? Date.now;
  const minRefreshMs = opts.minRefreshMs ?? WORK_MIN_REFRESH_MS;
  const inFlight = new Map<string, Promise<WorkRefresh>>();

  const read = async (scopeId: string): Promise<ProjectWorkSnapshot | null> =>
    (await opts.backing.get(scopeId))?.snapshot ?? null;

  async function runRefresh(scopeId: string, force: boolean): Promise<WorkRefresh> {
    const stored = await read(scopeId);
    const age = stored ? now() - stored.asOf : Infinity;
    if (stored && !force && age < minRefreshMs) {
      return { status: "rate_limited", snapshot: stored, retryAfterMs: minRefreshMs - age };
    }
    try {
      const snapshot = await opts.collect(scopeId);
      await opts.backing.put(scopeId, { scopeId, snapshot });
      return { status: "refreshed", snapshot };
    } catch (e) {
      return { status: "failed", snapshot: stored, message: errMessage(e) };
    }
  }

  return {
    get: read,

    refresh(scopeId, refreshOpts) {
      const running = inFlight.get(scopeId);
      if (running) {
        return read(scopeId).then((snapshot): WorkRefresh => ({ status: "in_flight", snapshot }));
      }
      const run = runRefresh(scopeId, refreshOpts?.force === true).finally(() => {
        if (inFlight.get(scopeId) === run) inFlight.delete(scopeId);
      });
      inFlight.set(scopeId, run);
      return run;
    },
  };
}

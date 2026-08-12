import type { DurableMap } from "../persistence/durable-map.ts";
import { errMessage } from "../util/errors.ts";
import type { TraySnapshot } from "./tray.ts";

export const TRAY_MIN_REFRESH_MS = 30_000;
export const TRAY_EXEC_TIMEOUT_MS = 120_000;

export interface PersistedTraySnapshot {
  scopeId: string;
  snapshot: TraySnapshot;
}

export type TrayRefresh =
  | { status: "refreshed"; snapshot: TraySnapshot }
  | { status: "in_flight"; snapshot: TraySnapshot | null }
  | { status: "rate_limited"; snapshot: TraySnapshot; retryAfterMs: number }
  | { status: "failed"; snapshot: TraySnapshot | null; message: string };

export interface TrayStore {
  get(scopeId: string): Promise<TraySnapshot | null>;
  refresh(scopeId: string, opts?: { force?: boolean }): Promise<TrayRefresh>;
}

export interface TrayStoreOptions {
  backing: DurableMap<PersistedTraySnapshot>;
  collect: (scopeId: string) => Promise<TraySnapshot>;
  now?: () => number;
  minRefreshMs?: number;
}

export function createTrayStore(opts: TrayStoreOptions): TrayStore {
  const now = opts.now ?? Date.now;
  const minRefreshMs = opts.minRefreshMs ?? TRAY_MIN_REFRESH_MS;
  const inFlight = new Map<string, Promise<TrayRefresh>>();

  const read = async (scopeId: string): Promise<TraySnapshot | null> =>
    (await opts.backing.get(scopeId))?.snapshot ?? null;

  async function runRefresh(scopeId: string, force: boolean): Promise<TrayRefresh> {
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
        return read(scopeId).then((snapshot): TrayRefresh => ({ status: "in_flight", snapshot }));
      }
      const run = runRefresh(scopeId, refreshOpts?.force === true).finally(() => {
        if (inFlight.get(scopeId) === run) inFlight.delete(scopeId);
      });
      inFlight.set(scopeId, run);
      return run;
    },
  };
}

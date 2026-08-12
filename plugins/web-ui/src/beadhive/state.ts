import { api } from "../core-bridge";

export type WorkItemState = "ready" | "blocked" | "in_progress" | "needs_review";

export interface WorkItem {
  id: string;
  title: string;
  status: string;
  priority: number;
  kind: string;
  owner?: string;
  updatedAt?: string;
  blockedBy: number;
  blocks: number;
  parentId?: string;
  state: WorkItemState;
  container?: boolean;
}

export interface WorkSource {
  key: string;
  name: string;
  state: "ok" | "truncated" | "failed";
  items: WorkItem[];
  total: number;
  error?: string;
}

export interface WorkSnapshot {
  providerId: string;
  asOf: number;
  sources: WorkSource[];
  total: number;
  reachedEvery: boolean;
}

export type RefreshStatus = "refreshed" | "in_flight" | "rate_limited" | "failed";

export interface LayerStatus {
  version: number;
  contentHash: string | null;
  status?: "applied" | "degraded";
  runtimeContentHash?: string | null;
  source?: string;
  resolved?: { tools?: Array<{ id?: string; label?: string }>; skills?: Array<{ id?: string; label?: string }> };
}

export const beadhiveState = {
  enabled: false,
  projects: false,
  loadedFlags: false,
  snapshot: null as WorkSnapshot | null,
  trayOpen: false,
  trayLoading: false,
  expanded: new Set<string>(),
  collapsedGroups: new Set<string>(),
  showAllGroups: false,
  selectedId: "",
  notice: "",
  busy: false,
};

export function resetBeadhiveState(): void {
  beadhiveState.snapshot = null;
  beadhiveState.expanded = new Set<string>();
  beadhiveState.collapsedGroups = new Set<string>();
  beadhiveState.showAllGroups = false;
  beadhiveState.selectedId = "";
  beadhiveState.trayOpen = false;
  beadhiveState.trayLoading = false;
  beadhiveState.notice = "";
  beadhiveState.busy = false;
}

export async function loadBeadhiveFlags(): Promise<void> {
  const config = await api<{ beadhiveEnabled?: boolean; beadhiveProjects?: boolean }>("/api/surface-config");
  beadhiveState.enabled = config.beadhiveEnabled === true;
  beadhiveState.projects = config.beadhiveProjects === true;
  beadhiveState.loadedFlags = true;
}

export async function setBeadhiveFlag(resource: "beadhive-enabled" | "beadhive-projects", on: boolean): Promise<void> {
  await api("/api/beadhive/flags", { method: "PUT", body: JSON.stringify({ resource, on }) });
  if (resource === "beadhive-enabled") beadhiveState.enabled = on;
  else beadhiveState.projects = on;
}

export async function fetchTray(scopeId?: string): Promise<WorkSnapshot | null> {
  const qs = scopeId ? `?scopeId=${encodeURIComponent(scopeId)}` : "";
  const body = await api<{ snapshot: WorkSnapshot | null }>(`/api/projects/work${qs}`);
  beadhiveState.snapshot = body.snapshot;
  return body.snapshot;
}

export async function refreshTray(
  scopeId?: string,
): Promise<{ status: RefreshStatus; snapshot: WorkSnapshot | null; retryAfterMs?: number; message?: string }> {
  const qs = scopeId ? `?scopeId=${encodeURIComponent(scopeId)}` : "";
  const body = await api<{
    status: RefreshStatus;
    snapshot: WorkSnapshot | null;
    retryAfterMs?: number;
    message?: string;
  }>(`/api/projects/work/refresh${qs}`, { method: "POST" });
  if (body.snapshot) beadhiveState.snapshot = body.snapshot;
  return body;
}

export interface SyncResult {
  providerId: string;
  created: unknown[];
  unchanged: unknown[];
  orphaned: unknown[];
}

export async function syncProjectProviders(): Promise<{ results: SyncResult[] }> {
  return api("/api/projects/sync", { method: "POST" });
}

export async function fetchLayerStatus(): Promise<LayerStatus | null> {
  try {
    return await api<LayerStatus>("/api/beadhive/layer");
  } catch {
    return null;
  }
}

export function refreshNotice(result: { status: RefreshStatus; retryAfterMs?: number; message?: string }): string {
  if (result.status === "refreshed") return "";
  if (result.status === "in_flight") return "Already reading the fleet…";
  if (result.status === "rate_limited") {
    return `Just read — try again in ${Math.ceil((result.retryAfterMs ?? 0) / 1000)}s.`;
  }
  return result.message ? `Could not read the fleet: ${result.message}` : "Could not read the fleet.";
}

export function asOfLabel(snapshot: WorkSnapshot | null, now = Date.now()): string {
  if (!snapshot) return "never read";
  const seconds = Math.max(0, Math.round((now - snapshot.asOf) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

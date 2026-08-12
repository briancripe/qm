import type { ScopeId } from "../types.ts";
import type { Project } from "./project-store.ts";

export interface ProjectGroup {
  key: string;
  name: string;
  origin: Record<string, string>;
}

export type ProjectWorkItemState = "ready" | "blocked" | "in_progress" | "needs_review";

export interface ProjectWorkItem {
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
  state: ProjectWorkItemState;
  container?: boolean;
}

export type ProjectWorkSourceState = "ok" | "truncated" | "failed";

export interface ProjectWorkSource {
  key: string;
  name: string;
  state: ProjectWorkSourceState;
  items: ProjectWorkItem[];
  total: number;
  error?: string;
}

export interface ProjectWorkSnapshot {
  providerId: string;
  asOf: number;
  sources: ProjectWorkSource[];
  total: number;
  reachedEvery: boolean;
}

export interface ProjectSyncContext {
  ownerId: string;
  scope: ScopeId;
  list: () => Promise<readonly Project[]>;
  create: (name: string, origin: Record<string, string>) => Promise<Project | null>;
}

export interface ProjectSyncResult {
  providerId: string;
  created: Array<{ key: string; projectId: string; name: string }>;
  unchanged: Array<{ key: string; projectId: string }>;
  orphaned: Array<{ key: string; projectId: string; name: string }>;
  discovered: number;
}

export interface ProjectProvider {
  readonly id: string;
  readonly label: string;
  enabled(): Promise<boolean>;
  sync(ctx: ProjectSyncContext): Promise<ProjectSyncResult>;
  workItems(scope: ScopeId): Promise<ProjectWorkSnapshot>;
}

export interface ProjectProviderRegistry {
  all(): readonly ProjectProvider[];
  get(id: string): ProjectProvider | undefined;
  enabled(): Promise<ProjectProvider[]>;
}

export function createProjectProviderRegistry(providers: readonly ProjectProvider[]): ProjectProviderRegistry {
  const byId = new Map(providers.map((p) => [p.id, p]));
  return {
    all: () => providers,
    get: (id) => byId.get(id),
    enabled: async () => {
      const flags = await Promise.all(providers.map((p) => p.enabled()));
      return providers.filter((_, i) => flags[i] === true);
    },
  };
}

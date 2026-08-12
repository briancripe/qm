import type { WorkSource } from "./state";

export interface ProjectRef {
  key: string;
  name: string;
}

export function groupKeyOf(sourceKey: string): string {
  const parts = sourceKey.split("/");
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : sourceKey;
}

export function groupSourcesByProject(sources: readonly WorkSource[]): Array<{ key: string; sources: WorkSource[] }> {
  const groups = new Map<string, WorkSource[]>();
  for (const source of sources) {
    const key = groupKeyOf(source.key);
    const bucket = groups.get(key);
    if (bucket) bucket.push(source);
    else groups.set(key, [source]);
  }
  return [...groups].map(([key, list]) => ({ key, sources: list })).sort((a, b) => a.key.localeCompare(b.key));
}

export function activeGroupKey(
  scopeId: string | null,
  contexts: ReadonlyArray<{ scopeId: string; project?: { beadhive?: { provider: string; org: string } } }>,
): string | null {
  if (!scopeId) return null;
  const origin = contexts.find((c) => c.scopeId === scopeId)?.project?.beadhive;
  return origin ? `${origin.provider}/${origin.org}` : null;
}

export function filterToGroup(
  groups: Array<{ key: string; sources: WorkSource[] }>,
  activeKey: string | null,
): { shown: Array<{ key: string; sources: WorkSource[] }>; hiddenGroups: number } {
  if (!activeKey) return { shown: groups, hiddenGroups: 0 };
  const shown = groups.filter((g) => g.key === activeKey);
  if (!shown.length) return { shown: groups, hiddenGroups: 0 };
  return { shown, hiddenGroups: groups.length - shown.length };
}

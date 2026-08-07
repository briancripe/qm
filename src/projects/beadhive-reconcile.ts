import type { Project, ProjectBeadhiveOrigin } from "./project-store.ts";

export interface BeadhiveReconcileOptions {
  /** Distinct provider/org groups, as returned by beadhiveGroupsOf. */
  groups: readonly ProjectBeadhiveOrigin[];
  /** Existing projects visible to the actor — the idempotency corpus. */
  list: () => Promise<readonly Project[]>;
  create: (name: string, beadhive: ProjectBeadhiveOrigin) => Promise<Project>;
}

export interface BeadhiveReconcileResult {
  created: Array<{ origin: ProjectBeadhiveOrigin; projectId: string; name: string }>;
  unchanged: Array<{ origin: ProjectBeadhiveOrigin; projectId: string }>;
  /** Beadhive projects whose group is no longer in the fleet. Reported, never removed. */
  orphaned: Array<{ origin: ProjectBeadhiveOrigin; projectId: string; name: string }>;
}

/**
 * The display name for a group.
 *
 * Provider-qualified on purpose: one org name can appear under two providers —
 * `contrib/briancripe` and `github/briancripe` both exist in a real fleet — so
 * the org alone would render as two identically-named projects.
 */
export function beadhiveGroupName(origin: ProjectBeadhiveOrigin): string {
  return `${origin.provider}/${origin.org}`;
}

const keyOf = (o: ProjectBeadhiveOrigin): string => `${o.provider}/${o.org}`;

/**
 * Bring projects into line with the fleet's groups.
 *
 * Matching is on the recorded origin, never the name. A project renamed by hand
 * still matches its group, so reconciling neither duplicates it nor reverts the
 * rename — the fleet decides which projects exist, the operator decides what
 * they are called.
 *
 * Nothing is deleted. A group that leaves the fleet is reported as orphaned and
 * left alone: the project may hold sessions and members, and quietly removing
 * something a person can see is not a decision a sync job should be making.
 *
 * Projects without an origin are ad-hoc and ignored entirely.
 */
export async function reconcileBeadhiveProjects(
  opts: BeadhiveReconcileOptions,
): Promise<BeadhiveReconcileResult> {
  const existing = await opts.list();
  const byKey = new Map<string, Project>();
  for (const project of existing) {
    if (!project.beadhive) continue;
    // First writer wins, so a duplicate from an earlier run cannot cause a
    // second create on top of it.
    const key = keyOf(project.beadhive);
    if (!byKey.has(key)) byKey.set(key, project);
  }

  const result: BeadhiveReconcileResult = { created: [], unchanged: [], orphaned: [] };
  const wanted = new Set<string>();

  for (const origin of opts.groups) {
    const key = keyOf(origin);
    if (wanted.has(key)) continue;
    wanted.add(key);
    const found = byKey.get(key);
    if (found) {
      result.unchanged.push({ origin, projectId: found.id });
      continue;
    }
    const created = await opts.create(beadhiveGroupName(origin), origin);
    result.created.push({ origin, projectId: created.id, name: created.name });
  }

  for (const [key, project] of byKey) {
    if (wanted.has(key)) continue;
    result.orphaned.push({ origin: project.beadhive!, projectId: project.id, name: project.name });
  }

  return result;
}

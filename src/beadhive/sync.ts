import type { Sandbox } from "../sandbox/sandbox.ts";
import type { Project, ProjectBeadhiveOrigin } from "../projects/project-store.ts";
import { scopeId, type ScopeId } from "../types.ts";
import { beadhiveGroupsOf, enumerateBeadhiveHives } from "../projects/beadhive-hives.ts";
import { withScopeExec } from "./scope-exec.ts";
import {
  beadhiveGroupName,
  reconcileBeadhiveProjects,
  type BeadhiveReconcileResult,
} from "../projects/beadhive-reconcile.ts";

export interface BeadhiveSyncOptions {
  sandbox: Sandbox;
  bhHome: string;
  ownerId: string;
  list: () => Promise<readonly Project[]>;
  create: (name: string, beadhive: ProjectBeadhiveOrigin) => Promise<Project | null>;
  scope?: ScopeId;
}

export interface BeadhiveSyncResult extends BeadhiveReconcileResult {
  hives: number;
  groups: number;
}

export class BeadhiveSyncError extends Error {}

export async function syncBeadhiveProjects(opts: BeadhiveSyncOptions): Promise<BeadhiveSyncResult> {
  const scope = opts.scope ?? scopeId("personal", opts.ownerId);
  return withScopeExec(opts.sandbox, scope, async (exec) => {
    const hives = await enumerateBeadhiveHives(exec, opts.bhHome);
    const groups = beadhiveGroupsOf(hives);
    const reconciled = await reconcileBeadhiveProjects({
      groups,
      list: opts.list,
      create: async (name, beadhive) => {
        const created = await opts.create(name, beadhive);
        if (!created) throw new BeadhiveSyncError(`could not create the project for ${beadhiveGroupName(beadhive)}`);
        return created;
      },
    });
    return { ...reconciled, hives: hives.length, groups: groups.length };
  });
}

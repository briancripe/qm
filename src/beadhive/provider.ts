import type { Sandbox } from "../sandbox/sandbox.ts";
import type { ScopeId } from "../types.ts";
import type {
  ProjectGroup,
  ProjectProvider,
  ProjectSyncContext,
  ProjectSyncResult,
  ProjectWorkSnapshot,
} from "../projects/project-provider.ts";
import type { ProjectBeadhiveOrigin } from "../projects/project-store.ts";
import { beadhiveGroupsOf, enumerateBeadhiveHives } from "../projects/beadhive-hives.ts";
import { beadhiveGroupName, reconcileBeadhiveProjects } from "../projects/beadhive-reconcile.ts";
import { withScopeExec } from "./scope-exec.ts";
import { BEADHIVE_PROVIDER_ID, collectBeadhiveWork, collectScopeWork } from "./work.ts";
import { fleetVolumes, type FleetMode } from "./fleet.ts";

export class BeadhiveProviderError extends Error {}

export interface BeadhiveProviderOptions {
  sandbox: Sandbox;
  bhHome: string;
  workspacePath: string;
  enabled: () => Promise<boolean>;
  now?: () => number;
  prepare?: string;
  fleetMode?: FleetMode;
  groupFor?: (scope: ScopeId) => Promise<ProjectBeadhiveOrigin | null>;
}

const groupOf = (origin: ProjectBeadhiveOrigin): ProjectGroup => ({
  key: `${origin.provider}/${origin.org}`,
  name: beadhiveGroupName(origin),
  origin: { provider: origin.provider, org: origin.org },
});

const originOf = (group: ProjectGroup): ProjectBeadhiveOrigin => ({
  provider: group.origin.provider ?? "",
  org: group.origin.org ?? "",
});

export function createBeadhiveProvider(opts: BeadhiveProviderOptions): ProjectProvider {
  const now = opts.now ?? Date.now;
  const mode: FleetMode = opts.fleetMode ?? "scope";
  const volumesFor = async (scope: ScopeId) =>
    fleetVolumes(mode, mode === "group" ? await (opts.groupFor?.(scope) ?? Promise.resolve(null)) : null, {
      bhHome: opts.bhHome,
      workspacePath: opts.workspacePath,
    });
  return {
    id: BEADHIVE_PROVIDER_ID,
    label: "Beadhive",
    enabled: opts.enabled,

    async sync(ctx: ProjectSyncContext): Promise<ProjectSyncResult> {
      const volumes = await volumesFor(ctx.scope);
      return withScopeExec(
        opts.sandbox,
        ctx.scope,
        async (exec) => {
          const hives = await enumerateBeadhiveHives(exec, opts.bhHome);
          const groups = beadhiveGroupsOf(hives);
          const reconciled = await reconcileBeadhiveProjects({
            groups,
            list: ctx.list,
            create: async (name, beadhive) => {
              const created = await ctx.create(name, groupOf(beadhive).origin);
              if (!created) throw new BeadhiveProviderError(`could not create the project for ${name}`);
              return created;
            },
          });
          return {
            providerId: BEADHIVE_PROVIDER_ID,
            discovered: groups.length,
            created: reconciled.created.map((c) => ({
              key: groupOf(c.origin).key,
              projectId: c.projectId,
              name: c.name,
            })),
            unchanged: reconciled.unchanged.map((u) => ({ key: groupOf(u.origin).key, projectId: u.projectId })),
            orphaned: reconciled.orphaned.map((o) => ({
              key: groupOf(o.origin).key,
              projectId: o.projectId,
              name: o.name,
            })),
          };
        },
        volumes.length ? { volumes } : {},
      );
    },

    async workItems(scope: ScopeId): Promise<ProjectWorkSnapshot> {
      const volumes = await volumesFor(scope);
      return collectScopeWork({
        sandbox: opts.sandbox,
        scope,
        bhHome: opts.bhHome,
        workspacePath: opts.workspacePath,
        now,
        ...(opts.prepare ? { prepare: opts.prepare } : {}),
        ...(volumes.length ? { volumes } : {}),
      });
    },
  };
}

export { collectBeadhiveWork, originOf };

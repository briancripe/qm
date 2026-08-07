#!/usr/bin/env node
/**
 * Reconcile the Beadhive fleet's groups into projects, once, on demand.
 *
 * Deliberately a script rather than a cron: the point is to watch it land in
 * the sidebar before anything runs it on a schedule.
 *
 * It talks to the same postgres the core does, so projects it creates are the
 * ones the running instance serves — a memory-backed store would appear to work
 * and change nothing anyone could see.
 *
 * The hive list is read through a sandbox rather than off this host, which is
 * what keeps it honest across sandbox modes: where the sandbox bind-mounts a
 * shared HQ it reports the fleet, and where it holds its own clone it reports
 * only that. Nothing here needs to know which.
 *
 *   node scripts/beadhive-sync.ts <ownerPrincipalId> [--dry-run]
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createProjectStore, type Project } from "../src/projects/project-store.ts";
import { createLocalSandbox } from "../src/sandbox/local-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { scopeId } from "../src/types.ts";
import { beadhiveGroupsOf, enumerateBeadhiveHives } from "../src/projects/beadhive-hives.ts";
import { reconcileBeadhiveProjects } from "../src/projects/beadhive-reconcile.ts";

const log = (...a: unknown[]): void => console.log("[beadhive-sync]", ...a);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const ownerId = args.find((a) => !a.startsWith("--"));
  if (!ownerId) throw new Error("usage: beadhive-sync.ts <ownerPrincipalId> [--dry-run]");

  const config = loadConfig(process.env);
  if (!config.databaseUrl) throw new Error("no DATABASE_URL — refusing to sync into a store the core does not read");
  if (config.sandboxBackend !== "local") throw new Error(`sandboxBackend is ${config.sandboxBackend}; this needs local`);

  // BH_HOME comes from the sandbox's env, not this process's: the core sets it
  // for the container, and reading it from here would silently resolve to the
  // host's own home instead.
  const bhHome = config.localSandbox.env?.BH_HOME;
  if (!bhHome) throw new Error("LOCAL_SANDBOX_ENV has no BH_HOME — the sandbox would not know where its fleet is");

  const pg = createPostgresMapFactory(config.databaseUrl);
  const projects = createProjectStore(pg.map<Project>("projects"));

  const sandbox = createLocalSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "bh-sync-"))), {
    ...config.localSandbox,
    repoRoot: process.cwd(),
  });

  const scope = scopeId("personal", ownerId);
  log("provisioning a sandbox to read the fleet…");
  const handle = await sandbox.provision([{ scopeId: scope, mountPath: "", mode: "rw" }]);
  try {
    const hives = await enumerateBeadhiveHives((cmd) => sandbox.run(handle, cmd), bhHome);
    const groups = beadhiveGroupsOf(hives);
    log(`${hives.length} hives in ${groups.length} groups:`, groups.map((g) => `${g.provider}/${g.org}`).join(", "));

    const result = await reconcileBeadhiveProjects({
      groups,
      list: () => projects.listForMember(ownerId),
      create: async (name, beadhive) => {
        if (dryRun) {
          log(`would create ${name}`);
          return { id: "(dry-run)", name } as Project;
        }
        const created = await projects.create({ name, ownerId, beadhive });
        log(`created ${created.name} (${created.id})`);
        return created;
      },
    });

    log(`created ${result.created.length}, unchanged ${result.unchanged.length}, orphaned ${result.orphaned.length}`);
    // Orphans are reported rather than removed, so say so loudly enough to act on.
    for (const o of result.orphaned) log(`orphaned: ${o.name} (${o.projectId}) — no longer in the fleet, left alone`);
  } finally {
    await sandbox.teardown(handle, { destroy: true }).catch(() => undefined);
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error("[beadhive-sync] failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  },
);

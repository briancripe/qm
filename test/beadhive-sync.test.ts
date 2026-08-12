import { test } from "node:test";
import assert from "node:assert/strict";
import { syncBeadhiveProjects, BeadhiveSyncError } from "../src/beadhive/sync.ts";
import type { Project, ProjectBeadhiveOrigin } from "../src/projects/project-store.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

const HOME = "/home/bees/.beadhive";
const HIVES = [
  `${HOME}/hq/hives/github/beadhive/core.yaml`,
  `${HOME}/hq/hives/github/beadhive/docs.yaml`,
  `${HOME}/hq/hives/contrib/briancripe/qm.yaml`,
].join("\n");

interface Harness {
  sandbox: Sandbox;
  provisioned: number;
  tornDown: number;
  created: Array<{ name: string; beadhive: ProjectBeadhiveOrigin }>;
  projects: Project[];
}

function harness(stdout: string, opts: { runThrows?: Error } = {}): Harness {
  const h: Harness = {
    provisioned: 0,
    tornDown: 0,
    created: [],
    projects: [],
    sandbox: null as unknown as Sandbox,
  };
  h.sandbox = {
    provision: async () => {
      h.provisioned++;
      return { id: "sbx" } as never;
    },
    run: async () => {
      if (opts.runThrows) throw opts.runThrows;
      return { stdout, stderr: "", code: 0 } as never;
    },
    teardown: async () => {
      h.tornDown++;
    },
  } as unknown as Sandbox;
  return h;
}

const syncWith = (h: Harness) =>
  syncBeadhiveProjects({
    sandbox: h.sandbox,
    bhHome: HOME,
    ownerId: "brian@xenophon.dev",
    list: async () => h.projects,
    create: async (name, beadhive) => {
      h.created.push({ name, beadhive });
      const project = { id: `p${h.created.length}`, name, beadhive } as Project;
      h.projects.push(project);
      return project;
    },
  });

test("each distinct provider/org group becomes one project", async () => {
  const h = harness(HIVES);
  const result = await syncWith(h);
  assert.equal(result.hives, 3, "three hive records");
  assert.equal(result.groups, 2, "two groups — the two github hives share one");
  assert.deepEqual(
    h.created.map((c) => c.name).sort(),
    ["contrib/briancripe", "github/beadhive"],
    "names are provider-qualified so two orgs of the same name stay distinct",
  );
  assert.equal(result.created.length, 2);
});

test("a second sync creates nothing and reports the groups unchanged", async () => {
  const h = harness(HIVES);
  await syncWith(h);
  h.created.length = 0;
  const again = await syncWith(h);
  assert.deepEqual(h.created, [], "idempotent — matching is on the recorded origin");
  assert.equal(again.created.length, 0);
  assert.equal(again.unchanged.length, 2);
});

test("a group that leaves the fleet is reported orphaned, never deleted", async () => {
  const h = harness(HIVES);
  await syncWith(h);
  const shrunk = harness(`${HOME}/hq/hives/github/beadhive/core.yaml`);
  shrunk.projects = h.projects;
  const result = await syncWith(shrunk);
  assert.equal(result.orphaned.length, 1);
  assert.equal(result.orphaned[0]!.name, "contrib/briancripe");
  assert.equal(shrunk.projects.length, 2, "the orphan is still there");
});

test("the sandbox is torn down even when reading the fleet fails", async () => {
  const h = harness("", { runThrows: new Error("dolt server unreachable") });
  await assert.rejects(syncWith(h), /dolt server unreachable/);
  assert.equal(h.provisioned, 1);
  assert.equal(h.tornDown, 1, "a failed read must not leak the sandbox");
});

test("an absent HQ is an error, not an empty fleet", async () => {
  const h = harness("__QM_NO_HQ__");
  await assert.rejects(syncWith(h), /no Beadhive HQ/);
  assert.equal(h.tornDown, 1);
});

test("a refused project creation fails loudly rather than silently skipping", async () => {
  const h = harness(HIVES);
  await assert.rejects(
    syncBeadhiveProjects({
      sandbox: h.sandbox,
      bhHome: HOME,
      ownerId: "brian@xenophon.dev",
      list: async () => [],
      create: async () => null,
    }),
    BeadhiveSyncError,
  );
  assert.equal(h.tornDown, 1);
});

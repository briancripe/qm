import { test } from "node:test";
import assert from "node:assert/strict";
import type { Project, ProjectBeadhiveOrigin } from "../src/projects/project-store.ts";
import { beadhiveGroupName, reconcileBeadhiveProjects } from "../src/projects/beadhive-reconcile.ts";

let seq = 0;
function project(name: string, beadhive?: ProjectBeadhiveOrigin): Project {
  return {
    id: `p${++seq}`,
    orgId: "beadhive",
    name,
    ownerId: "brian@xenophon.dev",
    memberIds: ["brian@xenophon.dev"],
    createdAt: 1,
    updatedAt: 1,
    ...(beadhive ? { beadhive } : {}),
  };
}

function harness(existing: Project[]) {
  const created: Array<{ name: string; beadhive: ProjectBeadhiveOrigin }> = [];
  return {
    created,
    opts: {
      list: async () => existing,
      create: async (name: string, beadhive: ProjectBeadhiveOrigin) => {
        created.push({ name, beadhive });
        const p = project(name, beadhive);
        existing.push(p);
        return p;
      },
    },
  };
}

const GH = { provider: "github", org: "beadhive" };
const CONTRIB = { provider: "contrib", org: "briancripe" };

test("names are provider-qualified so one org under two providers stays distinct", () => {
  assert.equal(beadhiveGroupName({ provider: "github", org: "briancripe" }), "github/briancripe");
  assert.equal(beadhiveGroupName({ provider: "contrib", org: "briancripe" }), "contrib/briancripe");
});

test("missing groups are created once", async () => {
  const h = harness([]);
  const r = await reconcileBeadhiveProjects({ groups: [GH, CONTRIB], ...h.opts });
  assert.equal(r.created.length, 2);
  assert.deepEqual(
    h.created.map((c) => c.name),
    ["github/beadhive", "contrib/briancripe"],
  );
  assert.deepEqual(h.created[0]!.beadhive, GH, "origin is recorded, not just the name");
});

test("reconciling twice creates nothing the second time", async () => {
  const h = harness([]);
  await reconcileBeadhiveProjects({ groups: [GH, CONTRIB], ...h.opts });
  const second = await reconcileBeadhiveProjects({ groups: [GH, CONTRIB], ...h.opts });
  assert.deepEqual(second.created, [], "idempotent");
  assert.equal(second.unchanged.length, 2);
  assert.equal(h.created.length, 2, "no extra creates");
});

test("a renamed project still matches its group and is not reverted or duplicated", async () => {
  const renamed = project("Beadhive — the good one", GH);
  const h = harness([renamed]);
  const r = await reconcileBeadhiveProjects({ groups: [GH], ...h.opts });
  assert.deepEqual(r.created, [], "matching is on origin, not name");
  assert.equal(r.unchanged[0]!.projectId, renamed.id);
  assert.equal(renamed.name, "Beadhive — the good one", "the operator's name survives");
});

test("projects without an origin are ignored, even when named like a group", async () => {
  const adhoc = project("github/beadhive");
  const h = harness([adhoc]);
  const r = await reconcileBeadhiveProjects({ groups: [GH], ...h.opts });
  assert.equal(r.created.length, 1, "an ad-hoc project must not be adopted by name");
  assert.notEqual(r.created[0]!.projectId, adhoc.id);
});

test("a group that leaves the fleet is reported, never deleted", async () => {
  const gone = project("github/retired", { provider: "github", org: "retired" });
  const h = harness([gone]);
  const r = await reconcileBeadhiveProjects({ groups: [GH], ...h.opts });
  assert.equal(r.orphaned.length, 1);
  assert.equal(r.orphaned[0]!.projectId, gone.id);
  assert.equal(r.orphaned[0]!.name, "github/retired");
  const after = await h.opts.list();
  assert.ok(
    after.some((p) => p.id === gone.id),
    "the orphaned project must still exist — reconcile reports, it does not delete",
  );
});

test("a duplicate from an earlier run does not trigger another create", async () => {
  const h = harness([project("github/beadhive", GH), project("github/beadhive", GH)]);
  const r = await reconcileBeadhiveProjects({ groups: [GH], ...h.opts });
  assert.deepEqual(r.created, []);
  assert.equal(r.unchanged.length, 1, "collapsed to one");
});

test("a repeated group in the input is only created once", async () => {
  const h = harness([]);
  const r = await reconcileBeadhiveProjects({ groups: [GH, GH], ...h.opts });
  assert.equal(r.created.length, 1);
});

test("an empty fleet creates nothing and orphans everything beadhive-owned", async () => {
  const h = harness([project("github/beadhive", GH)]);
  const r = await reconcileBeadhiveProjects({ groups: [], ...h.opts });
  assert.deepEqual(r.created, []);
  assert.equal(r.orphaned.length, 1);
});

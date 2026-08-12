import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  collectBeadhiveWork,
  collectScopeWork,
  failureMessage,
  readyCommand,
  shapeTasks,
  parentOf,
  prepareCommand,
  READY_TRUNCATED_EXIT,
} from "../src/beadhive/work.ts";
import type { ProjectWorkSnapshot } from "../src/projects/project-provider.ts";
import { createWorkStore, type PersistedProjectWorkSnapshot } from "../src/projects/work-store.ts";
import type { BeadhiveHive } from "../src/projects/beadhive-hives.ts";

const HIVE: BeadhiveHive = { provider: "github", org: "beadhive", repo: "core" };

const bead = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `title ${id}`,
  description: "x".repeat(4000),
  notes: "y".repeat(2000),
  status: "open",
  priority: 1,
  issue_type: "feature",
  owner: "brian@xenophon.dev",
  updated_at: "2026-08-12T00:00:00Z",
  labels: ["org:beadhive"],
  dependency_count: 2,
  dependent_count: 3,
  ...over,
});

test("shaping keeps what the tray renders and drops the kilobyte fields", () => {
  const { items, total } = shapeTasks(JSON.stringify([bead("bh-1")]), "[]", "[]");
  assert.equal(total, 1);
  const only = items[0]!;
  assert.deepEqual(Object.keys(only).sort(), [
    "blockedBy",
    "blocks",
    "id",
    "kind",
    "owner",
    "priority",
    "state",
    "status",
    "title",
    "updatedAt",
  ]);
  assert.equal(only.blockedBy, 2, "dependency_count is what blocks this bead");
  assert.equal(only.blocks, 3);
  assert.equal(JSON.stringify(only).length < 300, true, "a snapshot row stays small enough to store durably");
});

test("shaping caps the rows but reports the true total", () => {
  const raw = JSON.stringify(Array.from({ length: 86 }, (_, i) => bead(`bh-${i}`)));
  const { items, total } = shapeTasks(raw, "[]", "[]", 25);
  assert.equal(items.length, 25);
  assert.equal(total, 86, "the count the operator sees is the real one, not the capped one");
});

test("malformed or non-array output yields nothing rather than throwing", () => {
  assert.deepEqual(shapeTasks("not json", "[]", "[]"), { items: [], total: 0 });
  assert.deepEqual(shapeTasks('{"error":"no beads project"}', "[]", "[]"), { items: [], total: 0 });
  assert.deepEqual(shapeTasks("", "[]", "[]"), { items: [], total: 0 });
});

test("the ready command runs inside the hive's own checkout", () => {
  assert.equal(
    readyCommand("/home/bees/workspace", HIVE),
    "cd '/home/bees/workspace/github/beadhive/core' && bh work ready --json",
  );
});

test("exit 3 is a truncated read, not a failure", async () => {
  const snapshot = await collectBeadhiveWork({
    exec: async () => ({
      stdout: JSON.stringify([bead("bh-1"), bead("bh-2")]),
      stderr: "",
      code: READY_TRUNCATED_EXIT,
    }),
    hives: [HIVE],
    workspacePath: "/w",
    now: 1000,
    itemsPerHive: 1,
  });
  assert.equal(snapshot.sources[0]!.state, "truncated", "capped rows report as truncated, never as failed");
  assert.equal(snapshot.sources[0]!.items.length, 1, "the rows it did return are still shown");
  assert.equal(snapshot.sources[0]!.total, 2, "the real count survives the cap");
  assert.equal(snapshot.reachedEvery, true, "exit 3 on the listing is tolerated, not a failed hive");
});

test("one unreachable hive does not blank the others", async () => {
  const good: BeadhiveHive = { provider: "github", org: "beadhive", repo: "docs" };
  const snapshot = await collectBeadhiveWork({
    exec: async (cmd: string) =>
      cmd.includes("/core")
        ? { stdout: "", stderr: "Dolt server unreachable at 127.0.0.1:3308\n", code: 1 }
        : { stdout: JSON.stringify([bead("bh-2")]), stderr: "", code: 0 },
    hives: [HIVE, good],
    workspacePath: "/w",
    now: 1000,
  });
  assert.equal(snapshot.sources[0]!.state, "failed");
  assert.match(snapshot.sources[0]!.error!, /Dolt server unreachable/);
  assert.equal(snapshot.sources[1]!.state, "ok");
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.reachedEvery, false, "the tray must be able to say it saw only part of the fleet");
});

const snap = (asOf: number): ProjectWorkSnapshot => ({
  providerId: "beadhive",
  asOf,
  sources: [],
  total: 0,
  reachedEvery: true,
});

function storeHarness(opts: { minRefreshMs?: number } = {}) {
  const backing = createMemoryMap<PersistedProjectWorkSnapshot>();
  let clock = 10_000;
  let collects = 0;
  const store = createWorkStore({
    backing,
    now: () => clock,
    ...(opts.minRefreshMs !== undefined ? { minRefreshMs: opts.minRefreshMs } : {}),
    collect: async () => {
      collects++;
      return snap(clock);
    },
  });
  return { store, collects: () => collects, advance: (ms: number) => (clock += ms) };
}

test("a refresh while one is in flight collapses instead of starting a second", async () => {
  const backing = createMemoryMap<PersistedProjectWorkSnapshot>();
  let collects = 0;
  let unblock: () => void = () => undefined;
  const gate = new Promise<void>((r) => (unblock = r));
  const store = createWorkStore({
    backing,
    now: () => 10_000,
    collect: async () => {
      collects++;
      await gate;
      return snap(10_000);
    },
  });

  const first = store.refresh("personal:brian");
  const second = await store.refresh("personal:brian");
  assert.equal(second.status, "in_flight", "the second caller is told, not queued behind a second exec");
  unblock();
  const done = await first;
  assert.equal(done.status, "refreshed");
  assert.equal(collects, 1, "one exec for two callers");
});

test("a refresh inside the minimum interval is rate limited and says how long to wait", async () => {
  const h = storeHarness({ minRefreshMs: 30_000 });
  await h.store.refresh("s");
  h.advance(5_000);
  const again = await h.store.refresh("s");
  assert.equal(again.status, "rate_limited");
  assert.equal(again.status === "rate_limited" && again.retryAfterMs, 25_000);
  assert.equal(h.collects(), 1, "the sandbox is not woken for a click inside the window");
  assert.notEqual(again.snapshot, null, "a rate-limited caller still gets the cached snapshot");
});

test("force overrides the interval, and a lapsed interval refreshes normally", async () => {
  const h = storeHarness({ minRefreshMs: 30_000 });
  await h.store.refresh("s");
  const forced = await h.store.refresh("s", { force: true });
  assert.equal(forced.status, "refreshed");
  h.advance(31_000);
  const later = await h.store.refresh("s");
  assert.equal(later.status, "refreshed");
  assert.equal(h.collects(), 3);
});

test("a failed collect keeps the last good snapshot instead of erasing it", async () => {
  const backing = createMemoryMap<PersistedProjectWorkSnapshot>();
  let fail = false;
  let clock = 10_000;
  const store = createWorkStore({
    backing,
    now: () => clock,
    minRefreshMs: 0,
    collect: async () => {
      if (fail) throw new Error("sandbox provision failed");
      return snap(clock);
    },
  });
  await store.refresh("s");
  fail = true;
  clock += 60_000;
  const result = await store.refresh("s");
  assert.equal(result.status, "failed");
  assert.equal(result.snapshot?.asOf, 10_000, "the operator keeps seeing the last fleet read that worked");
  assert.equal((await store.get("s"))?.asOf, 10_000);
});

test("a warning on stderr is never reported as the failure", () => {
  const stderr = [
    "Warning: /home/bees/workspace/gh/org/repo/.beads has permissions 0750 (recommended: 0700).",
    "Error: failed to open database: Dolt server unreachable at 127.0.0.1:3308",
  ].join("\n");
  assert.match(failureMessage(stderr, 1), /Dolt server unreachable/, "the real error wins over a leading warning");
});

test("a failure with only warnings still says something, and an empty one names the exit", () => {
  assert.match(failureMessage("Warning: nothing important\n", 1), /nothing important/);
  assert.equal(failureMessage("   \n\n", 3), "exit 3");
});

test("the prepare step runs before any hive is read", async () => {
  const seen: string[] = [];
  const exec = async (cmd: string) => {
    seen.push(cmd);
    return { stdout: "__QM_NO_HQ__", stderr: "", code: 0 } as never;
  };
  await collectScopeWork({
    sandbox: {
      provision: async () => ({ id: "sbx" }) as never,
      run: async (_h: unknown, cmd: string) => exec(cmd),
      teardown: async () => undefined,
    } as never,
    scope: "personal:brian",
    bhHome: "/home/bees/.beadhive",
    workspacePath: "/home/bees/workspace",
    now: () => 0,
  }).catch(() => undefined);
  assert.equal(
    seen[0],
    prepareCommand("/home/bees/.beadhive"),
    "Dolt and the setup check are ensured before the fleet is read",
  );
});

test("hierarchy comes from the dotted id, and only when the parent really exists", () => {
  const known = new Set(["nvhack-d65", "nvhack-d65.3", "nvhack-rl5t"]);
  assert.equal(parentOf("nvhack-d65.3", known), "nvhack-d65");
  assert.equal(parentOf("nvhack-d65", known), undefined, "a root has no parent");
  assert.equal(parentOf("nvhack-zzz.1", known), undefined, "an orphan is not forced under a missing parent");
});

test("state separates what needs a human from what is merely blocked", () => {
  const list = JSON.stringify([
    bead("nvhack-a", { status: "open", dependency_count: 0 }),
    bead("nvhack-b", { status: "open", dependency_count: 2 }),
    bead("nvhack-c", { status: "in_progress" }),
    bead("nvhack-d", { status: "open" }),
  ]);
  const ready = JSON.stringify([bead("nvhack-a")]);
  const gates = JSON.stringify([{ id: "gate-1", status: "open", dependencies: ["nvhack-d"] }]);
  const byId = new Map(shapeTasks(list, ready, gates).items.map((i) => [i.id, i.state]));
  assert.equal(byId.get("nvhack-a"), "ready");
  assert.equal(byId.get("nvhack-b"), "blocked", "open dependencies and not in the ready set");
  assert.equal(byId.get("nvhack-c"), "in_progress");
  assert.equal(byId.get("nvhack-d"), "needs_review", "an open gate outranks every other state");
});

test("molecules and epics are marked as containers so the tree can group under them", () => {
  const list = JSON.stringify([
    bead("nvhack-d65", { issue_type: "molecule" }),
    bead("nvhack-d65.1", { issue_type: "task" }),
  ]);
  const items = shapeTasks(list, "[]", "[]").items;
  assert.equal(items[0]!.container, true);
  assert.equal(items[1]!.container, undefined);
  assert.equal(items[1]!.parentId, "nvhack-d65");
});

test("a closed gate does not mark its bead as needing review", () => {
  const list = JSON.stringify([bead("nvhack-e", { dependency_count: 0 })]);
  const gates = JSON.stringify([{ id: "g", status: "closed", dependencies: ["nvhack-e"] }]);
  assert.equal(shapeTasks(list, "[]", gates).items[0]!.state, "ready");
});

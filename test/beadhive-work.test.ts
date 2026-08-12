import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  collectBeadhiveWork,
  collectScopeWork,
  failureMessage,
  readyCommand,
  shapeReadyBeads,
  PREPARE_COMMAND,
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
  const { items, total } = shapeReadyBeads(JSON.stringify([bead("bh-1")]));
  assert.equal(total, 1);
  const only = items[0]!;
  assert.deepEqual(Object.keys(only).sort(), [
    "blockedBy",
    "blocks",
    "id",
    "kind",
    "owner",
    "priority",
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
  const { items, total } = shapeReadyBeads(raw, 25);
  assert.equal(items.length, 25);
  assert.equal(total, 86, "the count the operator sees is the real one, not the capped one");
});

test("malformed or non-array output yields nothing rather than throwing", () => {
  assert.deepEqual(shapeReadyBeads("not json"), { items: [], total: 0 });
  assert.deepEqual(shapeReadyBeads('{"error":"no beads project"}'), { items: [], total: 0 });
  assert.deepEqual(shapeReadyBeads(""), { items: [], total: 0 });
});

test("the ready command runs inside the hive's own checkout", () => {
  assert.equal(
    readyCommand("/home/bees/workspace", HIVE),
    "cd '/home/bees/workspace/github/beadhive/core' && bh work ready --json",
  );
});

test("exit 3 is a truncated read, not a failure", async () => {
  const snapshot = await collectBeadhiveWork({
    exec: async () => ({ stdout: JSON.stringify([bead("bh-1")]), stderr: "", code: READY_TRUNCATED_EXIT }),
    hives: [HIVE],
    workspacePath: "/w",
    now: 1000,
  });
  assert.equal(snapshot.sources[0]!.state, "truncated");
  assert.equal(snapshot.sources[0]!.items.length, 1, "the beads it did return are still shown");
  assert.equal(snapshot.reachedEvery, true, "a truncated hive was still reached");
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
  assert.equal(seen[0], PREPARE_COMMAND, "Dolt and the setup check are ensured before the fleet is read");
});

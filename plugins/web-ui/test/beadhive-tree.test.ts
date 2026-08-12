import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTaskTree, compareTasks, countStates, descendantCount, findTask } from "../src/beadhive/tree.ts";
import { dispatchPrompt } from "../src/beadhive/dispatch.ts";
import type { WorkItem, WorkSnapshot } from "../src/beadhive/state.ts";

const item = (id: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id,
  title: `title ${id}`,
  status: "open",
  priority: 1,
  kind: "task",
  blockedBy: 0,
  blocks: 0,
  state: "ready",
  ...over,
});

const snapshot = (items: WorkItem[]): WorkSnapshot => ({
  providerId: "beadhive",
  asOf: 0,
  total: items.length,
  reachedEvery: true,
  sources: [{ key: "github/o/r", name: "r", state: "ok", items, total: items.length }],
});

test("children nest under the parent named by their id", () => {
  const { roots } = buildTaskTree([
    item("nv-d65", { container: true, kind: "molecule" }),
    item("nv-d65.1", { parentId: "nv-d65" }),
    item("nv-d65.2", { parentId: "nv-d65" }),
    item("nv-other"),
  ]);
  assert.deepEqual(
    roots.map((r) => r.item.id),
    ["nv-d65", "nv-other"],
    "only unparented items are roots",
  );
  assert.equal(roots[0]!.children.length, 2);
  assert.equal(descendantCount(roots[0]!), 2, "the collapsed count tells you what is hidden");
});

test("an item whose parent is absent stays a root rather than disappearing", () => {
  const { roots } = buildTaskTree([item("nv-x.1", { parentId: "nv-x" })]);
  assert.equal(roots.length, 1, "never drop work just because its parent was filtered out");
  assert.equal(roots[0]!.item.id, "nv-x.1");
});

test("ordering puts what needs a human first and blocked work last", () => {
  const ordered = [
    item("d", { state: "blocked" }),
    item("c", { state: "ready" }),
    item("b", { state: "in_progress" }),
    item("a", { state: "needs_review" }),
  ].sort(compareTasks);
  assert.deepEqual(
    ordered.map((i) => i.state),
    ["needs_review", "in_progress", "ready", "blocked"],
  );
});

test("within a state, higher priority sorts first", () => {
  const ordered = [item("b", { priority: 2 }), item("a", { priority: 0 })].sort(compareTasks);
  assert.deepEqual(
    ordered.map((i) => i.id),
    ["a", "b"],
    "P0 outranks P2",
  );
});

test("needs-review is collected across the tree, not just the roots", () => {
  const { needsReview } = buildTaskTree([
    item("nv-d65", { container: true }),
    item("nv-d65.1", { parentId: "nv-d65", state: "needs_review" }),
  ]);
  assert.deepEqual(
    needsReview.map((i) => i.id),
    ["nv-d65.1"],
    "a nested bead awaiting review must still reach the Needs you group",
  );
});

test("counts and lookup read across every source", () => {
  const snap = snapshot([item("a"), item("b", { state: "blocked" }), item("c", { state: "blocked" })]);
  assert.deepEqual(countStates(snap), { ready: 1, blocked: 2 });
  assert.equal(findTask(snap, "b")?.state, "blocked");
  assert.equal(findTask(snap, "nope"), null);
  assert.deepEqual(countStates(null), {}, "no snapshot is zero counts, not a crash");
});

test("dispatch hands the composer the id and the title", () => {
  assert.equal(
    dispatchPrompt({ id: "nvhack-3ps", title: "PROBE: exit-code contract" }),
    "Work nvhack-3ps — PROBE: exit-code contract",
  );
});

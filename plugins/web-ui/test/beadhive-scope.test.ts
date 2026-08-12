import { test } from "node:test";
import assert from "node:assert/strict";
import { activeGroupKey, filterToGroup, groupKeyOf, groupSourcesByProject } from "../src/beadhive/scope.ts";
import type { WorkSource } from "../src/beadhive/state.ts";

const source = (key: string): WorkSource => ({ key, name: key.split("/").pop()!, state: "ok", items: [], total: 1 });

test("a hive belongs to the project group its first two segments name", () => {
  assert.equal(groupKeyOf("github/briancripe/nvidia-hackathon"), "github/briancripe");
  assert.equal(groupKeyOf("odd-key"), "odd-key", "a malformed key groups under itself rather than vanishing");
});

test("sources gather under their project", () => {
  const groups = groupSourcesByProject([
    source("github/briancripe/nvidia-hackathon"),
    source("github/beadhive/beadhive"),
    source("github/briancripe/agent-hitch"),
  ]);
  assert.deepEqual(
    groups.map((g) => `${g.key}:${g.sources.length}`),
    ["github/beadhive:1", "github/briancripe:2"],
  );
});

test("the open chat's project is resolved through the contexts payload, not the scope string", () => {
  const contexts = [
    { scopeId: "group:web-project-abc", project: { beadhive: { provider: "github", org: "briancripe" } } },
    { scopeId: "group:web-project-plain", project: {} },
  ];
  assert.equal(activeGroupKey("group:web-project-abc", contexts), "github/briancripe");
  assert.equal(activeGroupKey("group:web-project-plain", contexts), null, "a project with no origin filters nothing");
  assert.equal(activeGroupKey("personal:brian", contexts), null, "a personal chat is not in a project");
  assert.equal(activeGroupKey(null, contexts), null);
});

test("filtering narrows to the open project and reports what it hid", () => {
  const groups = groupSourcesByProject([source("github/briancripe/a"), source("github/beadhive/b")]);
  const { shown, hiddenGroups } = filterToGroup(groups, "github/briancripe");
  assert.equal(shown.length, 1);
  assert.equal(hiddenGroups, 1, "the operator is told the rail is filtered, never silently narrowed");
});

test("a project with no work in the snapshot shows everything rather than an empty rail", () => {
  const groups = groupSourcesByProject([source("github/beadhive/b")]);
  const { shown, hiddenGroups } = filterToGroup(groups, "github/nothing-here");
  assert.equal(shown.length, 1, "falling back beats showing a blank tray");
  assert.equal(hiddenGroups, 0);
});

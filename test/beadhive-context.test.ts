import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBeadhiveGroupBlock } from "../src/projects/beadhive-context.ts";

const GH = { provider: "github", org: "beadhive" };

test("the block names the group and where its repos are", () => {
  const block = renderBeadhiveGroupBlock(GH, "/home/bees/workspace");
  assert.match(block, /## Beadhive group/);
  assert.match(block, /`github\/beadhive` group/);
  assert.match(block, /`\/home\/bees\/workspace\/github\/beadhive`/);
});

test("an empty scope workspace is explained rather than left to be misread", () => {
  // The failure this exists to prevent: an agent sees an empty scope workspace
  // and reports the project is empty, never looking at the fleet beside it.
  assert.match(renderBeadhiveGroupBlock(GH, "/w"), /empty workspace does not mean there is nothing to do/);
  assert.match(renderBeadhiveGroupBlock(GH, "/w"), /bh work ready/);
});

test("no workspace path means no path is claimed", () => {
  const block = renderBeadhiveGroupBlock(GH);
  assert.ok(!block.includes("checked out at"), "must not invent a location it was not given");
  assert.match(block, /`github\/beadhive` group/, "the group is still named");
});

test("a trailing slash on the workspace path does not double up", () => {
  assert.match(renderBeadhiveGroupBlock(GH, "/home/bees/workspace/"), /`\/home\/bees\/workspace\/github\/beadhive`/);
});

test("it does not restate what the deployment layer already advertises", () => {
  const block = renderBeadhiveGroupBlock(GH, "/w");
  // The layer's own hints cover the work loop; duplicating them here would
  // drift out of step with the layer that owns them.
  for (const owned of ["bh work claim", "bh work submit", "bh work merge", "bd dep tree"]) {
    assert.ok(!block.includes(owned), `"${owned}" belongs to the deployment layer's hints, not here`);
  }
});

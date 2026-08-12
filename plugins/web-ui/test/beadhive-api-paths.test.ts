import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../src/beadhive/state.ts", import.meta.url)), "utf8");

test("every beadhive api() call carries the /api prefix", () => {
  const calls = [...source.matchAll(/api(?:<[^>]*>)?\(\s*[`"]([^`"$]*)/g)].map((m) => m[1]!);
  assert.ok(calls.length >= 6, `expected the module's api() calls, found ${calls.length}`);
  for (const path of calls) {
    assert.ok(
      path.startsWith("/api/"),
      `"${path}" is missing the /api prefix — the SPA fallback answers it with index.html, and the ` +
        "JSON parse failure is swallowed, so the view silently renders its empty state",
    );
  }
});

test("the layer's empty state never reads as a defect, and degraded always does", async () => {
  const { layerState } = await import("../src/beadhive/layer-state.ts");
  assert.equal(layerState({ version: 0, contentHash: null, source: "none" }).label, "not recorded");
  assert.match(layerState({ version: 0, contentHash: null, source: "none" }).hint!, /not deployed with the qm CLI/);
  assert.equal(layerState({ version: 0, contentHash: null, source: "filesystem" }).label, "loaded from disk");
  assert.equal(layerState({ version: 7, contentHash: "abc", status: "applied" }).label, "applied");
  const bad = layerState({ version: 7, contentHash: "abc", status: "degraded" });
  assert.equal(bad.label, "degraded");
  assert.match(bad.hint!, /does not match/, "the one state that should alarm an operator says why");
});

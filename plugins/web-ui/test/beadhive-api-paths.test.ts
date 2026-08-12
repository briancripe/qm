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

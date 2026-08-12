import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProjectProviderRegistry,
  type ProjectProvider,
  type ProjectWorkSnapshot,
} from "../src/projects/project-provider.ts";

const snapshot = (providerId: string): ProjectWorkSnapshot => ({
  providerId,
  asOf: 0,
  sources: [],
  total: 0,
  reachedEvery: true,
});

function provider(id: string, on: boolean): ProjectProvider {
  return {
    id,
    label: id,
    enabled: async () => on,
    sync: async () => ({ providerId: id, created: [], unchanged: [], orphaned: [], discovered: 0 }),
    workItems: async () => snapshot(id),
  };
}

test("the registry lists every provider but only hands out the enabled ones", async () => {
  const registry = createProjectProviderRegistry([provider("beadhive", true), provider("linear", false)]);
  assert.deepEqual(
    registry.all().map((p) => p.id),
    ["beadhive", "linear"],
  );
  assert.deepEqual(
    (await registry.enabled()).map((p) => p.id),
    ["beadhive"],
    "a registered provider whose flag is off is not synced",
  );
});

test("a provider is addressable by id", () => {
  const registry = createProjectProviderRegistry([provider("beadhive", true)]);
  assert.equal(registry.get("beadhive")?.label, "beadhive");
  assert.equal(registry.get("nope"), undefined);
});

test("an empty registry is a valid deployment, not an error", async () => {
  const registry = createProjectProviderRegistry([]);
  assert.deepEqual(registry.all(), []);
  assert.deepEqual(await registry.enabled(), []);
});

test("a work snapshot names the provider that produced it", async () => {
  const registry = createProjectProviderRegistry([provider("beadhive", true)]);
  const result = await registry.get("beadhive")!.workItems("personal:brian");
  assert.equal(result.providerId, "beadhive", "a tray reading two providers must be able to tell them apart");
});

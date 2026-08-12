import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryConfigStore, type PersistedScopedFlag } from "../src/resolution/config-store.ts";
import { scopeId } from "../src/types.ts";

const org = scopeId("org", "org");

test("both beadhive flags default off and persist across instances", async () => {
  const beadhiveEnabled = createMemoryMap<PersistedScopedFlag>();
  const beadhiveProjects = createMemoryMap<PersistedScopedFlag>();
  const first = createMemoryConfigStore("org", { beadhiveEnabled, beadhiveProjects });
  await first.hydrate!();
  assert.equal(first.getBeadhiveEnabled(), false);
  assert.equal(first.getBeadhiveProjects(), false);

  first.setBeadhiveEnabled(true);
  first.setBeadhiveProjects(true);
  await first.flushScope(org);

  const second = createMemoryConfigStore("org", { beadhiveEnabled, beadhiveProjects });
  await second.hydrate!();
  assert.equal(second.getBeadhiveEnabled(), true);
  assert.equal(await second.getBeadhiveEnabledDurable(), true);
  assert.equal(second.getBeadhiveProjects(), true);
  assert.equal(await second.getBeadhiveProjectsDurable(), true);
});

test("the deployment default seeds each flag until a durable row overrides it", async () => {
  const beadhiveEnabled = createMemoryMap<PersistedScopedFlag>();
  const beadhiveProjects = createMemoryMap<PersistedScopedFlag>();
  const store = createMemoryConfigStore("org", {
    beadhiveEnabled,
    beadhiveProjects,
    defaultBeadhiveEnabled: true,
    defaultBeadhiveProjects: true,
  });
  await store.hydrate!();
  assert.equal(store.getBeadhiveEnabled(), true, "BH_ENABLED seeds the flag with no durable row");
  assert.equal(store.getBeadhiveProjects(), true, "BH_PROJECTS seeds the flag with no durable row");

  await beadhiveProjects.put(org, { scopeId: org, on: false });
  await store.refreshScope(org);
  assert.equal(store.getBeadhiveProjects(), false, "a durable row beats the deployment default");
  assert.equal(await store.getBeadhiveProjectsDurable(), false);
  assert.equal(store.getBeadhiveEnabled(), true, "the flags move independently");
});

test("the two flags are independent switches", async () => {
  const store = createMemoryConfigStore("org", { defaultBeadhiveEnabled: true });
  await store.hydrate!();
  assert.equal(store.getBeadhiveEnabled(), true);
  assert.equal(store.getBeadhiveProjects(), false, "the deep project integration stays off on its own flag");

  store.setBeadhiveEnabled(false);
  store.setBeadhiveProjects(true);
  assert.equal(store.getBeadhiveEnabled(), false);
  assert.equal(store.getBeadhiveProjects(), true);
});

test("another instance's write reaches this one through refreshScope", async () => {
  const beadhiveEnabled = createMemoryMap<PersistedScopedFlag>();
  const store = createMemoryConfigStore("org", { beadhiveEnabled });
  await store.hydrate!();
  assert.equal(store.getBeadhiveEnabled(), false);

  await beadhiveEnabled.put(org, { scopeId: org, on: true });
  await store.refreshScope(org);
  assert.equal(store.getBeadhiveEnabled(), true);
});

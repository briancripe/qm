import { test } from "node:test";
import assert from "node:assert/strict";
import { fleetVolumeName, fleetVolumes, isFleetMode } from "../src/beadhive/fleet.ts";
import { parseLocalSandboxVolumeMounts } from "../src/sandbox/sandbox.ts";

const PATHS = { bhHome: "/home/bees/.beadhive", workspacePath: "/home/bees/workspace" };
const ORIGIN = { provider: "github", org: "briancripe" };

test("scope mode keeps every scope on its own volume, as before", () => {
  assert.equal(fleetVolumeName("scope", ORIGIN), null);
  assert.deepEqual(fleetVolumes("scope", ORIGIN, PATHS), [], "no shared mount is the default and changes nothing");
});

test("group mode names one volume per project group", () => {
  assert.equal(fleetVolumeName("group", ORIGIN), "qm-bh-fleet-github-briancripe");
  assert.equal(fleetVolumeName("group", { provider: "contrib", org: "briancripe" }), "qm-bh-fleet-contrib-briancripe");
  const mounts = fleetVolumes("group", ORIGIN, PATHS);
  assert.deepEqual(
    mounts.map((m) => `${m.volume}->${m.containerPath}`),
    [
      "qm-bh-fleet-github-briancripe-home->/home/bees/.beadhive",
      "qm-bh-fleet-github-briancripe-ws->/home/bees/workspace",
    ],
  );
  assert.ok(
    mounts.every((m) => !m.readOnly),
    "an agent has to write worktrees and bead state",
  );
});

test("a scope with no group gets no fleet, so a personal chat never mounts one", () => {
  assert.equal(fleetVolumeName("group", null), null);
  assert.deepEqual(fleetVolumes("group", null, PATHS), []);
});

test("shared mode is one fleet for every scope, group or not", () => {
  assert.equal(fleetVolumeName("shared", null), "qm-bh-fleet");
  assert.equal(fleetVolumeName("shared", ORIGIN), "qm-bh-fleet", "the group is irrelevant in shared mode");
});

test("a group name that is not volume-safe is slugged rather than rejected", () => {
  assert.equal(fleetVolumeName("group", { provider: "git hub", org: "bri@ncripe" }), "qm-bh-fleet-git-hub-bri-ncripe");
});

test("only the three modes are accepted", () => {
  assert.equal(isFleetMode("group"), true);
  assert.equal(isFleetMode("Group"), false);
  assert.equal(isFleetMode("everything"), false);
});

test("the volume parser takes a volume name and refuses a path", () => {
  assert.deepEqual(parseLocalSandboxVolumeMounts("qm-bh-fleet-home:/home/bees/.beadhive"), [
    { volume: "qm-bh-fleet-home", containerPath: "/home/bees/.beadhive", readOnly: false },
  ]);
  assert.throws(
    () => parseLocalSandboxVolumeMounts("/home/bees/x:/y"),
    /bind mounts belong in LOCAL_SANDBOX_BIND_MOUNTS/,
    "a host path here is a mistake worth naming, not a volume named /home/bees/x",
  );
  assert.throws(() => parseLocalSandboxVolumeMounts("vol:relative"), /must be absolute/);
  assert.throws(() => parseLocalSandboxVolumeMounts("vol:/usr"), /refusing to mount over/);
  assert.throws(() => parseLocalSandboxVolumeMounts("vol:/data:rx"), /mode must be/);
});

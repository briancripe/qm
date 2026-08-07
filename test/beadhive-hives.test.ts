import { test } from "node:test";
import assert from "node:assert/strict";
import { beadhiveGroupsOf, enumerateBeadhiveHives, type HiveExec } from "../src/projects/beadhive-hives.ts";

const HOME = "/home/bees/.beadhive";
const ROOT = `${HOME}/hq/hives`;

function exec(stdout: string, code = 0, stderr = ""): { run: HiveExec; commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    run: async (command) => {
      commands.push(command);
      return { stdout, stderr, code };
    },
  };
}

const listing = [
  `${ROOT}/github/beadhive/beadhive-ui.yaml`,
  `${ROOT}/github/beadhive/beadhive.yaml`,
  `${ROOT}/contrib/briancripe/orca.yaml`,
].join("\n");

test("hives come back as provider/org/repo from the HQ layout", async () => {
  const { run } = exec(listing);
  assert.deepEqual(await enumerateBeadhiveHives(run, HOME), [
    { provider: "contrib", org: "briancripe", repo: "orca" },
    { provider: "github", org: "beadhive", repo: "beadhive" },
    { provider: "github", org: "beadhive", repo: "beadhive-ui" },
  ]);
});

test("a repo name containing dots survives", async () => {
  const { run } = exec(`${ROOT}/github/beadhive/beadhive.github.io.yaml`);
  const hives = await enumerateBeadhiveHives(run, HOME);
  assert.equal(hives[0]!.repo, "beadhive.github.io", "only the .yaml suffix should come off");
});

test("a missing HQ throws rather than reporting an empty fleet", async () => {
  const { run } = exec("__QM_NO_HQ__");
  await assert.rejects(enumerateBeadhiveHives(run, HOME), /no Beadhive HQ/);
});

test("an HQ with no hives is empty, not an error", async () => {
  const { run } = exec("");
  assert.deepEqual(await enumerateBeadhiveHives(run, HOME), []);
});

test("a failed listing throws with the runtime's message", async () => {
  const { run } = exec("", 2, "find: permission denied");
  await assert.rejects(enumerateBeadhiveHives(run, HOME), /permission denied/);
});

test("entries at the wrong depth are not mistaken for hives", async () => {
  const { run } = exec([`${ROOT}/github/stray.yaml`, `${ROOT}/github/beadhive/deep/nested.yaml`].join("\n"));
  assert.deepEqual(await enumerateBeadhiveHives(run, HOME), [], "only provider/org/repo.yaml counts");
});

test("a trailing slash on BH_HOME does not double up in the path", async () => {
  const { run, commands } = exec("");
  await enumerateBeadhiveHives(run, `${HOME}/`);
  assert.ok(commands[0]!.includes(ROOT), `expected ${ROOT} in: ${commands[0]}`);
  assert.ok(!commands[0]!.includes("//hq"), "no doubled separator");
});

test("BH_HOME is quoted, so a path with a space cannot split the command", async () => {
  const { run, commands } = exec("");
  await enumerateBeadhiveHives(run, "/home/two words/.beadhive");
  assert.ok(commands[0]!.includes("'/home/two words/.beadhive/hq/hives'"), commands[0]);
});

test("groups collapse hives to their distinct provider/org", () => {
  assert.deepEqual(
    beadhiveGroupsOf([
      { provider: "github", org: "beadhive", repo: "beadhive-ui" },
      { provider: "github", org: "beadhive", repo: "beadhive" },
      { provider: "contrib", org: "briancripe", repo: "orca" },
    ]),
    [
      { provider: "contrib", org: "briancripe" },
      { provider: "github", org: "beadhive" },
    ],
  );
});

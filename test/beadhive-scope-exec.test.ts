import { test } from "node:test";
import assert from "node:assert/strict";
import { withScopeExec } from "../src/beadhive/scope-exec.ts";
import type { Sandbox, TeardownOptions } from "../src/sandbox/sandbox.ts";

function harness() {
  const teardowns: Array<TeardownOptions | undefined> = [];
  let provisioned = 0;
  const sandbox = {
    provision: async () => {
      provisioned++;
      return { id: "sbx" } as never;
    },
    run: async () => ({ stdout: "ok", stderr: "", code: 0 }) as never,
    teardown: async (_handle: unknown, opts?: TeardownOptions) => {
      teardowns.push(opts);
    },
  } as unknown as Sandbox;
  return { sandbox, teardowns, provisioned: () => provisioned };
}

test("reading a scope never destroys it — the home volume outlives the read", async () => {
  const h = harness();
  await withScopeExec(h.sandbox, "personal:brian", async (exec) => exec("true"));
  assert.equal(h.teardowns.length, 1);
  assert.notEqual(
    h.teardowns[0]?.destroy,
    true,
    "destroy removes the scope's home volume, which holds the agent's workspace and cloned repos",
  );
});

test("the scope is torn down even when the read throws", async () => {
  const h = harness();
  await assert.rejects(
    withScopeExec(h.sandbox, "personal:brian", async () => {
      throw new Error("dolt unreachable");
    }),
    /dolt unreachable/,
  );
  assert.equal(h.provisioned(), 1);
  assert.equal(h.teardowns.length, 1, "a failed read must not leak the sandbox");
  assert.notEqual(h.teardowns[0]?.destroy, true);
});

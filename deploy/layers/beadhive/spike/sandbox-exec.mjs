// bh-lrcw.1 — prove the beadhive toolchain executes INSIDE a qm-provisioned scope sandbox.
//
// This is qm's real sandbox path: createLocalSandbox -> provision() -> run(), the same
// code the orchestrator's `execute` tool drives. Nothing is stubbed. What is NOT covered
// here is the model turn on top of it (that needs harness credentials).
//
//   sg docker -c "LOCAL_SANDBOX_IMAGE=qm-sandbox-beadhive:latest node sandbox-exec.mjs"

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalSandbox } from "../../../../src/sandbox/local-sandbox.ts";
import { createLocalWorkspaceStore } from "../../../../src/workspace/workspace-store.ts";
import { scopeId } from "../../../../src/types.ts";

const ws = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "beadhive-sbx-")));
const sandbox = createLocalSandbox(ws, { image: process.env.LOCAL_SANDBOX_IMAGE ?? "qm-sandbox-beadhive:latest" });
const scope = scopeId("personal", `beadhive-${process.pid}`);
const layers = [{ scopeId: scope, mountPath: "", mode: "rw" }];

const checks = [
  ["which bh", "bh is on PATH in the agent computer"],
  ["bh --version", "bh runs"],
  ["bd --version", "bd runs"],
  ["dolt version", "dolt (bd's store engine) runs"],
  ["bh work --help 2>&1 | head -5", "bh's work verbs are reachable"],
  ["bh hive ready 2>&1 | head -3", "bh reports hive readiness (no hive mounted here)"],
];

let handle;
try {
  console.log("provisioning a scope sandbox from qm-sandbox-beadhive:latest ...");
  handle = await sandbox.provision(layers);
  console.log(`container ${handle.id}  coldStart=${handle.coldStart}\n`);

  for (const [cmd, why] of checks) {
    const r = await sandbox.run(handle, cmd, { timeoutMs: 120_000 });
    const out = String(r.stdout ?? "").trim() || String(r.stderr ?? "").trim();
    console.log(`$ ${cmd}`);
    console.log(`  ${why}`);
    console.log(`  exit=${r.exitCode ?? r.code}  ${out.split("\n")[0]?.slice(0, 160) ?? ""}\n`);
  }
} finally {
  if (handle) {
    await sandbox.destroy?.(handle).catch(() => {});
    console.log("torn down");
  }
}

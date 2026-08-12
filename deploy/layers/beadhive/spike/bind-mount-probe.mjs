// bh-lrcw.1 follow-on — can a scope's storage be a BIND MOUNT instead of a docker volume,
// without modifying qm core?
//
// local-sandbox.ts:241-262 hardcodes `docker run` args: the only mount is
// `-v <localVolumeName(scope)>:/root`, with no extension point. BUT :282-286 creates the
// volume only when it does not already exist. A docker "local" volume can be created with
// a bind backend (type=none, o=bind, device=<hostpath>). Pre-create it that way and qm
// adopts it untouched — bind semantics, zero core changes.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalSandbox, localVolumeName } from "../../../../src/sandbox/local-sandbox.ts";
import { createLocalWorkspaceStore } from "../../../../src/workspace/workspace-store.ts";
import { scopeId } from "../../../../src/types.ts";

const run = promisify(execFile);
const docker = (args) => run("docker", args, { timeout: 120_000 });

// A host directory standing in for "the hive lives here".
const hostDir = mkdtempSync(join(tmpdir(), "beadhive-bind-"));
mkdirSync(join(hostDir, "hive"), { recursive: true });
writeFileSync(join(hostDir, "hive", "MARKER.txt"), "written on the HOST\n");

const scope = scopeId("personal", `bindtest-${process.pid}`);
const volume = localVolumeName(scope);
console.log(`host dir : ${hostDir}`);
console.log(`volume   : ${volume}  (qm mounts this at /root)\n`);

await docker(["volume", "rm", "-f", volume]).catch(() => {});
await docker([
  "volume", "create",
  "--driver", "local",
  "--opt", "type=none",
  "--opt", `device=${hostDir}`,
  "--opt", "o=bind",
  volume,
]);
console.log("pre-created the volume with a bind backend\n");

const ws = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "bind-ws-")));
const sandbox = createLocalSandbox(ws, { image: process.env.LOCAL_SANDBOX_IMAGE ?? "qm-sandbox-beadhive:latest" });

let handle;
try {
  handle = await sandbox.provision([{ scopeId: scope, mountPath: "", mode: "rw" }]);
  console.log(`provisioned ${handle.id}\n`);

  for (const cmd of [
    "cat /root/hive/MARKER.txt",
    "echo 'written from the CONTAINER' > /root/hive/FROM-SANDBOX.txt && echo wrote",
    "ls -la /root/hive",
    "stat -c '%u:%g %n' /root/hive/MARKER.txt /root/hive/FROM-SANDBOX.txt",
  ]) {
    const r = await sandbox.run(handle, cmd, { timeoutMs: 60_000 });
    console.log(`$ ${cmd}`);
    console.log(`  exit=${r.exitCode ?? r.code}`);
    for (const line of String(r.stdout ?? r.stderr ?? "").trim().split("\n")) console.log(`  ${line}`);
    console.log();
  }

  console.log("back on the HOST, that directory now contains:");
  for (const f of readdirSync(join(hostDir, "hive"))) console.log(`  ${f}`);
} finally {
  if (handle) await sandbox.destroy?.(handle).catch(() => {});
  await docker(["volume", "rm", "-f", volume]).catch(() => {});
  console.log("\ntorn down (host dir left for inspection)");
}

import type { LocalSandboxVolumeMount, Sandbox } from "../sandbox/sandbox.ts";
import type { ScopeId } from "../types.ts";
import type { HiveExec } from "../projects/beadhive-hives.ts";
import { swallowAs } from "../util/errors.ts";

export const SCOPE_EXEC_TIMEOUT_MS = 120_000;

export interface ScopeExecOptions {
  timeoutMs?: number;
  volumes?: readonly LocalSandboxVolumeMount[];
}

export async function withScopeExec<T>(
  sandbox: Sandbox,
  scope: ScopeId,
  fn: (exec: HiveExec) => Promise<T>,
  opts: ScopeExecOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? SCOPE_EXEC_TIMEOUT_MS;
  const handle = await sandbox.provision(
    [{ scopeId: scope, mountPath: "", mode: "rw" }],
    opts.volumes?.length ? { volumes: opts.volumes } : undefined,
  );
  try {
    return await fn((command) => sandbox.run(handle, command, { timeoutMs }));
  } finally {
    await sandbox.teardown(handle).catch(swallowAs("beadhive: sandbox teardown", undefined));
  }
}

import type { Sandbox } from "../sandbox/sandbox.ts";
import type { ScopeId } from "../types.ts";
import type { HiveExec } from "../projects/beadhive-hives.ts";
import { swallowAs } from "../util/errors.ts";

export const SCOPE_EXEC_TIMEOUT_MS = 120_000;

export async function withScopeExec<T>(
  sandbox: Sandbox,
  scope: ScopeId,
  fn: (exec: HiveExec) => Promise<T>,
  timeoutMs = SCOPE_EXEC_TIMEOUT_MS,
): Promise<T> {
  const handle = await sandbox.provision([{ scopeId: scope, mountPath: "", mode: "rw" }]);
  try {
    return await fn((command) => sandbox.run(handle, command, { timeoutMs }));
  } finally {
    await sandbox.teardown(handle, { destroy: true }).catch(swallowAs("beadhive: sandbox teardown", undefined));
  }
}

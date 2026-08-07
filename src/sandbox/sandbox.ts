import type { EgressPolicy, WorkspaceLayer } from "../types.ts";

/**
 * How a local sandbox container is attached to the network.
 *
 * - "custom"  (default) one bridge network per sandbox, so sandboxes cannot
 *             reach each other. This is the isolation the sandbox exists for.
 * - "default" the runtime's default bridge, shared with every other container.
 *             Sandboxes can reach each other; the agent port is still published
 *             on 127.0.0.1 only.
 * - "host"    the host's own network namespace. No isolation, and only ONE
 *             sandbox can run at a time — every container binds the agent port
 *             directly, so a second one fails with "address already in use".
 *
 * The non-default modes exist for runtimes that cannot create or join a custom
 * network. Rootless podman in a single-UID user namespace is the motivating
 * case: `run --network <name>` there fails with
 *   netavark: setns: IO error: Operation not permitted (os error 1)
 * which happens when newuidmap is not setuid, so podman cannot map a subuid
 * range and falls back to a single-UID namespace.
 *
 * Prefer "custom". Reach for the others only when the runtime forces it, and
 * note that "host" gives up the network boundary between sandboxed agent code
 * and everything else on the machine.
 *
 * This lives here rather than in local-sandbox.ts because config.ts validates it
 * at boot, and local-sandbox.ts already imports config.ts — declaring it there
 * would turn that into a runtime import cycle.
 */
export type LocalSandboxNetworkMode = "custom" | "default" | "host";

export const LOCAL_SANDBOX_NETWORK_MODES: readonly LocalSandboxNetworkMode[] = ["custom", "default", "host"];

export function isLocalSandboxNetworkMode(v: string): v is LocalSandboxNetworkMode {
  return (LOCAL_SANDBOX_NETWORK_MODES as readonly string[]).includes(v);
}

/** A host directory exposed inside the sandbox. */
export interface LocalSandboxBindMount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

/**
 * Parse `HOST:CONTAINER[:ro|:rw]` entries, comma-separated.
 *
 * Bind mounts hand the sandbox live host state, so this is strict: both paths
 * must be absolute, and a container path that would shadow the base filesystem
 * is refused outright. Anything malformed throws at boot rather than silently
 * mounting the wrong thing — or nothing.
 */
export function parseLocalSandboxBindMounts(raw: string): LocalSandboxBindMount[] {
  const out: LocalSandboxBindMount[] = [];
  for (const entry of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const parts = entry.split(":");
    if (parts.length < 2 || parts.length > 3) {
      throw new Error(`bind mount ${JSON.stringify(entry)} must be HOST:CONTAINER[:ro|:rw]`);
    }
    const [hostPath = "", containerPath = "", mode] = parts;
    if (!hostPath.startsWith("/") || !containerPath.startsWith("/")) {
      throw new Error(`bind mount ${JSON.stringify(entry)}: both paths must be absolute`);
    }
    // Shadowing these replaces the image's own filesystem and breaks the agent
    // in ways that surface far from the cause.
    if (["/", "/usr", "/etc", "/bin", "/sbin", "/lib", "/var", "/opt"].includes(containerPath.replace(/\/+$/, ""))) {
      throw new Error(`bind mount ${JSON.stringify(entry)}: refusing to mount over ${containerPath}`);
    }
    if (mode !== undefined && mode !== "ro" && mode !== "rw") {
      throw new Error(`bind mount ${JSON.stringify(entry)}: mode must be "ro" or "rw"`);
    }
    out.push({ hostPath, containerPath, readOnly: mode === "ro" });
  }
  return out;
}

export interface SandboxHandle {
  id: string;
  rootDir: string;
  homeDir?: string;
  coldStart?: boolean;
  env?: Record<string, string>;
  scratch?: boolean;
  backend?: string;
  scopeId?: string;
}

export function hasParentPathSegment(path: string): boolean {
  return path.split("/").includes("..");
}

type WritablePersistence = "snapshot_to_workspace" | "resident_disk";
export type EgressEnforcement = "none" | "ip_port" | "domain";

export interface AgentComputerSpec {
  os?: string;
  runtimes?: string[];
  tools?: string[];
  notInstalled?: string[];
  cpus?: number;
  memoryMb?: number;
  diskGb?: number;
  homeDir?: string;
  workdir?: string;
}

export interface AgentComputerProfile {
  backend: string;
  writablePersistence: WritablePersistence;
  processSessions: boolean;
  egressEnforcement?: EgressEnforcement;
  spec?: AgentComputerSpec;
}

export function effectiveEgressEnforcement(
  profile: AgentComputerProfile,
  controlPlane: { signingSecret?: string; apiBaseUrl?: string },
): EgressEnforcement {
  return controlPlane.signingSecret && controlPlane.apiBaseUrl ? (profile.egressEnforcement ?? "none") : "none";
}

export function visibleNotInstalled(notInstalled: readonly string[], extraTools: readonly string[]): string[] {
  const advertised = new Set(extraTools.map((line) => line.trim().split(/\s+/)[0]).filter(Boolean));
  return notInstalled.filter((name) => !advertised.has(name));
}

export function visibleTools(tools: readonly string[]): string[] {
  const seen = new Set<string>();
  return tools.filter((line) => {
    const binary = line.trim().split(/\s+/)[0];
    if (!binary || seen.has(binary)) return false;
    seen.add(binary);
    return true;
  });
}

export interface ProvisionOptions {
  env?: Record<string, string>;
  egress?: EgressPolicy;
  egressToken?: string;
  scratch?: { key: string };
  routeScopeId?: string;
  onStatus?: (text: string) => void;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export interface ExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type AgentComputerBackupArea = "workspace" | "home";

export interface AgentComputerBackupEntry {
  area: AgentComputerBackupArea;
  path: string;
  data: Uint8Array;
}

export interface AgentComputerBackupOptions {
  include?: AgentComputerBackupArea[];
  exclude?: (entry: Pick<AgentComputerBackupEntry, "area" | "path">) => boolean;
  followSymlinks?: boolean;
  includePaths?: readonly string[];
  keepContentCaches?: boolean;
}

export type ProcessState = { state: "running" } | { state: "exited"; code: number };

export interface StartProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface ReadProcessOptions {
  sinceCursor?: number;
  maxBytes?: number;
  waitMs?: number;
}

export interface ReadProcessResult {
  chunks: string;
  cursor: number;
  status: ProcessState;
}

export interface ProcessSession {
  processId: string;
  command: string;
  startedAt: number;
  status: ProcessState;
}

export interface TeardownOptions {
  keepWarm?: boolean;
  destroy?: boolean;
}

export interface Sandbox {
  readonly profile: AgentComputerProfile;
  profileFor?(scopeId: string): Promise<AgentComputerProfile>;
  provision(layers: WorkspaceLayer[], opts?: ProvisionOptions): Promise<SandboxHandle>;
  run(handle: SandboxHandle, command: string, opts?: ExecOptions): Promise<ExecResult>;
  readFile(handle: SandboxHandle, relPath: string): Promise<string | null>;
  writeFile(handle: SandboxHandle, relPath: string, data: string): Promise<void>;
  writeFileBytes(handle: SandboxHandle, relPath: string, data: Uint8Array): Promise<void>;
  readFileBytes(handle: SandboxHandle, relPath: string): Promise<Uint8Array | null>;
  stageIn?(handle: SandboxHandle, destRelPath: string, blobId: string): Promise<void>;
  stageOut?(handle: SandboxHandle, srcRelPath: string): Promise<string>;
  extractFiles?(handle: SandboxHandle, entries: ReadonlyArray<{ path: string; data: Uint8Array }>): Promise<void>;
  listDir(handle: SandboxHandle, relDir: string): Promise<string[]>;
  removeDir(handle: SandboxHandle, relDir: string): Promise<void>;
  backupComputer?(handle: SandboxHandle, opts?: AgentComputerBackupOptions): Promise<AgentComputerBackupEntry[]>;
  startProcess?(handle: SandboxHandle, command: string, opts?: StartProcessOptions): Promise<{ processId: string }>;
  readProcess?(handle: SandboxHandle, processId: string, opts?: ReadProcessOptions): Promise<ReadProcessResult>;
  writeStdin?(handle: SandboxHandle, processId: string, data: string): Promise<void>;
  signalProcess?(handle: SandboxHandle, processId: string, signal: string): Promise<void>;
  listProcesses?(handle: SandboxHandle): Promise<ProcessSession[]>;
  teardown(handle: SandboxHandle, opts?: TeardownOptions): Promise<void>;
  reapDeepIdle?(idleMs: number, devIdleMs?: number): Promise<{ reaped: number }>;
}

export class CapabilityUnsupportedError extends Error {
  readonly backend: string;
  readonly capability: string;
  constructor(backend: string, capability: string) {
    super(`this computer's substrate (${backend}) does not support ${capability}`);
    this.name = "CapabilityUnsupportedError";
    this.backend = backend;
    this.capability = capability;
  }
}

export function supportsAgentComputerBackup(
  sandbox: Sandbox,
): sandbox is Sandbox & Required<Pick<Sandbox, "backupComputer">> {
  return typeof sandbox.backupComputer === "function";
}

export function supportsScopeProfile(sandbox: Sandbox): sandbox is Sandbox & Required<Pick<Sandbox, "profileFor">> {
  return typeof sandbox.profileFor === "function";
}

export function supportsBlobStaging(
  sandbox: Sandbox,
): sandbox is Sandbox & Required<Pick<Sandbox, "stageIn" | "stageOut" | "extractFiles">> {
  return (
    typeof sandbox.stageIn === "function" &&
    typeof sandbox.stageOut === "function" &&
    typeof sandbox.extractFiles === "function"
  );
}

export type ProcessSandbox = Sandbox &
  Required<Pick<Sandbox, "startProcess" | "readProcess" | "writeStdin" | "signalProcess" | "listProcesses">>;

export function supportsProcessSessions(sandbox: Sandbox): sandbox is ProcessSandbox {
  return (
    sandbox.profile.processSessions === true &&
    typeof sandbox.startProcess === "function" &&
    typeof sandbox.readProcess === "function" &&
    typeof sandbox.writeStdin === "function" &&
    typeof sandbox.signalProcess === "function" &&
    typeof sandbox.listProcesses === "function"
  );
}

const SANDBOX_CAPABILITIES: ReadonlyArray<{ label: string; supported: (s: Sandbox) => boolean }> = [
  { label: "process sessions (background work, dev servers)", supported: supportsProcessSessions },
  { label: "home backup (publish, resident-auth capture)", supported: supportsAgentComputerBackup },
];

const ENFORCEMENT_RANK: Record<EgressEnforcement, number> = { none: 0, ip_port: 1, domain: 2 };

export function capabilitiesLostMovingTo(from: Sandbox, to: Sandbox): string[] {
  const lost = SANDBOX_CAPABILITIES.filter((c) => c.supported(from) && !c.supported(to)).map((c) => c.label);
  const fromEgress = from.profile.egressEnforcement ?? "none";
  const toEgress = to.profile.egressEnforcement ?? "none";
  if (ENFORCEMENT_RANK[toEgress] < ENFORCEMENT_RANK[fromEgress]) {
    lost.push(`egress enforcement (${fromEgress} on the source, ${toEgress} on the target)`);
  }
  return lost;
}

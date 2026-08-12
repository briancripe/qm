import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { orgId as configOrgId } from "../config.ts";
import { arch } from "node:os";
import { join } from "node:path";
import { readdir, readFile as fsReadFile } from "node:fs/promises";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallowAs, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { nonInteractiveShellPrefix } from "./sandbox-env.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import { createExecBackup, createExecFileOps, posixJoin } from "./exec-file-ops.ts";
import { spawnDockerExec, type DockerExec } from "./docker-exec.ts";
import { ephemeralCredLinkScript } from "../credentials/resident-paths.ts";
import { ephemeralCredLinkPaths } from "../credentials/resident-paths.ts";
import { shortHash } from "../util/crypto.ts";
import { killableScript, killScript } from "./exec-kill.ts";
import type {
  AgentComputerProfile,
  ExecOptions,
  ExecResult,
  LocalSandboxBindMount,
  LocalSandboxNetworkMode,
  LocalSandboxVolumeMount,
  ProvisionOptions,
  Sandbox,
  SandboxHandle,
  TeardownOptions,
} from "./sandbox.ts";

const DEFAULT_LOCAL_SANDBOX_IMAGE = "qm-sandbox-local:latest";
const HOME_DIR = "/root";
const WORKSPACE_BASENAME = "workspace";
const DEFAULT_AGENT_PORT = 8080;
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";
const FINGERPRINT_LABEL = "qm.sandbox-fingerprint";
const BUILD_HINT = "run `npm run sandbox:local:build`";

export type { DockerExec };

export interface LocalSandboxOptions {
  image?: string;
  dockerBin?: string;
  /** Defaults to "custom" — per-sandbox network isolation. */
  networkMode?: LocalSandboxNetworkMode;
  /**
   * Host directories exposed inside the sandbox. Empty by default: the sandbox
   * normally sees only its own volume, and every entry here is live host state
   * the agent can read and (unless ro) write.
   */
  bindMounts?: readonly LocalSandboxBindMount[];
  volumeMounts?: readonly LocalSandboxVolumeMount[];
  /**
   * Passed through as `--userns=<value>` when set. Relevant only alongside
   * bindMounts: under a normal rootless subuid mapping, container root writes
   * land as a subuid the host user cannot read, and "keep-id" maps the caller's
   * uid through instead. Left unset by default because it is NOT universally
   * available — in a single-UID namespace (no setuid newuidmap) podman fails
   * with "storage-chown-by-maps: lchown ...: invalid argument", while plain
   * bind mounts already land as the caller's uid there.
   */
  userns?: string;
  /**
   * Extra environment for the sandbox container. Applied on top of the image's
   * own ENV, so a key set here wins — overriding HOME or PATH will break the
   * agent in ways that surface far from the cause.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * Port the in-container exec daemon listens on. Defaults to 8080.
   *
   * Worth moving only under host networking, where the container binds this
   * on the host directly and so collides with anything already using 8080.
   * The value is passed to the agent as AGENT_PORT, which agent.mjs reads, so
   * both ends stay in step.
   */
  agentPort?: number;
  cpus?: number;
  memoryMb?: number;
  defaultTimeoutSec?: number;
  homeDir?: string;
  repoRoot?: string;
  dockerExec?: DockerExec;
  fetchImpl?: typeof fetch;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

/** Ask the kernel for a free loopback port, then hand it back. */
async function pickFreeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => (port ? resolve(port) : reject(new Error("could not resolve a free loopback port"))));
    });
  });
}

const FINGERPRINT_FIXED_SOURCES = ["fly/Dockerfile", "local/Dockerfile", "aws/microvm-agent/agent.mjs"];

export async function computeSandboxImageFingerprint(repoRoot: string): Promise<string | null> {
  try {
    const tools = (await readdir(join(repoRoot, "fly/tools"))).sort().map((f) => `fly/tools/${f}`);
    const paths = [...FINGERPRINT_FIXED_SOURCES, ...tools].sort();
    const fp = createHash("sha256");
    for (const p of paths) {
      fp.update(p);
      fp.update("\0");
      fp.update(
        createHash("sha256")
          .update(await fsReadFile(join(repoRoot, p)))
          .digest(),
      );
      fp.update("\n");
    }
    return fp.digest("hex");
  } catch {
    return null;
  }
}

export const localContainerName = (scopeId: string): string => `qm-sbx-${localSlug(scopeId)}`;
export const localVolumeName = (scopeId: string): string => `qm-home-${localSlug(scopeId)}`;
export const localNetworkName = (containerName: string): string =>
  `qm-net-${containerName.replace(/^qm-(sbx|scratch)-/, "")}`;
const localScratchName = (key: string): string => `qm-scratch-${localSlug(key)}`;

function localSlug(id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${cleaned.slice(0, 40).replace(/-+$/, "") || "scope"}-${shortHash(id)}`;
}

export function createLocalSandbox(workspace: WorkspaceStore, opts: LocalSandboxOptions = {}): Sandbox {
  const image = opts.image ?? DEFAULT_LOCAL_SANDBOX_IMAGE;
  const networkMode: LocalSandboxNetworkMode = opts.networkMode ?? "custom";
  const bindMounts: readonly LocalSandboxBindMount[] = opts.bindMounts ?? [];
  const bindMountArgs = bindMounts.flatMap((m) => ["-v", `${m.hostPath}:${m.containerPath}${m.readOnly ? ":ro" : ""}`]);
  const volumeArgs = (mounts: readonly LocalSandboxVolumeMount[] = []): string[] =>
    mounts.flatMap((m) => ["-v", `${m.volume}:${m.containerPath}${m.readOnly ? ":ro" : ""}`]);
  const staticVolumeArgs = volumeArgs(opts.volumeMounts);
  // Only meaningful with bind mounts, and only valid where the runtime can map
  // more than one uid — see LocalSandboxOptions.userns.
  const usernsArgs = opts.userns ? ["--userns", opts.userns] : [];
  const agentPort = opts.agentPort ?? DEFAULT_AGENT_PORT;
  // AGENT_PORT last so the container always agrees with what we resolve to,
  // even if someone also names it in `env`.
  const envArgs = Object.entries({ ...(opts.env ?? {}), AGENT_PORT: String(agentPort) }).flatMap(([k, v]) => [
    "-e",
    `${k}=${v}`,
  ]);
  const dexec = opts.dockerExec ?? spawnDockerExec(opts.dockerBin ?? "docker");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const homeDir = opts.homeDir ?? HOME_DIR;
  const workspaceDir = `${homeDir}/${WORKSPACE_BASENAME}`;
  const provisionQueue = createKeyedQueue<string>();

  const portByName = new Map<string, number>();
  const scopeByContainer = new Map<string, string>();
  const scratchByKey = new Map<string, string>();
  const activeByContainer = new Map<string, number>();

  let preflightDone: Promise<string> | undefined;
  let staleWarned = false;

  async function preflight(): Promise<string> {
    preflightDone ??= (async () => {
      const version = await dexec(["version"], 15_000);
      if (version.code !== 0) {
        preflightDone = undefined;
        throw new Error("SANDBOX_BACKEND=local requires a running Docker daemon (is Docker Desktop running?)");
      }
      const img = await dexec([
        "image",
        "inspect",
        "-f",
        `{{.Id}} {{if .Config.Labels}}{{index .Config.Labels "${FINGERPRINT_LABEL}"}}{{end}}`,
        image,
      ]);
      if (img.code !== 0) {
        preflightDone = undefined;
        throw new Error(`local sandbox image ${image} not found — ${BUILD_HINT}`);
      }
      const [imageId = "", labeled = ""] = img.stdout.trim().split(/\s+/);
      if (!staleWarned) {
        const want = await computeSandboxImageFingerprint(opts.repoRoot ?? process.cwd());
        if (want && labeled && labeled !== want) {
          staleWarned = true;
          console.warn(`[local-sandbox] sandbox image ${image} is stale — ${BUILD_HINT}`);
        }
      }
      return imageId;
    })();
    return preflightDone;
  }

  async function containerState(name: string): Promise<{ running: boolean; imageId: string } | null> {
    const r = await dexec(["inspect", "-f", "{{.State.Running}} {{.Image}}", name]);
    if (r.code !== 0) return null;
    const [running = "", imageId = ""] = r.stdout.trim().split(/\s+/);
    return { running: running === "true", imageId };
  }

  async function resolvePort(name: string): Promise<number> {
    // Host networking publishes nothing, so `port` reports no mapping and would
    // throw below. The agent is reachable on the agent port directly.
    if (networkMode === "host") return agentPort;
    const cached = portByName.get(name);
    if (cached) return cached;
    const r = await dexec(["port", name, `${agentPort}/tcp`]);
    const m = r.stdout
      .split("\n")[0]
      ?.trim()
      .match(/:(\d+)$/);
    if (r.code !== 0 || !m)
      throw new Error(`local sandbox ${name}: cannot resolve agent port: ${r.stderr.trim() || r.stdout.trim()}`);
    const port = Number(m[1]);
    portByName.set(name, port);
    return port;
  }

  async function daemon(
    name: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ status: number; text: string }> {
    const port = await resolvePort(name);
    const signals = [AbortSignal.timeout(timeoutMs ?? 30_000), ...(signal ? [signal] : [])];
    const res = await fetchImpl(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      signal: AbortSignal.any(signals),
    });
    return { status: res.status, text: await res.text() };
  }

  async function waitDaemon(name: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    let lastErr = "";
    while (Date.now() < deadline) {
      try {
        const res = await daemon(name, "/health", undefined, 3000);
        if (res.status === 200) return;
        lastErr = `http ${res.status}`;
      } catch (e) {
        lastErr = errMessage(e);
      }
      await sleep(300);
    }
    throw new Error(`local sandbox ${name}: exec daemon never became reachable: ${lastErr}`);
  }

  async function startContainer(name: string): Promise<void> {
    portByName.delete(name);
    const r = await dexec(["start", name]);
    if (r.code !== 0) throw new Error(`docker start ${name} failed: ${r.stderr.trim()}`);
    await waitDaemon(name);
  }

  async function ensureRunning(name: string): Promise<void> {
    const state = await containerState(name);
    if (!state) throw new Error(`local sandbox container ${name} is gone`);
    if (!state.running) await startContainer(name);
  }

  async function execRaw(name: string, command: string, timeoutSec: number, signal?: AbortSignal): Promise<ExecResult> {
    const res = await daemon(name, "/exec", { cmd: command, timeoutSec }, (timeoutSec + 15) * 1000, signal);
    if (res.status !== 200) throw new Error(`local sandbox exec failed (${res.status}): ${res.text.slice(0, 300)}`);
    const j = JSON.parse(res.text) as { stdout: string; stderr: string; code: number; timedOut: boolean };
    return { stdout: j.stdout ?? "", stderr: j.stderr ?? "", code: j.code, timedOut: !!j.timedOut };
  }

  async function writeAbsBytes(name: string, absPath: string, data: Uint8Array): Promise<void> {
    const res = await daemon(name, "/write", { path: absPath, b64: Buffer.from(data).toString("base64") }, 120_000);
    if (res.status !== 200)
      throw new Error(`local sandbox write ${absPath} failed (${res.status}): ${res.text.slice(0, 200)}`);
  }

  async function readAbsBytes(name: string, absPath: string): Promise<Uint8Array | null> {
    const res = await daemon(name, "/read", { path: absPath }, 120_000);
    if (res.status === 404) return null;
    if (res.status !== 200)
      throw new Error(`local sandbox read ${absPath} failed (${res.status}): ${res.text.slice(0, 200)}`);
    return Buffer.from((JSON.parse(res.text) as { b64: string }).b64, "base64");
  }

  async function ensureNetwork(name: string): Promise<string> {
    const net = localNetworkName(name);
    if ((await dexec(["network", "inspect", net])).code !== 0) {
      const r = await dexec(["network", "create", net]);
      if (r.code !== 0 && !/already exists/i.test(r.stderr)) {
        throw new Error(`docker network create ${net} failed: ${r.stderr.trim()}`);
      }
    }
    return net;
  }

  /** Only "custom" owns a network; the other modes have nothing to create or remove. */
  async function networkArgs(name: string): Promise<string[]> {
    if (networkMode === "host") return ["--network", "host"];
    if (networkMode === "default") return [];
    return ["--network", await ensureNetwork(name)];
  }

  // Under "host" the container shares the host namespace, so the agent is already
  // on the agent port and there is no mapping to make. Passing -p as well is rejected
  // outright (podman: "parsing host port: port numbers must be between 1 and
  // 65535"), so it must be omitted rather than merely redundant.
  //
  // Otherwise publish on a port we choose rather than `:0:`. Docker reads 0 as
  // "pick a free one", but podman rejects it outright with that same message, so
  // the ephemeral form is not portable. The kernel still does the choosing —
  // binding port 0 and reading back the assignment — we just resolve it here
  // instead of in the runtime. `docker port` remains the source of truth after
  // the run, so a lost race surfaces as a normal bind failure rather than a
  // silently wrong port.
  async function publishArgs(): Promise<string[]> {
    if (networkMode === "host") return [];
    return ["-p", `127.0.0.1:${await pickFreeLoopbackPort()}:${agentPort}`];
  }

  async function runContainer(
    name: string,
    scope: string | undefined,
    withVolume: boolean,
    extraVolumes: readonly LocalSandboxVolumeMount[] = [],
  ): Promise<void> {
    const netArgs = await networkArgs(name);
    const args = [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "qm.sandbox=1",
      ...(scope ? ["--label", `qm.scope=${scope}`] : []),
      "--label",
      `qm.org=${configOrgId()}`,
      "--label",
      "agent_env=dev",
      ...netArgs,
      ...(withVolume && scope ? ["-v", `${localVolumeName(scope)}:${homeDir}`] : []),
      ...staticVolumeArgs,
      ...volumeArgs(extraVolumes),
      ...bindMountArgs,
      ...usernsArgs,
      ...envArgs,
      ...(await publishArgs()),
      "--add-host=host.docker.internal:host-gateway",
      ...(opts.cpus ? ["--cpus", String(opts.cpus)] : []),
      ...(opts.memoryMb ? ["--memory", `${opts.memoryMb}m`] : []),
      image,
    ];
    const r = await dexec(args, 120_000);
    if (r.code !== 0) throw new Error(`docker run ${name} failed: ${r.stderr.trim()}`);
    portByName.delete(name);
    await waitDaemon(name);
  }

  async function ensureContainer(
    scope: string,
    extraVolumes: readonly LocalSandboxVolumeMount[] = [],
  ): Promise<{ name: string; coldStart: boolean }> {
    return provisionQueue(scope, async () => {
      const imageId = await preflight();
      const name = localContainerName(scope);
      scopeByContainer.set(name, scope);
      const state = await containerState(name);
      if (state && state.imageId === imageId) {
        if (!state.running) await startContainer(name);
        activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
        return { name, coldStart: false };
      }
      if (state) await dexec(["rm", "-f", name]);
      const volume = localVolumeName(scope);
      const hadVolume = (await dexec(["volume", "inspect", volume])).code === 0;
      if (!hadVolume) {
        const created = await dexec(["volume", "create", volume]);
        if (created.code !== 0) throw new Error(`docker volume create ${volume} failed: ${created.stderr.trim()}`);
      }
      await runContainer(name, scope, true, extraVolumes);
      activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
      return { name, coldStart: !hadVolume };
    });
  }

  async function ensureScratch(key: string): Promise<{ name: string; coldStart: boolean }> {
    return provisionQueue(`scratch:${key}`, async () => {
      await preflight();
      const name = localScratchName(key);
      scratchByKey.set(key, name);
      const state = await containerState(name);
      if (state) {
        if (!state.running) await startContainer(name);
        activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
        return { name, coldStart: false };
      }
      await runContainer(name, undefined, false);
      activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
      return { name, coldStart: true };
    });
  }

  function teardownQueueKey(handle: SandboxHandle): string {
    if (handle.scratch) {
      for (const [k, name] of scratchByKey) if (name === handle.id) return `scratch:${k}`;
      return handle.id;
    }
    return scopeByContainer.get(handle.id) ?? handle.id;
  }

  const profile: AgentComputerProfile = {
    backend: "local-docker",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: "none",
    spec: {
      os: `Debian 12 (bookworm), glibc — local Docker container on a ${arch()} host (dev only)`,
      runtimes: ["Node 24", "Python 3 (venv on PATH — `pip install` just works)"],
      tools: ["git", "curl", "wget", "jq", "unzip", "gnupg", "python3", "gh", "aws (CLI v2)"],
      notInstalled: ["gcloud", "kubectl", "flyctl", "glab"],
      ...(opts.cpus ? { cpus: opts.cpus } : {}),
      ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
      homeDir,
      workdir: workspaceDir,
    },
  };

  const procIo: ExecProcessIo = {
    async run(handle, command, execOpts): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      await ensureRunning(handle.id);
      return execRaw(handle.id, command, timeoutSec);
    },
  };
  const procSessions = createExecProcessSessions(procIo);

  const execFileOps = createExecFileOps({
    label: "local",
    exec: (id, script, t) => execRaw(id, script, t),
    writeInline: (id, abs, data) => writeAbsBytes(id, abs, data),
  });

  const execBackup = createExecBackup({
    label: "local",
    exec: (id, script, t) => execRaw(id, script, t),
    readAbsBytes,
    defaultHomeDir: homeDir,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths().map(({ rel }) => rel),
  });

  const sandbox: Sandbox = {
    profile,
    startProcess: procSessions.startProcess,
    readProcess: procSessions.readProcess,
    writeStdin: procSessions.writeStdin,
    signalProcess: procSessions.signalProcess,
    listProcesses: procSessions.listProcesses,
    ...execFileOps,

    async provision(layers: WorkspaceLayer[], provOpts?: ProvisionOptions): Promise<SandboxHandle> {
      const scratch = provOpts?.scratch;
      const writable = layers.find((l) => l.mode === "rw") ?? layers[0];
      const scope = writable?.scopeId ?? "default";
      const body = scratch ? await ensureScratch(scratch.key) : await ensureContainer(scope, provOpts?.volumes ?? []);
      const name = body.name;

      const env = provOpts?.env && Object.keys(provOpts.env).length ? provOpts.env : undefined;
      const handle: SandboxHandle = {
        id: name,
        rootDir: workspaceDir,
        homeDir,
        coldStart: body.coldStart,
        ...(scratch ? { scratch: true } : {}),
        ...(env ? { env } : {}),
      };

      try {
        const prep = await execRaw(name, `mkdir -p ${shq(workspaceDir)} && ${ephemeralCredLinkScript(homeDir)}`, 30);
        if (prep.code !== 0) throw new Error(`local sandbox provision prep failed: ${prep.stderr.slice(0, 200)}`);

        await materializeRoLayers(
          workspace,
          layers,
          handle,
          {
            readFile: (h, rel) => sandbox.readFile(h, rel),
            writeFileBytes: (h, rel, data) => sandbox.writeFileBytes(h, rel, data),
            exec: (script, t) => execRaw(name, script, t),
          },
          { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label: "local" },
        );

        return handle;
      } catch (err) {
        await sandbox.teardown(handle).catch(swallowAs("local-sandbox: teardown after failed provision", undefined));
        throw err;
      }
    },

    async run(handle, command, execOpts?: ExecOptions): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      await ensureRunning(handle.id);
      const exports = Object.entries(handle.env ?? {})
        .map(([k, v]) => `export ${k}=${shq(v)}`)
        .join("; ");
      const script = `${nonInteractiveShellPrefix()}${exports ? exports + "; " : ""}cd ${handle.rootDir} 2>/dev/null; ${command}`;
      const signal = execOpts?.signal;
      if (!signal) return execRaw(handle.id, script, timeoutSec);
      const killUid = randomUUID();
      const fireKill = () => {
        execRaw(handle.id, killScript(killUid), 15).catch(swallowAs("local-sandbox: kill in-flight exec", undefined));
      };
      if (signal.aborted) fireKill();
      const onAbort = () => fireKill();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await execRaw(handle.id, killableScript(script, killUid), timeoutSec, signal);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },

    async writeFileBytes(handle, relPath, data): Promise<void> {
      await writeAbsBytes(handle.id, posixJoin(handle.rootDir, relPath), data);
    },
    async writeFile(handle, relPath, data): Promise<void> {
      await sandbox.writeFileBytes(handle, relPath, Buffer.from(data, "utf8"));
    },
    async readFileBytes(handle, relPath): Promise<Uint8Array | null> {
      return readAbsBytes(handle.id, posixJoin(handle.rootDir, relPath));
    },
    async readFile(handle, relPath): Promise<string | null> {
      const bytes = await sandbox.readFileBytes(handle, relPath);
      return bytes === null ? null : Buffer.from(bytes).toString("utf8");
    },

    backupComputer: execBackup.backupComputer,

    async teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      return provisionQueue(teardownQueueKey(handle), async () => {
        const remaining = (activeByContainer.get(handle.id) ?? 1) - 1;
        if (remaining > 0) {
          activeByContainer.set(handle.id, remaining);
          return;
        }
        activeByContainer.delete(handle.id);

        if (handle.scratch) {
          for (const [k, name] of scratchByKey) if (name === handle.id) scratchByKey.delete(k);
          if (tdOpts?.destroy) await dexec(["rm", "-f", handle.id]);
          else await dexec(["rm", "-f", handle.id]).catch(swallowAs("local-sandbox: scratch rm", undefined));
          if (networkMode === "custom")
            await dexec(["network", "rm", localNetworkName(handle.id)]).catch(
              swallowAs("local-sandbox: scratch network rm", undefined),
            );
          portByName.delete(handle.id);
          return;
        }

        if (tdOpts?.keepWarm) return;

        if (tdOpts?.destroy) {
          await dexec(["rm", "-f", handle.id]).catch(swallowAs("local-sandbox: destroy rm", undefined));
          if (networkMode === "custom")
            await dexec(["network", "rm", localNetworkName(handle.id)]).catch(
              swallowAs("local-sandbox: destroy network rm", undefined),
            );
          const scope = scopeByContainer.get(handle.id);
          if (scope)
            await dexec(["volume", "rm", localVolumeName(scope)]).catch(
              swallowAs("local-sandbox: destroy volume rm", undefined),
            );
          scopeByContainer.delete(handle.id);
          portByName.delete(handle.id);
          return;
        }

        const r = await dexec(["stop", "-t", "2", handle.id], 60_000);
        if (r.code !== 0)
          opts.onError?.({
            category: "sandbox_park",
            code: "docker_stop_failed",
            message: r.stderr.trim(),
            ...(scopeByContainer.get(handle.id) ? { scopeLabel: scopeByContainer.get(handle.id)! } : {}),
          });
        portByName.delete(handle.id);
      });
    },
  };

  return sandbox;
}

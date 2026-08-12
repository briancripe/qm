import type { LocalSandboxVolumeMount } from "../sandbox/sandbox.ts";
import type { ProjectBeadhiveOrigin } from "../projects/project-store.ts";

export const FLEET_MODES = ["scope", "group", "shared"] as const;
export type FleetMode = (typeof FLEET_MODES)[number];

export const FLEET_VOLUME_PREFIX = "qm-bh-fleet";

export function isFleetMode(value: string): value is FleetMode {
  return (FLEET_MODES as readonly string[]).includes(value);
}

export function fleetVolumeName(mode: FleetMode, origin?: ProjectBeadhiveOrigin | null): string | null {
  if (mode === "scope") return null;
  if (mode === "shared") return FLEET_VOLUME_PREFIX;
  if (!origin) return null;
  const slug = `${origin.provider}-${origin.org}`.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/-+/g, "-");
  return `${FLEET_VOLUME_PREFIX}-${slug}`;
}

export function fleetVolumes(
  mode: FleetMode,
  origin: ProjectBeadhiveOrigin | null | undefined,
  paths: { bhHome: string; workspacePath: string },
): LocalSandboxVolumeMount[] {
  const volume = fleetVolumeName(mode, origin);
  if (!volume) return [];
  return [
    { volume: `${volume}-home`, containerPath: paths.bhHome, readOnly: false },
    { volume: `${volume}-ws`, containerPath: paths.workspacePath, readOnly: false },
  ];
}

import type { LayerStatus } from "./state";

export function layerState(layer: LayerStatus): { label: string; hint?: string } {
  if (layer.status === "degraded") {
    return { label: "degraded", hint: "the running layer does not match the one that was published" };
  }
  if (layer.status === "applied") return { label: "applied" };
  if (layer.source && layer.source !== "none") {
    return {
      label: "loaded from disk",
      hint: "read live from the deployment directory; no published version to compare against",
    };
  }
  return {
    label: "not recorded",
    hint: "this instance was not deployed with the qm CLI, so core has no layer to report",
  };
}

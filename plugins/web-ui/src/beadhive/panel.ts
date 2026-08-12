import { html, nothing, render } from "lit";
import { Boxes, RefreshCw } from "lucide";
import { errMessage } from "../../../chassis/src/errors";
import { icon } from "../ui";
import { appState, can } from "../shell-state";
import { layerState } from "./layer-state";
import { activeScopeId } from "./tray";
import {
  asOfLabel,
  beadhiveState,
  fetchLayerStatus,
  fetchTray,
  loadBeadhiveFlags,
  setBeadhiveFlag,
  syncProjectProviders,
  type LayerStatus,
} from "./state";

export const BEADHIVE_ICON = Boxes;

let layer: LayerStatus | null = null;
let layerLoaded = false;

function statusRow(label: string, value: unknown, hint?: string) {
  return html`<div class="bh-row">
    <span class="bh-row-label">${label}</span>
    <span class="bh-row-value">${value}</span>
    ${hint ? html`<span class="bh-row-hint">${hint}</span>` : nothing}
  </div>`;
}

function toggle(label: string, on: boolean, description: string, onChange: (next: boolean) => void) {
  const editable = can("admin");
  return html`<div class="bh-toggle">
    <div class="bh-toggle-text">
      <div class="bh-toggle-label">${label}</div>
      <div class="bh-toggle-desc">${description}</div>
    </div>
    <button
      class="bh-switch ${on ? "on" : ""}"
      type="button"
      role="switch"
      aria-checked=${on ? "true" : "false"}
      aria-label=${label}
      ?disabled=${!editable || beadhiveState.busy}
      title=${editable ? "" : "Only an administrator can change this"}
      @click=${() => onChange(!on)}
    >
      <span class="bh-switch-knob"></span>
    </button>
  </div>`;
}

async function flip(resource: "beadhive-enabled" | "beadhive-projects", on: boolean): Promise<void> {
  beadhiveState.busy = true;
  beadhiveState.notice = "";
  drawBeadhivePanel();
  try {
    await setBeadhiveFlag(resource, on);
  } catch (e) {
    beadhiveState.notice = errMessage(e);
  } finally {
    beadhiveState.busy = false;
    drawBeadhivePanel();
  }
}

async function runSync(): Promise<void> {
  beadhiveState.busy = true;
  beadhiveState.notice = "Reading the fleet…";
  drawBeadhivePanel();
  try {
    const { results } = await syncProjectProviders();
    const created = results.reduce((n, r) => n + r.created.length, 0);
    const unchanged = results.reduce((n, r) => n + r.unchanged.length, 0);
    const orphaned = results.reduce((n, r) => n + r.orphaned.length, 0);
    beadhiveState.notice = `${created} created, ${unchanged} unchanged, ${orphaned} orphaned.`;
  } catch (e) {
    beadhiveState.notice = errMessage(e);
  } finally {
    beadhiveState.busy = false;
    drawBeadhivePanel();
  }
}

export function drawBeadhivePanel(): void {
  if (appState.currentView !== "beadhive" || !appState.mainEl) return;
  const snapshot = beadhiveState.snapshot;
  const named = (entries?: Array<{ id?: string; label?: string }>): string[] =>
    (entries ?? []).map((e) => e.label || e.id || "").filter(Boolean);
  const tools = named(layer?.resolved?.tools);
  const skills = named(layer?.resolved?.skills);
  const host = document.createElement("div");
  host.className = "pane";
  render(
    html`
      <div class="pane-head">
        <div>
          <h1 class="pane-title">Beadhive</h1>
          <div class="pane-subtitle">A deployment layer that gives the agent a bead-tracked software factory.</div>
        </div>
        <div class="pane-head-actions">
          <button
            class="pane-refresh"
            type="button"
            aria-label="Refresh Beadhive status"
            title="Refresh Beadhive status"
            @click=${() => void renderBeadhivePanel(true)}
          >
            ${icon(RefreshCw, 17)}
          </button>
        </div>
      </div>
      ${beadhiveState.notice ? html`<div class="status">${beadhiveState.notice}</div>` : nothing}

      <div class="bh-section">
        ${toggle(
          "Beadhive integration",
          beadhiveState.enabled,
          "The bh and bd toolchain the layer installs, plus the hive tray.",
          (next) => void flip("beadhive-enabled", next),
        )}
        ${toggle(
          "Hive groups as projects",
          beadhiveState.projects,
          "Reconcile hives into projects and tell an agent which group its scope stands for.",
          (next) => void flip("beadhive-projects", next),
        )}
        ${can("admin") ? nothing : html`<div class="bh-note">Ask an administrator to change these.</div>`}
      </div>

      <div class="bh-section">
        <h2 class="bh-section-title">Installation</h2>
        ${
          layerLoaded && layer
            ? html`
                ${statusRow("Layer", layerState(layer).label, layerState(layer).hint)}
                ${statusRow("Source", layer.source ?? "—")}
                ${layer.version ? statusRow("Version", layer.version) : nothing}
                ${layer.contentHash ? statusRow("Content hash", layer.contentHash.slice(0, 12)) : nothing}
                ${statusRow("Tools", tools.length ? tools.join(", ") : "none")}
                ${statusRow("Skills", skills.length ? skills.join(", ") : "none")}
              `
            : html`<div class="bh-note">
                ${layerLoaded ? "No deployment layer is recorded for this instance." : "Loading…"}
              </div>`
        }
      </div>

      <div class="bh-section">
        <h2 class="bh-section-title">Fleet</h2>
        ${statusRow("Work sources", snapshot ? snapshot.sources.length : "—")}
        ${statusRow("Ready items", snapshot ? snapshot.total : "—")} ${statusRow("Last read", asOfLabel(snapshot))}
        ${
          snapshot && !snapshot.reachedEvery
            ? html`<div class="bh-note">Some sources could not be read — the tray shows which.</div>`
            : nothing
        }
        <div class="bh-actions">
          <button
            class="btn"
            type="button"
            ?disabled=${!beadhiveState.projects || beadhiveState.busy}
            @click=${() => void runSync()}
          >
            Sync hives now
          </button>
          ${
            beadhiveState.projects
              ? nothing
              : html`<span class="bh-row-hint">Turn on hive groups as projects to sync.</span>`
          }
        </div>
      </div>
    `,
    host,
  );
  appState.mainEl.replaceChildren(host);
}

export async function renderBeadhivePanel(force = false): Promise<void> {
  drawBeadhivePanel();
  try {
    if (force || !beadhiveState.loadedFlags) await loadBeadhiveFlags();
    if (force || !layerLoaded) {
      layer = await fetchLayerStatus();
      layerLoaded = true;
    }
    if (beadhiveState.enabled) await fetchTray(activeScopeId());
  } catch (e) {
    beadhiveState.notice = errMessage(e);
  }
  drawBeadhivePanel();
}

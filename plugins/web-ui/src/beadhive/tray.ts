import { html, nothing, render } from "lit";
import { PanelRightClose, PanelRightOpen, RefreshCw, TriangleAlert } from "lucide";
import { errMessage } from "../../../chassis/src/errors";
import { icon } from "../ui";
import {
  asOfLabel,
  beadhiveState,
  fetchTray,
  refreshNotice,
  refreshTray,
  type WorkItem,
  type WorkSnapshot,
  type WorkSource,
} from "./state";

const TRAY_ID = "bh-tray";
const CLICK_GUARD_MS = 1_000;

let lastClick = 0;
let host: HTMLElement | null = null;

function ensureHost(): HTMLElement | null {
  return document.getElementById(TRAY_ID);
}

export function toggleHiveTray(): void {
  beadhiveState.trayOpen = !beadhiveState.trayOpen;
  drawHiveTray();
  if (beadhiveState.trayOpen && !beadhiveState.snapshot) void loadTray();
}

async function loadTray(): Promise<void> {
  beadhiveState.trayLoading = true;
  drawHiveTray();
  try {
    await fetchTray();
    beadhiveState.notice = "";
  } catch (e) {
    beadhiveState.notice = errMessage(e);
  } finally {
    beadhiveState.trayLoading = false;
    drawHiveTray();
  }
}

async function manualRefresh(): Promise<void> {
  const now = Date.now();
  if (now - lastClick < CLICK_GUARD_MS) return;
  lastClick = now;
  beadhiveState.trayLoading = true;
  drawHiveTray();
  try {
    beadhiveState.notice = refreshNotice(await refreshTray());
  } catch (e) {
    beadhiveState.notice = errMessage(e);
  } finally {
    beadhiveState.trayLoading = false;
    drawHiveTray();
  }
}

function beadRow(bead: WorkItem) {
  return html`<li class="bh-bead">
    <div class="bh-bead-top">
      <span class="bh-bead-id">${bead.id}</span>
      ${bead.blockedBy ? html`<span class="bh-bead-flag">${bead.blockedBy} blocking</span>` : nothing}
      ${bead.blocks ? html`<span class="bh-bead-flag">blocks ${bead.blocks}</span>` : nothing}
    </div>
    <div class="bh-bead-title">${bead.title}</div>
  </li>`;
}

function hiveBlock(hive: WorkSource) {
  const name = hive.key;
  if (hive.state === "failed") {
    return html`<section class="bh-hive">
      <header class="bh-hive-head">
        <span class="bh-hive-name">${name}</span>
        <span class="bh-hive-bad">${icon(TriangleAlert, 13)} unreachable</span>
      </header>
      <div class="bh-hive-error">${hive.error}</div>
    </section>`;
  }
  return html`<section class="bh-hive">
    <header class="bh-hive-head">
      <span class="bh-hive-name">${name}</span>
      <span class="bh-hive-count">
        ${hive.total}
        ready${
          hive.state === "truncated" && hive.items.length < hive.total ? html` · showing ${hive.items.length}` : nothing
        }
      </span>
    </header>
    ${
      hive.items.length
        ? html`<ul class="bh-beads">
            ${hive.items.map(beadRow)}
          </ul>`
        : html`<div class="bh-hive-empty">Nothing ready.</div>`
    }
  </section>`;
}

function trayBody(snapshot: WorkSnapshot | null) {
  if (!snapshot) {
    const text = beadhiveState.trayLoading ? "" : "No snapshot yet — refresh to read the fleet.";
    return html`<div class="bh-tray-empty">${text}</div>`;
  }
  if (!snapshot.sources.length) {
    return html`<div class="bh-tray-empty">No work sources are registered in this scope.</div>`;
  }
  return html`<div class="bh-tray-body">${snapshot.sources.map(hiveBlock)}</div>`;
}

export function drawHiveTray(): void {
  host = ensureHost();
  if (!host) return;
  host.classList.toggle("open", beadhiveState.trayOpen);
  host.hidden = !beadhiveState.enabled;
  if (!beadhiveState.enabled) {
    host.replaceChildren();
    return;
  }
  if (!beadhiveState.trayOpen) {
    const rail = document.createElement("div");
    render(
      html`<button
        class="bh-tray-launcher"
        type="button"
        title="Show the hive"
        aria-label="Show the hive"
        aria-expanded="false"
        @click=${toggleHiveTray}
      >
        ${icon(PanelRightOpen, 17)}
        ${beadhiveState.snapshot ? html`<span class="bh-tray-launcher-count">${beadhiveState.snapshot.total}</span>` : nothing}
      </button>`,
      rail,
    );
    host.replaceChildren(rail);
    return;
  }
  const snapshot = beadhiveState.snapshot;
  const inner = document.createElement("div");
  render(
    html`
      <header class="bh-tray-head">
        <div class="bh-tray-title">Hive</div>
        <div class="bh-tray-actions">
          <button
            class="pane-refresh"
            type="button"
            aria-label="Refresh the hive"
            title="Refresh the hive"
            ?disabled=${beadhiveState.trayLoading}
            @click=${() => void manualRefresh()}
          >
            ${icon(RefreshCw, 15)}
          </button>
          <button class="pane-refresh" type="button" aria-label="Close the hive tray" @click=${toggleHiveTray}>
            ${icon(PanelRightClose, 15)}
          </button>
        </div>
      </header>
      <div class="bh-tray-asof">
        ${beadhiveState.trayLoading ? "Reading the fleet…" : `Read ${asOfLabel(snapshot)}`}
        ${snapshot && !snapshot.reachedEvery ? html`<span class="bh-hive-bad">partial</span>` : nothing}
      </div>
      ${beadhiveState.notice ? html`<div class="bh-tray-notice">${beadhiveState.notice}</div>` : nothing}
      ${trayBody(snapshot)}
    `,
    inner,
  );
  host.replaceChildren(inner);
}

import { html, nothing, render, type TemplateResult } from "lit";
import { ChevronDown, ChevronRight, PanelRightClose, PanelRightOpen, RefreshCw, TriangleAlert } from "lucide";
import { errMessage } from "../../../chassis/src/errors";
import { icon } from "../ui";
import {
  asOfLabel,
  beadhiveState,
  fetchTray,
  refreshNotice,
  refreshTray,
  type WorkItem,
  type WorkSource,
} from "./state";
import { buildTaskTree, countStates, descendantCount, findTask, type TaskNode } from "./tree";
import { dispatchToChat } from "./dispatch";
import { onboardingHint, summarizeFailures } from "./failure";
import { activeGroupKey, filterToGroup, groupSourcesByProject } from "./scope";
import { contextsState } from "../contexts";
import { mainConversation } from "../conversations";

const STATE_LABEL: Record<string, string> = {
  needs_review: "needs review",
  in_progress: "in progress",
  ready: "ready",
  blocked: "blocked",
};

const TRAY_ID = "bh-tray";
const CLICK_GUARD_MS = 1_000;

let lastClick = 0;

function ensureHost(): HTMLElement | null {
  return document.getElementById(TRAY_ID);
}

export function toggleHiveTray(): void {
  beadhiveState.trayOpen = !beadhiveState.trayOpen;
  drawHiveTray();
  if (beadhiveState.trayOpen && !beadhiveState.snapshot) void loadTray();
}

export function activeScopeId(): string | undefined {
  return mainConversation().state.scopeId ?? undefined;
}

async function loadTray(): Promise<void> {
  beadhiveState.trayLoading = true;
  drawHiveTray();
  try {
    await fetchTray(activeScopeId());
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
    beadhiveState.notice = refreshNotice(await refreshTray(activeScopeId()));
  } catch (e) {
    beadhiveState.notice = errMessage(e);
  } finally {
    beadhiveState.trayLoading = false;
    drawHiveTray();
  }
}

function toggleExpanded(id: string): void {
  if (beadhiveState.expanded.has(id)) beadhiveState.expanded.delete(id);
  else beadhiveState.expanded.add(id);
  drawHiveTray();
}

function select(id: string): void {
  beadhiveState.selectedId = id;
  drawHiveTray();
}

function taskRow(node: TaskNode, depth: number): TemplateResult {
  const { item } = node;
  const open = beadhiveState.expanded.has(item.id);
  const hidden = descendantCount(node);
  return html`
    <div class="bh-task-line" style="padding-left:${depth * 12}px">
      ${
        node.children.length
          ? html`<button
              class="bh-task-caret"
              type="button"
              aria-expanded=${open ? "true" : "false"}
              aria-label=${open ? `Collapse ${item.id}` : `Expand ${item.id}`}
              @click=${() => toggleExpanded(item.id)}
            >
              ${icon(open ? ChevronDown : ChevronRight, 13)}
            </button>`
          : html`<span class="bh-task-caret-spacer"></span>`
      }
      <button
        class="bh-task ${item.state} ${beadhiveState.selectedId === item.id ? "selected" : ""}"
        type="button"
        @click=${() => select(item.id)}
      >
        <span class="bh-task-id">${item.id}</span>
        <span class="bh-task-title">${item.title}</span>
        ${item.container && !open && hidden ? html`<span class="bh-task-meta">${hidden}</span>` : nothing}
        ${
          item.state === "blocked" && item.blockedBy
            ? html`<span class="bh-task-meta">⛌ ${item.blockedBy}</span>`
            : nothing
        }
      </button>
    </div>
    ${open ? node.children.map((child) => taskRow(child, depth + 1)) : nothing}
  `;
}

function sourceBlock(source: WorkSource): TemplateResult {
  const { roots } = buildTaskTree(source.items);
  return html`<section class="bh-source">
    <header class="bh-source-head">
      <span class="bh-source-name">${source.key}</span>
      <span class="bh-source-count">${source.total}</span>
    </header>
    ${roots.length ? roots.map((r) => taskRow(r, 0)) : html`<div class="bh-source-empty">Nothing open.</div>`}
  </section>`;
}

function detailPane(item: WorkItem): TemplateResult {
  return html`
    <div class="bh-detail">
      <button class="bh-detail-back" type="button" @click=${() => select("")}>← Tasks</button>
      <div class="bh-task-id">${item.id}</div>
      <h2 class="bh-detail-title">${item.title}</h2>
      <div class="bh-detail-facts">
        <span class="bh-chip ${item.state}">${STATE_LABEL[item.state] ?? item.state}</span>
        <span class="bh-chip">${item.kind}</span>
        <span class="bh-chip">P${item.priority}</span>
        ${item.owner ? html`<span class="bh-chip">${item.owner}</span>` : nothing}
      </div>
      <dl class="bh-detail-rows">
        <dt>Status</dt>
        <dd>${item.status}</dd>
        <dt>Blocked by</dt>
        <dd>${item.blockedBy}</dd>
        <dt>Blocks</dt>
        <dd>${item.blocks}</dd>
        ${
          item.parentId
            ? html`<dt>Parent</dt>
                <dd>
                  <button class="bh-link" type="button" @click=${() => select(item.parentId!)}>${item.parentId}</button>
                </dd>`
            : nothing
        }
        ${
          item.updatedAt
            ? html`<dt>Updated</dt>
                <dd>${item.updatedAt.slice(0, 10)}</dd>`
            : nothing
        }
      </dl>
      <div class="bh-detail-actions">
        <button class="btn" type="button" @click=${() => dispatchToChat(item)}>Dispatch to chat</button>
      </div>
      <p class="bh-detail-note">
        Dispatch puts the id in the composer for this session to pick up. Approve and Request changes arrive with the
        write path.
      </p>
    </div>
  `;
}

function showEverything(): void {
  beadhiveState.showAllGroups = true;
  drawHiveTray();
}

function projectSection(group: { key: string; sources: WorkSource[] }): TemplateResult {
  const collapsed = beadhiveState.collapsedGroups.has(group.key);
  const reachable = group.sources.filter((s) => s.state !== "failed");
  const failures = summarizeFailures(group.sources);
  const total = reachable.reduce((sum, s) => sum + s.total, 0);
  return html`<section class="bh-project">
    <button
      class="bh-project-head"
      type="button"
      aria-expanded=${collapsed ? "false" : "true"}
      @click=${() => {
        if (collapsed) beadhiveState.collapsedGroups.delete(group.key);
        else beadhiveState.collapsedGroups.add(group.key);
        drawHiveTray();
      }}
    >
      ${icon(collapsed ? ChevronRight : ChevronDown, 13)}
      <span class="bh-project-name">${group.key}</span>
      ${reachable.length ? html`<span class="bh-source-count">${total}</span>` : nothing}
      ${
        failures.length
          ? html`<span class="bh-source-bad" title=${failures.map((f) => `${f.reason}: ${f.detail}`).join("\n")}>
              ${icon(TriangleAlert, 12)} ${failures.reduce((n, f) => n + f.count, 0)}
            </span>`
          : nothing
      }
    </button>
    ${
      collapsed
        ? nothing
        : html`${reachable.map(sourceBlock)}
          ${failures.map(
              (f) =>
                html`<div class="bh-source-error" title=${f.detail}>
                  ${f.count} ${f.count === 1 ? "hive" : "hives"} ${f.reason}
                </div>`,
            )}`
    }
  </section>`;
}

function trayBody(): TemplateResult {
  const snapshot = beadhiveState.snapshot;
  if (!snapshot) {
    const text = beadhiveState.trayLoading ? "" : "No snapshot yet \u2014 refresh to read the fleet.";
    return html`<div class="bh-tray-empty">${text}</div>`;
  }
  const selected = beadhiveState.selectedId ? findTask(snapshot, beadhiveState.selectedId) : null;
  if (selected) return detailPane(selected);
  if (!snapshot.sources.length) {
    return html`<div class="bh-tray-empty">No work sources are registered in this scope.</div>`;
  }
  const active = beadhiveState.showAllGroups
    ? null
    : activeGroupKey(mainConversation().state.scopeId, contextsState.list);
  const { shown, hiddenGroups } = filterToGroup(groupSourcesByProject(snapshot.sources), active);
  const visible = shown.flatMap((g) => g.sources);
  const needsReview = visible.flatMap((s) => buildTaskTree(s.items).needsReview);
  const hint = onboardingHint(summarizeFailures(visible), visible.length);
  return html`
    ${hint ? html`<div class="bh-tray-hint">${hint}</div>` : nothing}
    ${
      active && hiddenGroups
        ? html`<div class="bh-tray-filter">
            Showing ${active} only ·
            <button class="bh-link" type="button" @click=${() => void showEverything()}>show all</button>
          </div>`
        : nothing
    }
    ${
      needsReview.length
        ? html`<section class="bh-source bh-needs-you">
            <header class="bh-source-head">
              <span class="bh-source-name">Needs you</span>
              <span class="bh-source-count">${needsReview.length}</span>
            </header>
            ${needsReview.map((item) => taskRow({ item, children: [] }, 0))}
          </section>`
        : nothing
    }
    <div class="bh-tray-body">${shown.map(projectSection)}</div>
  `;
}

export function drawHiveTray(): void {
  const host = ensureHost();
  if (!host) return;
  const counts = countStates(beadhiveState.snapshot);
  host.classList.toggle("open", beadhiveState.trayOpen);
  host.hidden = !beadhiveState.enabled;
  if (!beadhiveState.enabled) {
    host.replaceChildren();
    return;
  }
  if (beadhiveState.trayOpen && !beadhiveState.trayLoading) {
    const scope = activeScopeId() ?? "";
    if (beadhiveState.snapshot && beadhiveState.snapshotScope !== scope) {
      beadhiveState.selectedId = "";
      void loadTray();
    }
  }
  if (!beadhiveState.trayOpen) {
    const rail = document.createElement("div");
    render(
      html`<button
        class="bh-tray-launcher"
        type="button"
        title="Show tasks"
        aria-label="Show tasks"
        aria-expanded="false"
        @click=${toggleHiveTray}
      >
        ${icon(PanelRightOpen, 17)}
        ${counts.needs_review ? html`<span class="bh-tray-launcher-count needs">${counts.needs_review}</span>` : nothing}
        ${beadhiveState.snapshot ? html`<span class="bh-tray-launcher-count">${counts.ready ?? 0}</span>` : nothing}
      </button>`,
      rail,
    );
    host.replaceChildren(rail);
    return;
  }
  const inner = document.createElement("div");
  render(
    html`
      <header class="bh-tray-head">
        <div class="bh-tray-title">Tasks</div>
        <div class="bh-tray-actions">
          <button
            class="pane-refresh"
            type="button"
            aria-label="Refresh tasks"
            title="Refresh tasks"
            ?disabled=${beadhiveState.trayLoading}
            @click=${() => void manualRefresh()}
          >
            ${icon(RefreshCw, 15)}
          </button>
          <button class="pane-refresh" type="button" aria-label="Close tasks" @click=${toggleHiveTray}>
            ${icon(PanelRightClose, 15)}
          </button>
        </div>
      </header>
      <div class="bh-tray-asof">
        ${
          beadhiveState.trayLoading
            ? "Reading the fleet…"
            : html`${counts.ready ?? 0} ready · ${counts.blocked ?? 0} blocked · read
              ${asOfLabel(beadhiveState.snapshot)}`
        }
        ${
          beadhiveState.snapshot && !beadhiveState.snapshot.reachedEvery
            ? html`<span class="bh-source-bad">partial</span>`
            : nothing
        }
      </div>
      ${beadhiveState.notice ? html`<div class="bh-tray-notice">${beadhiveState.notice}</div>` : nothing} ${trayBody()}
    `,
    inner,
  );
  host.replaceChildren(inner);
}

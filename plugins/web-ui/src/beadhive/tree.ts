import type { WorkItem, WorkSnapshot } from "./state";

export interface TaskNode {
  item: WorkItem;
  children: TaskNode[];
}

export interface TaskGroups {
  needsReview: WorkItem[];
  roots: TaskNode[];
}

const STATE_RANK: Record<string, number> = {
  needs_review: 0,
  in_progress: 1,
  ready: 2,
  blocked: 3,
};

export function stateRank(state: string): number {
  return STATE_RANK[state] ?? 9;
}

export function compareTasks(a: WorkItem, b: WorkItem): number {
  const byState = stateRank(a.state) - stateRank(b.state);
  if (byState !== 0) return byState;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.id.localeCompare(b.id);
}

export function buildTaskTree(items: readonly WorkItem[]): TaskGroups {
  const nodes = new Map<string, TaskNode>();
  for (const item of items) nodes.set(item.id, { item, children: [] });

  const roots: TaskNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.item.parentId ? nodes.get(node.item.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortTree = (list: TaskNode[]): void => {
    list.sort((x, y) => compareTasks(x.item, y.item));
    for (const child of list) sortTree(child.children);
  };
  sortTree(roots);

  return {
    needsReview: items
      .filter((i) => i.state === "needs_review")
      .slice()
      .sort(compareTasks),
    roots,
  };
}

export function countStates(snapshot: WorkSnapshot | null): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const source of snapshot?.sources ?? []) {
    for (const item of source.items) counts[item.state] = (counts[item.state] ?? 0) + 1;
  }
  return counts;
}

export function findTask(snapshot: WorkSnapshot | null, id: string): WorkItem | null {
  for (const source of snapshot?.sources ?? []) {
    const hit = source.items.find((i) => i.id === id);
    if (hit) return hit;
  }
  return null;
}

export function descendantCount(node: TaskNode): number {
  return node.children.reduce((sum, child) => sum + 1 + descendantCount(child), 0);
}

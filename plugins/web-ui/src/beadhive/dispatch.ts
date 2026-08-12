import type { WorkItem } from "./state";

export function dispatchPrompt(item: { id: string; title: string }): string {
  return `Work ${item.id} — ${item.title}`;
}

export function fillComposer(text: string, root: ParentNode = document): boolean {
  const input = root.querySelector<HTMLTextAreaElement>(".composer-input");
  if (!input) return false;
  const existing = input.value.trim();
  input.value = existing ? `${existing}\n${text}` : text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  return true;
}

export function dispatchToChat(item: WorkItem, switchToChats?: () => void): boolean {
  switchToChats?.();
  return fillComposer(dispatchPrompt(item));
}

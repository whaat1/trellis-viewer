export type TreeOrder = Record<string, string[]>;
export const treeOrderStorageKey = (projectId: string) => `trellis.viewer.tree-order.v1:${projectId}`;
export function parseTreeOrder(value: string | null): TreeOrder {
  try {
    const parsed: unknown = JSON.parse(value ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every(key => typeof key === 'string')).map(([key, values]) => [key, [...new Set(values)]]));
  } catch { return {}; }
}
export function orderedKeys(keys: string[], saved: string[] = []): string[] {
  const live = new Set(keys);
  return [...new Set([...saved.filter(key => live.has(key)), ...keys])];
}
export function moveTreeItem(order: TreeOrder, scope: string, siblings: string[], from: string, to: string): TreeOrder {
  if (from === to || !siblings.includes(from) || !siblings.includes(to)) return order;
  const keys = orderedKeys(siblings, order[scope]);
  const target = keys.indexOf(to);
  keys.splice(keys.indexOf(from), 1);
  keys.splice(target, 0, from);
  // Retain absent entries so temporary filesystem omissions do not erase preferences.
  return { ...order, [scope]: [...keys, ...(order[scope] ?? []).filter(key => !keys.includes(key))] };
}

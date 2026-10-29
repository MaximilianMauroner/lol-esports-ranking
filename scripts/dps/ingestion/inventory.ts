import type { RiotItemEvent } from "../../../src/domains/dps/observation-types.ts";

function removeOne(inventory: number[], itemId: number): void {
  const index = inventory.indexOf(itemId);
  if (index >= 0) inventory.splice(index, 1);
}

export function applyInventoryEvent(inventory: number[], event: RiotItemEvent): number[] {
  const next = [...inventory];
  if (event.type === "ITEM_PURCHASED" && event.itemId) next.push(event.itemId);
  if ((event.type === "ITEM_SOLD" || event.type === "ITEM_DESTROYED") && event.itemId) {
    removeOne(next, event.itemId);
  }
  if (event.type === "ITEM_UNDO") {
    if (event.beforeId) removeOne(next, event.beforeId);
    if (event.afterId) next.push(event.afterId);
  }
  return next;
}

export function reconstructInventories(
  participantIds: number[],
  events: RiotItemEvent[],
): Map<number, number[]> {
  const inventories = new Map(participantIds.map((id) => [id, [] as number[]]));
  for (const event of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    if (!event.participantId) continue;
    inventories.set(
      event.participantId,
      applyInventoryEvent(inventories.get(event.participantId) ?? [], event),
    );
  }
  return inventories;
}

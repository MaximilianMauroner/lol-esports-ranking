export interface StaticItemShape {
  id: number;
  name: string;
  tags: string[];
  goldTotal: number;
  purchasable: boolean;
  fromIds: number[];
  intoIds: number[];
  maps: Record<string, boolean>;
}

import type { RiotItemEvent } from "./observation-types.ts";

const EXCLUDED_IDS = new Set([2055, 2138, 2139, 2140, 3340, 3363, 3364]);
const EXCLUDED_TAGS = new Set(["Boots", "Consumable", "Trinket", "GoldPer", "Support", "Quest"]);
const EXCLUDED_NAME_PATTERN =
  /\b(?:ward|world atlas|runic compass|watchful wardstone|vigilant wardstone)\b/i;

export function isCompletedLegendary(item: StaticItemShape): boolean {
  if (!item.purchasable || !item.maps["11"] || EXCLUDED_IDS.has(item.id)) return false;
  if (item.tags.some((tag) => EXCLUDED_TAGS.has(tag)) || EXCLUDED_NAME_PATTERN.test(item.name))
    return false;
  // A purchasable Summoner's Rift item with recipe components, no upgrade target, and substantial
  // total cost is the most stable Data Dragon-only definition. Explicit exclusions handle utility items.
  return item.fromIds.length > 0 && item.intoIds.length === 0 && item.goldTotal >= 2000;
}

export function findThirdItemTimestamp(
  frames: Array<{ timestamp: number; inventory: number[] }>,
  items: Map<number, StaticItemShape>,
): number | null {
  for (const frame of frames) {
    const count = frame.inventory.filter((id) => {
      const item = items.get(id);
      return item ? isCompletedLegendary(item) : false;
    }).length;
    if (count >= 3) return frame.timestamp;
  }
  return null;
}

export interface ThirdItemAnchor {
  /** The selected one-minute participant frame used for enemy snapshots. */
  frameTimestamp: number;
  /** Timestamp of the purchase/undo event that completed the third legendary. */
  eventTimestamp: number;
  frameDistanceMs: number;
}

/**
 * Finds the first frame whose reconstructed inventory has three completed legendaries and
 * separately identifies the event that crossed that boundary. Riot frames are snapshots; the
 * event timestamp is retained so downstream consumers do not mistake the frame minute for a
 * purchase time.
 */
export function findThirdItemAnchor(
  frames: Array<{ timestamp: number; inventory: number[] }>,
  events: RiotItemEvent[],
  items: Map<number, StaticItemShape>,
): ThirdItemAnchor | null {
  const orderedFrames = [...frames].sort((a, b) => a.timestamp - b.timestamp);
  const orderedEvents = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const first = orderedFrames.find(
    (frame) =>
      frame.inventory.filter((id) => {
        const item = items.get(id);
        return item ? isCompletedLegendary(item) : false;
      }).length >= 3,
  );
  if (!first) return null;

  let inventory: number[] = [];
  for (const event of orderedEvents) {
    if (event.timestamp > first.timestamp) break;
    const beforeCount = inventory.filter((id) => {
      const item = items.get(id);
      return item ? isCompletedLegendary(item) : false;
    }).length;
    inventory = applyInventoryEventForAnchor(inventory, event);
    const afterCount = inventory.filter((id) => {
      const item = items.get(id);
      return item ? isCompletedLegendary(item) : false;
    }).length;
    if (beforeCount < 3 && afterCount >= 3) {
      return {
        frameTimestamp: first.timestamp,
        eventTimestamp: event.timestamp,
        frameDistanceMs: Math.max(0, first.timestamp - event.timestamp),
      };
    }
  }
  return null;
}

export function nearestFrameWithin<T extends { timestamp: number }>(
  frames: T[],
  targetTimestamp: number,
  toleranceMs: number,
): T | null {
  const nearest = [...frames].sort(
    (left, right) =>
      Math.abs(left.timestamp - targetTimestamp) - Math.abs(right.timestamp - targetTimestamp),
  )[0];
  return nearest && Math.abs(nearest.timestamp - targetTimestamp) <= toleranceMs ? nearest : null;
}

function applyInventoryEventForAnchor(inventory: number[], event: RiotItemEvent): number[] {
  const next = [...inventory];
  if (event.type === "ITEM_PURCHASED" && event.itemId) next.push(event.itemId);
  if ((event.type === "ITEM_SOLD" || event.type === "ITEM_DESTROYED") && event.itemId) {
    const index = next.indexOf(event.itemId);
    if (index >= 0) next.splice(index, 1);
  }
  if (event.type === "ITEM_UNDO") {
    if (event.beforeId) {
      const index = next.indexOf(event.beforeId);
      if (index >= 0) next.splice(index, 1);
    }
    if (event.afterId) next.push(event.afterId);
  }
  return next;
}

import type { Target } from "./types.ts";

const fixtureRows: Array<[string, string, number, number, number, number, number, number]> = [
  ["Aatrox", "TOP", 2850, 132, 62, 890, 15, 27],
  ["Ornn", "TOP", 3410, 188, 91, 1370, 15, 28],
  ["Jax", "TOP", 2520, 116, 65, 610, 14, 26],
  ["Lee Sin", "JUNGLE", 2410, 108, 58, 480, 14, 25],
  ["Sejuani", "JUNGLE", 3190, 171, 84, 1180, 14, 27],
  ["Viego", "JUNGLE", 2460, 103, 61, 420, 14, 26],
  ["Ahri", "MIDDLE", 2180, 78, 55, 190, 14, 25],
  ["Syndra", "MIDDLE", 2070, 72, 53, 80, 14, 24],
  ["Yasuo", "MIDDLE", 2340, 101, 57, 310, 14, 26],
  ["Jinx", "BOTTOM", 1980, 69, 49, 0, 13, 25],
  ["Kai'Sa", "BOTTOM", 2050, 73, 51, 70, 13, 25],
  ["Ezreal", "BOTTOM", 2210, 84, 55, 180, 13, 26],
  ["Nautilus", "UTILITY", 2860, 154, 72, 940, 12, 25],
  ["Lulu", "UTILITY", 2080, 91, 61, 230, 12, 24],
  ["Rakan", "UTILITY", 2380, 112, 68, 470, 12, 26],
  ["Gwen", "TOP", 2670, 119, 78, 700, 15, 29],
  ["Nocturne", "JUNGLE", 2550, 111, 64, 540, 14, 27],
  ["Orianna", "MIDDLE", 2140, 76, 58, 140, 14, 27],
  ["Aphelios", "BOTTOM", 2010, 70, 50, 0, 13, 26],
  ["Braum", "UTILITY", 3010, 178, 88, 1110, 12, 27],
];

export const fixtureTargets: Target[] = fixtureRows.map(
  ([champion, role, health, armor, magicResist, bonusHealth, level, minute], index) => ({
    id: `fixture-${index + 1}`,
    champion,
    role,
    health,
    armor,
    magicResist,
    bonusHealth,
    level,
    minute,
    provenance: "fixture",
  }),
);

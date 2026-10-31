export interface ItemMechanic {
  id: number;
  name: string;
  goldTotal: number;
  attackDamage?: number;
  attackSpeed?: number;
  abilityHaste?: number;
  ultimateAbilityHaste?: number;
  critChance?: number;
  critDamage?: number;
  armorPenPercent?: number;
  armor?: number;
  magicResist?: number;
  lifeSteal?: number;
  omnivamp?: number;
  movementSpeed?: number;
  boots?: boolean;
  /** Explicit scope note shown with simulator results. */
  warning?: string;
  /** Damage-relevant item data pinned to Data Dragon/CommunityDragon 16.18. */
  damage?: {
    hexoptics?: {
      maxRange: number;
      maxDamageAmp: number;
    };
    fiendhunter?: {
      duration: number;
      bonusAttackSpeed: number;
      attacks: number;
      critModifier: number;
      bonusTrueDamage: number;
      cooldown: number;
    };
    stormrazor?: {
      procDamage: number;
      bonusMovementSpeed: number;
      bonusMovementDuration: number;
      attackStacks: number;
      movementUnitsPerStack: number;
      maxStacks: number;
    };
    bladeOfTheRuinedKing?: {
      rangedCurrentHealthPercent: number;
      meleeCurrentHealthPercent: number;
      monsterDamageCap: number;
    };
    terminus?: {
      onHitBaseDamage: number;
      onHitBonusAdRatio: number;
      onHitApRatio: number;
      penPerDarkAttack: number;
      maxDarkStacks: number;
      lightResistPerAttackByLevel: readonly { minLevel: number; value: number }[];
      maxLightStacks: number;
      buffDuration: number;
    };
  };
}

export interface ItemStats {
  attackDamage: number;
  attackSpeed: number;
  abilityHaste: number;
  ultimateAbilityHaste: number;
  critChance: number;
  critDamage: number;
  armorPenPercent: number;
  armorPenPercentSources: number[];
  armor: number;
  magicResist: number;
  lifeSteal: number;
  omnivamp: number;
  movementSpeed: number;
}

const TERMINUS_LIGHT_RESIST = [
  { minLevel: 14, value: 8 },
  { minLevel: 11, value: 7 },
  { minLevel: 1, value: 6 },
] as const;

export const STORMRAZOR_MAX_ENERGIZE = 100;
export const STORMRAZOR_ATTACK_ENERGIZE = 6;
export const STORMRAZOR_MOVEMENT_UNITS_PER_STACK = 24;

export const ITEMS: Record<number, ItemMechanic> = {
  3006: {
    id: 3006,
    name: "Berserker's Greaves",
    goldTotal: 1100,
    attackSpeed: 0.3,
    boots: true,
  },
  3008: {
    id: 3008,
    name: "Gluttonous Greaves",
    goldTotal: 1000,
    omnivamp: 0.04,
    movementSpeed: 45,
    boots: true,
    warning:
      "Gluttonous Greaves omnivamp and takedown stacks have no damage effect in the single-target scenario; the stat and boot are still modeled.",
  },
  // Data Dragon / CommunityDragon 16.18.1: 50 AD, 45% AS, 0% crit.
  // Practice Makes Lethal and Flurry are modeled in the Yunara plugin because they
  // depend on attack timing and the explicit starting-stack assumption.
  3032: {
    id: 3032,
    name: "Yun Tal Wildarrows",
    goldTotal: 3000,
    attackDamage: 50,
    attackSpeed: 0.45,
  },
  2523: {
    id: 2523,
    name: "Hexoptics C44",
    goldTotal: 2800,
    attackDamage: 55,
    critChance: 0.25,
    damage: { hexoptics: { maxRange: 500, maxDamageAmp: 0.1 } },
  },
  3031: {
    id: 3031,
    name: "Infinity Edge",
    goldTotal: 3500,
    attackDamage: 75,
    critChance: 0.25,
    critDamage: 0.3,
  },
  3036: {
    id: 3036,
    name: "Lord Dominik's Regards",
    goldTotal: 3300,
    attackDamage: 35,
    critChance: 0.25,
    armorPenPercent: 0.35,
  },
  3085: {
    id: 3085,
    name: "Runaan's Hurricane",
    goldTotal: 2650,
    attackSpeed: 0.4,
    critChance: 0.25,
    warning:
      "Runaan's secondary bolts are intentionally absent: this is a single-target scenario with no nearby secondary targets; its primary attack stats are modeled.",
  },
  3046: {
    id: 3046,
    name: "Phantom Dancer",
    goldTotal: 2650,
    attackSpeed: 0.65,
    critChance: 0.25,
    movementSpeed: 0.1,
    warning:
      "Phantom Dancer's Ghosted movement effect has no damage effect in the stationary single-target scenario; attack stats are modeled.",
  },
  3072: {
    id: 3072,
    name: "Bloodthirster",
    goldTotal: 3400,
    attackDamage: 80,
    lifeSteal: 0.15,
    warning:
      "Bloodthirster's lifesteal and Ichorshield have no damage effect without attacker-death or healing state; attack damage is modeled.",
  },
  3095: {
    id: 3095,
    name: "Stormrazor",
    goldTotal: 3200,
    attackDamage: 50,
    attackSpeed: 0.25,
    critChance: 0.25,
    damage: {
      stormrazor: {
        procDamage: 100,
        bonusMovementSpeed: 0.45,
        bonusMovementDuration: 1.5,
        attackStacks: STORMRAZOR_ATTACK_ENERGIZE,
        movementUnitsPerStack: STORMRAZOR_MOVEMENT_UNITS_PER_STACK,
        maxStacks: STORMRAZOR_MAX_ENERGIZE,
      },
    },
    warning:
      "Stormrazor Energize is modeled from the supplied starting stacks (0 by default), six stacks per basic attack, and optional movement; no movement is assumed unless provided.",
  },
  3153: {
    id: 3153,
    name: "Blade of The Ruined King",
    goldTotal: 3200,
    attackDamage: 40,
    attackSpeed: 0.25,
    lifeSteal: 0.1,
    damage: {
      bladeOfTheRuinedKing: {
        rangedCurrentHealthPercent: 0.06,
        meleeCurrentHealthPercent: 0.09,
        monsterDamageCap: 100,
      },
    },
  },
  3302: {
    id: 3302,
    name: "Terminus",
    goldTotal: 3000,
    attackDamage: 30,
    attackSpeed: 0.35,
    damage: {
      terminus: {
        onHitBaseDamage: 30,
        onHitBonusAdRatio: 0.1,
        onHitApRatio: 0.1,
        penPerDarkAttack: 0.1,
        maxDarkStacks: 3,
        lightResistPerAttackByLevel: TERMINUS_LIGHT_RESIST,
        maxLightStacks: 3,
        buffDuration: 5,
      },
    },
    warning:
      "Terminus alternates Light then Dark attacks; its magic on-hit and five-second penetration/resistance stacks are modeled. Light defensive stacks do not change outgoing damage here.",
  },
  3026: {
    id: 3026,
    name: "Guardian Angel",
    goldTotal: 3200,
    attackDamage: 55,
    armor: 45,
    warning:
      "Guardian Angel's Rebirth is defensive and has no damage effect while the attacker is not killed in this scenario.",
  },
  3139: {
    id: 3139,
    name: "Mercurial Scimitar",
    goldTotal: 3200,
    attackDamage: 50,
    magicResist: 35,
    lifeSteal: 0.1,
    warning:
      "Mercurial Scimitar's Quicksilver active and lifesteal have no damage effect without crowd-control or attacker-survival state; attack damage is modeled.",
  },
  3033: {
    id: 3033,
    name: "Mortal Reminder",
    goldTotal: 3000,
    attackDamage: 35,
    critChance: 0.25,
    armorPenPercent: 0.3,
    warning:
      "Mortal Reminder's Grievous Wounds has no damage effect because target healing is outside this single-target damage scope; attack stats and penetration are modeled.",
  },
  2512: {
    id: 2512,
    name: "Fiendhunter Bolts",
    goldTotal: 2650,
    attackSpeed: 0.45,
    ultimateAbilityHaste: 30,
    critChance: 0.25,
    movementSpeed: 0.04,
    damage: {
      fiendhunter: {
        duration: 8,
        bonusAttackSpeed: 0.5,
        attacks: 3,
        critModifier: 0.8,
        bonusTrueDamage: 0.15,
        cooldown: 45,
      },
    },
  },
  6672: { id: 6672, name: "Kraken Slayer", goldTotal: 3000, attackDamage: 45, attackSpeed: 0.4 },
};

export function itemStats(itemIds: number[]): ItemStats {
  return itemIds.reduce<ItemStats>(
    (stats, id) => {
      const item = ITEMS[id];
      if (!item) return stats;
      stats.attackDamage += item.attackDamage ?? 0;
      stats.attackSpeed += item.attackSpeed ?? 0;
      stats.abilityHaste += item.abilityHaste ?? 0;
      stats.ultimateAbilityHaste += item.ultimateAbilityHaste ?? 0;
      stats.critChance += item.critChance ?? 0;
      stats.critDamage += item.critDamage ?? 0;
      stats.armorPenPercent = Math.max(stats.armorPenPercent, item.armorPenPercent ?? 0);
      if (item.armorPenPercent !== undefined) {
        stats.armorPenPercentSources.push(item.armorPenPercent);
      }
      stats.armor += item.armor ?? 0;
      stats.magicResist += item.magicResist ?? 0;
      stats.lifeSteal += item.lifeSteal ?? 0;
      stats.omnivamp += item.omnivamp ?? 0;
      stats.movementSpeed += item.movementSpeed ?? 0;
      return stats;
    },
    {
      attackDamage: 0,
      attackSpeed: 0,
      abilityHaste: 0,
      ultimateAbilityHaste: 0,
      critChance: 0,
      critDamage: 0,
      armorPenPercent: 0,
      armorPenPercentSources: [],
      armor: 0,
      magicResist: 0,
      lifeSteal: 0,
      omnivamp: 0,
      movementSpeed: 0,
    },
  );
}

export function buildGoldTotal(itemIds: number[]): number {
  return itemIds.reduce((total, id) => total + (ITEMS[id]?.goldTotal ?? 0), 0);
}

export function unsupportedItemIds(itemIds: number[]): number[] {
  return [...new Set(itemIds.filter((id) => !ITEMS[id]))];
}

/** Completed items are unique in a legal six-slot build. */
export function duplicateItemIds(itemIds: number[]): number[] {
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const id of itemIds) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort((left, right) => left - right);
}

export function itemWarnings(itemIds: number[]): string[] {
  return [
    ...new Set(
      itemIds
        .map((id) => ITEMS[id]?.warning)
        .filter((warning): warning is string => Boolean(warning)),
    ),
  ];
}

export function giantSlayerMultiplier(bonusHealth: number): number {
  return 1 + Math.min(0.15, Math.max(0, bonusHealth) / 10_000);
}

export function krakenBaseDamage(level: number): number {
  // Ranged users deal 80%. 150 at levels 1–8, then +5 each level through 200 at 18.
  return 0.8 * (level <= 8 ? 150 : Math.min(200, 150 + (level - 8) * 5));
}

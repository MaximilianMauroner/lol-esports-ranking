import {
  giantSlayerMultiplier,
  ITEMS,
  itemStats,
  itemWarnings,
  krakenBaseDamage,
  STORMRAZOR_MAX_ENERGIZE,
} from "../items.ts";
import { applyPercentPenetrationSources, growthAtLevel, mitigate, round } from "../math.ts";
import type { ChampionPlugin } from "./plugin.ts";
import type { DamageEvent, DamageType, SimulationResult } from "../types.ts";

const BASE_AD = 55;
const AD_GROWTH = 3;
const BASE_AS = 0.65;
const AS_GROWTH = 0.02;
// Patch 26.18 inherits the global 2.00x critical-strike baseline introduced in 26.1.
const BASE_CRIT_DAMAGE = 2;
const Q_DURATION_SECONDS = 5;
const R_DURATION_SECONDS = 15;
const ABILITY_CAST_SECONDS = { Q: 0.25, W: 0.5, R: 0.25, E: 0.25 } as const;
const ABILITY_COOLDOWN_SECONDS = { W: 10, E: 9, R: [0, 100, 90, 80] } as const;
const SCRIPTED_ATTACK_LOCK_SECONDS = 0.25;
const YUN_TAL_MAX_STACKS = 125;
const YUN_TAL_CRIT_PER_STACK = 0.002;
const YUN_TAL_FLURRY_ATTACK_SPEED = 0.3;
const YUN_TAL_FLURRY_DURATION_SECONDS = 6;
const YUN_TAL_FLURRY_COOLDOWN_SECONDS = 30;
const DEFAULT_ATTACK_DISTANCE = 500;
const DEFAULT_MOVEMENT_UNITS_PER_SECOND = 0;
const EPSILON = 1e-9;

type State = {
  qUntil: number;
  rUntil: number;
  rExitHandled: boolean;
  wReadyAt: number;
  eReadyAt: number;
  rReadyAt: number;
  attacks: number;
  targetHealth: number;
  nextAttackReady: number;
  yunTalStacks: number;
  flurryUntil: number;
  flurryReadyAt: number;
  flurryActivations: number;
  fiendhunterUntil: number;
  fiendhunterReadyAt: number;
  fiendhunterAttacks: number;
  stormrazorStacks: number;
  stormrazorLastEnergizeTime: number;
  stormrazorProcs: number;
  terminusNextMode: "light" | "dark";
  terminusLightStacks: number;
  terminusLightUntil: number;
  terminusDarkStacks: number;
  terminusDarkUntil: number;
};

function qMagicOnHit(rank: number, ap: number): number {
  return [0, 5, 10, 15, 20, 25][rank]! + 0.2 * ap;
}

function qAttackSpeed(rank: number): number {
  return [0, 0.2, 0.3, 0.4, 0.5, 0.6][rank]!;
}

export const yunara: ChampionPlugin = {
  id: 804,
  slug: "yunara",
  patch: "26.18",
  simulate(input): SimulationResult {
    const targetMode = input.targetMode ?? "mortal";
    const items = itemStats(input.build.itemIds);
    const totalAd = BASE_AD + growthAtLevel(AD_GROWTH, input.level) + items.attackDamage;
    const critDamage = BASE_CRIT_DAMAGE + items.critDamage;
    const hasLdr = input.build.itemIds.includes(3036);
    const hasKraken = input.build.itemIds.includes(6672);
    const hasYunTal = input.build.itemIds.includes(3032);
    const hexoptics = input.build.itemIds
      .map((id) => ITEMS[id]?.damage?.hexoptics)
      .find((mechanic) => mechanic !== undefined);
    const fiendhunter = input.build.itemIds
      .map((id) => ITEMS[id]?.damage?.fiendhunter)
      .find((mechanic) => mechanic !== undefined);
    const stormrazor = input.build.itemIds
      .map((id) => ITEMS[id]?.damage?.stormrazor)
      .find((mechanic) => mechanic !== undefined);
    const bladeOfTheRuinedKing = input.build.itemIds
      .map((id) => ITEMS[id]?.damage?.bladeOfTheRuinedKing)
      .find((mechanic) => mechanic !== undefined);
    const terminus = input.build.itemIds
      .map((id) => ITEMS[id]?.damage?.terminus)
      .find((mechanic) => mechanic !== undefined);
    const yunTalStacksStart = clampYunTalStacks(input.yunTalStacks);
    const stormrazorStacksStart = clampStormrazorStacks(input.stormrazorStacks);
    const attackDistance = clamp(input.attackDistance ?? DEFAULT_ATTACK_DISTANCE, 0, 500);
    const movementUnitsPerSecond = Math.max(
      0,
      finiteOr(input.movementUnitsPerSecond, DEFAULT_MOVEMENT_UNITS_PER_SECOND),
    );
    const abilityPower = 0;
    const abilityHaste = Math.max(0, finiteOr(input.abilityHaste, 0) + items.abilityHaste);
    const ultimateAbilityHaste = Math.max(
      0,
      finiteOr(input.ultimateAbilityHaste, 0) + items.ultimateAbilityHaste,
    );
    const targetAmp = hasLdr ? giantSlayerMultiplier(input.target.bonusHealth) : 1;
    const staticArmorPenetration = items.armorPenPercentSources;
    const hexopticsAmp = hexoptics
      ? 1 + (attackDistance / hexoptics.maxRange) * hexoptics.maxDamageAmp
      : 1;
    const state: State = {
      qUntil: -1,
      rUntil: -1,
      rExitHandled: true,
      wReadyAt: 0,
      eReadyAt: 0,
      rReadyAt: 0,
      attacks: 0,
      targetHealth: input.target.health,
      nextAttackReady: 0,
      yunTalStacks: yunTalStacksStart,
      flurryUntil: -1,
      flurryReadyAt: 0,
      flurryActivations: 0,
      fiendhunterUntil: -1,
      fiendhunterReadyAt: 0,
      fiendhunterAttacks: 0,
      stormrazorStacks: stormrazorStacksStart,
      stormrazorLastEnergizeTime: 0,
      stormrazorProcs: 0,
      terminusNextMode: "light",
      terminusLightStacks: 0,
      terminusLightUntil: -1,
      terminusDarkStacks: 0,
      terminusDarkUntil: -1,
    };
    const includeEvents = input.includeEvents !== false;
    const includeWarnings = input.includeWarnings !== false;
    const events: DamageEvent[] = [];
    const split = { physical: 0, magic: 0, true: 0 };
    const sources: Record<string, number> = {};
    let firstKillTime: number | null = null;
    let overkillTotal = 0;
    const warnings: string[] = includeWarnings
      ? [
          "Expected crit mode averages crits; individual attacks are not RNG rolls.",
          "Mortal-target mode stops at first death; damage shown excludes overkill.",
          "AA timing uses attack-readiness intervals and a 0.25s scripted action lock; champion windups/resets are not modeled.",
          "E is selectable for combo planning but is mobility-only and intentionally contributes no damage.",
          ...itemWarnings(input.build.itemIds),
        ]
      : [];
    if (includeWarnings && hexoptics) {
      warnings.push(
        `Hexoptics Magnification uses ${round(attackDistance)} attack range units (maximum ${hexoptics.maxRange}); its ${round(hexoptics.maxDamageAmp * 100)}% attack-damage amp is applied to attack events.`,
      );
    }
    if (includeWarnings && bladeOfTheRuinedKing) {
      warnings.push(
        `Blade of the Ruined King's ranged Mist's Edge is modeled as ${round(bladeOfTheRuinedKing.rangedCurrentHealthPercent * 100, 1)}% of target current health before each attack.`,
      );
    }
    if (includeWarnings && fiendhunter) {
      warnings.push(
        "Fiendhunter Opening Barrage is modeled after each available R cast: three guaranteed 80%-strength crit attacks, with the documented true-damage substitution for attacks that would already crit.",
      );
    }
    if (includeWarnings && stormrazor) {
      warnings.push(
        `Stormrazor starts at ${round(stormrazorStacksStart)} / ${stormrazor.maxStacks} Energize stacks, gains ${stormrazor.attackStacks} per basic attack, and gains movement stacks only from the supplied movement rate.`,
      );
    }
    if (includeWarnings && abilityHaste > 0) {
      warnings.push(`Ability haste ${round(abilityHaste)} is applied to Yunara's W/E/R cooldowns.`);
    }
    if (includeWarnings && ultimateAbilityHaste > 0) {
      warnings.push(
        `Ultimate ability haste ${round(ultimateAbilityHaste)} is applied only to Yunara's R cooldown.`,
      );
    }
    if (includeWarnings && hasYunTal) {
      warnings.push(
        "Yun Tal Practice Makes Lethal starts at " +
          yunTalStacksStart +
          "/125 ranged stacks; Match-V5 frames do not expose crit chance, so this is an explicit assumption.",
      );
      warnings.push(
        "Yun Tal Flurry is modeled at +30% bonus AS for 6s; its cooldown uses expected 1s + crit-chance on-hit reduction rather than sampled crit rolls.",
      );
    }
    if (includeWarnings && targetMode === "uncapped") {
      warnings.push(
        "Training-dummy mode is explicitly uncapped: the target never stops receiving events; it is not a time-to-kill result.",
      );
    }
    const isDead = () => targetMode === "mortal" && state.targetHealth <= EPSILON;
    const yunTalCritChance = () =>
      hasYunTal
        ? Math.min(1, items.critChance + state.yunTalStacks * YUN_TAL_CRIT_PER_STACK)
        : Math.min(1, items.critChance);

    const expireTimedItemStates = (time: number) => {
      if (terminus) {
        if (time > state.terminusLightUntil + EPSILON) state.terminusLightStacks = 0;
        if (time > state.terminusDarkUntil + EPSILON) state.terminusDarkStacks = 0;
      }
      if (fiendhunter && time > state.fiendhunterUntil + EPSILON) {
        state.fiendhunterAttacks = 0;
      }
    };

    const resistanceAt = (type: DamageType, time: number): number => {
      if (type === "true") return 0;
      expireTimedItemStates(time);
      const darkPen = terminus
        ? Math.min(terminus.maxDarkStacks, state.terminusDarkStacks) * terminus.penPerDarkAttack
        : 0;
      const percentages = [darkPen];
      if (type === "physical") percentages.unshift(...staticArmorPenetration);
      const baseResistance = type === "physical" ? input.target.armor : input.target.magicResist;
      return applyPercentPenetrationSources(baseResistance, percentages);
    };

    const add = (
      time: number,
      source: string,
      type: DamageType,
      raw: number,
      notes: string[] = [],
      options: { attack?: boolean } = {},
    ) => {
      if (time > input.durationSeconds || raw <= 0 || isDead()) return false;
      const resistance = resistanceAt(type, time);
      const attackMultiplier = options.attack ? hexopticsAmp : 1;
      const multiplier = targetAmp * attackMultiplier;
      const attemptedFinal = (type === "true" ? raw : mitigate(raw, resistance)) * multiplier;
      const remaining = Math.max(0, state.targetHealth);
      const final = targetMode === "mortal" ? Math.min(attemptedFinal, remaining) : attemptedFinal;
      const overkill = targetMode === "mortal" ? Math.max(0, attemptedFinal - final) : 0;
      state.targetHealth -= final;
      split[type] += final;
      sources[source] = (sources[source] ?? 0) + final;
      overkillTotal += overkill;
      if (firstKillTime === null && targetMode === "mortal" && state.targetHealth <= EPSILON) {
        firstKillTime = time;
      }
      if (includeEvents) {
        if (hasLdr) notes = [...notes, `Giant Slayer ×${round(targetAmp, 3)}`];
        if (options.attack && hexoptics) {
          notes = [...notes, `Hexoptics ×${round(hexopticsAmp, 3)}`];
        }
        events.push({
          time: round(time, 3),
          source,
          type,
          raw: round(raw, 3),
          resistance: round(resistance, 2),
          multiplier: round(multiplier, 3),
          attemptedFinal: round(attemptedFinal, 3),
          final: round(final, 3),
          overkill: round(overkill, 3),
          targetHealthAfter: round(Math.max(0, state.targetHealth), 2),
          notes,
        });
      }
      return final > 0 || overkill > 0;
    };

    // W snapshots its raw damage at cast time, but health and mitigation must
    // be evaluated when the tick lands. Drain before actions at the same time.
    const pendingDamage: Parameters<typeof add>[] = [];
    const drainDamageThrough = (time: number) => {
      while (pendingDamage.length > 0 && pendingDamage[0]![0] <= time) {
        add(...pendingDamage.shift()!);
      }
    };

    const fiendhunterActiveAt = (time: number): boolean => {
      expireTimedItemStates(time);
      return Boolean(
        fiendhunter && state.fiendhunterAttacks > 0 && time <= state.fiendhunterUntil + EPSILON,
      );
    };

    const attackSpeedAt = (time: number) => {
      const qBonus = time < state.qUntil ? qAttackSpeed(input.ranks.q) : 0;
      const flurryBonus = hasYunTal && time < state.flurryUntil ? YUN_TAL_FLURRY_ATTACK_SPEED : 0;
      const fiendhunterBonus = fiendhunterActiveAt(time) ? fiendhunter!.bonusAttackSpeed : 0;
      return Math.min(
        2.5,
        BASE_AS *
          (1 +
            growthAtLevel(AS_GROWTH, input.level) +
            items.attackSpeed +
            qBonus +
            flurryBonus +
            fiendhunterBonus),
      );
    };

    const advanceStormrazorMovement = (time: number) => {
      if (!stormrazor) return;
      const elapsed = Math.max(0, time - state.stormrazorLastEnergizeTime);
      state.stormrazorStacks = Math.min(
        stormrazor.maxStacks,
        state.stormrazorStacks +
          elapsed * (movementUnitsPerSecond / stormrazor.movementUnitsPerStack),
      );
      state.stormrazorLastEnergizeTime = time;
    };

    const activateFiendhunter = (time: number) => {
      if (!fiendhunter || time + EPSILON < state.fiendhunterReadyAt) return;
      state.fiendhunterUntil = time + fiendhunter.duration;
      state.fiendhunterReadyAt = time + fiendhunter.cooldown;
      state.fiendhunterAttacks = fiendhunter.attacks;
    };

    const cooldownWithHaste = (base: number, haste = abilityHaste): number =>
      base <= 0 ? 0 : base * (100 / (100 + haste));

    const rCooldownBase = () =>
      ABILITY_COOLDOWN_SECONDS.R[Math.max(0, Math.min(3, Math.round(input.ranks.r)))] ?? 0;

    const applyRExitEffects = (time: number) => {
      if (state.rExitHandled || state.rUntil < 0 || time < state.rUntil - EPSILON) return;
      // Arc of Ruin reduces W's remaining cooldown by 80% when Transcendent
      // State ends, and Untouchable Shadow resets E at the same boundary.
      if (state.wReadyAt > state.rUntil) {
        state.wReadyAt = state.rUntil + (state.wReadyAt - state.rUntil) * 0.2;
      }
      state.eReadyAt = state.rUntil;
      state.rExitHandled = true;
    };

    const attack = (time: number) => {
      if (time > input.durationSeconds) return false;
      drainDamageThrough(time);
      if (isDead()) return false;
      applyRExitEffects(time);
      expireTimedItemStates(time);
      advanceStormrazorMovement(time);
      const attackHadFiendhunter = fiendhunterActiveAt(time);
      const attackTerminusMode = terminus ? state.terminusNextMode : null;
      const targetHealthBeforeAttack = Math.max(0, state.targetHealth);
      if (hasYunTal && time >= state.flurryReadyAt - EPSILON) {
        state.flurryUntil = time + YUN_TAL_FLURRY_DURATION_SECONDS;
        state.flurryReadyAt = time + YUN_TAL_FLURRY_COOLDOWN_SECONDS;
        state.flurryActivations += 1;
      }
      const attackCritChance = yunTalCritChance();
      state.attacks += 1;

      if (stormrazor && state.stormrazorStacks >= stormrazor.maxStacks - EPSILON) {
        state.stormrazorStacks = 0;
        state.stormrazorProcs += 1;
        add(
          time,
          "Stormrazor — Bolt",
          "magic",
          stormrazor.procDamage,
          [
            "Energized attack; 100 bonus magic damage",
            `+${Math.round(stormrazor.bonusMovementSpeed * 100)}% movement speed for ${stormrazor.bonusMovementDuration}s`,
          ],
          { attack: true },
        );
      }

      if (bladeOfTheRuinedKing) {
        add(
          time,
          "Blade of the Ruined King — Mist's Edge",
          "physical",
          targetHealthBeforeAttack * bladeOfTheRuinedKing.rangedCurrentHealthPercent,
          [
            `${round(bladeOfTheRuinedKing.rangedCurrentHealthPercent * 100, 1)}% ranged current-health on-hit`,
            "Current health is captured before this attack",
          ],
          { attack: true },
        );
      }

      if (terminus) {
        const bonusAd = items.attackDamage;
        add(
          time,
          "Terminus — Shadow",
          "magic",
          terminus.onHitBaseDamage +
            terminus.onHitBonusAdRatio * bonusAd +
            terminus.onHitApRatio * abilityPower,
          [
            "30 + 10% bonus AD + 10% AP magic on-hit",
            `${attackTerminusMode === "dark" ? "Dark" : "Light"} attack`,
          ],
          { attack: true },
        );
      }

      if (hasKraken && state.attacks % 3 === 0) {
        const missingFraction = Math.max(
          0,
          Math.min(1, 1 - targetHealthBeforeAttack / Math.max(1, input.target.health)),
        );
        const missingHealthAmp = 1 + 0.75 * missingFraction;
        add(
          time,
          "Kraken Slayer — Bring It Down",
          "physical",
          krakenBaseDamage(input.level) * missingHealthAmp,
          [
            `Every third attack; missing-health amp ×${round(missingHealthAmp, 3)}`,
            "80% ranged modifier",
          ],
          { attack: true },
        );
      }

      const normalCritMultiplier = attackHadFiendhunter
        ? critDamage * fiendhunter!.critModifier
        : critDamage;
      const expectedPhysical = attackHadFiendhunter
        ? totalAd *
          normalCritMultiplier *
          (1 + attackCritChance * (critDamage / normalCritMultiplier - 1))
        : totalAd * (1 + attackCritChance * (critDamage - 1));
      add(
        time,
        "Basic attack",
        "physical",
        expectedPhysical,
        [
          attackHadFiendhunter
            ? `${Math.round(attackCritChance * 100)}% natural crit chance; Opening Barrage uses ${Math.round(fiendhunter!.critModifier * 100)}% crit damage on non-natural crits`
            : `${Math.round(attackCritChance * 100)}% expected crit at ${Math.round(critDamage * 100)}%`,
          ...(hasYunTal
            ? [
                `Yun Tal stacks ${state.yunTalStacks}/${YUN_TAL_MAX_STACKS}`,
                ...(time < state.flurryUntil ? ["Flurry +30% bonus AS active"] : []),
              ]
            : []),
          ...(attackHadFiendhunter ? ["Fiendhunter Opening Barrage active"] : []),
        ],
        { attack: true },
      );

      // Vow follows the same expected critical damage that the attack delivered.
      const expectedCriticalDamage = attackHadFiendhunter
        ? totalAd *
          normalCritMultiplier *
          (1 + attackCritChance * (critDamage / normalCritMultiplier - 1))
        : attackCritChance * totalAd * critDamage;
      add(
        time,
        "Vow of the First Lands",
        "magic",
        expectedCriticalDamage * 0.1,
        ["10% of expected critical-strike pre-mitigation damage"],
        { attack: true },
      );
      if (attackHadFiendhunter) {
        add(
          time,
          "Fiendhunter Bolts — Opening Barrage",
          "true",
          attackCritChance * totalAd * fiendhunter!.bonusTrueDamage,
          [
            `${Math.round(attackCritChance * 100)}% natural-crit substitution; ${Math.round(fiendhunter!.bonusTrueDamage * 100)}% bonus true damage`,
          ],
          { attack: true },
        );
      }
      add(
        time,
        "Cultivation of Spirit — passive",
        "magic",
        qMagicOnHit(input.ranks.q, abilityPower),
        ["Passive on-hit; 5–25 + 20% AP"],
        { attack: true },
      );
      if (time < state.qUntil) {
        add(
          time,
          "Cultivation of Spirit — active",
          "magic",
          qMagicOnHit(input.ranks.q, abilityPower),
          ["Active adds the same magic on-hit; secondary spread excluded"],
          { attack: true },
        );
      }

      if (terminus) {
        if (attackTerminusMode === "light") {
          state.terminusLightStacks = Math.min(
            terminus.maxLightStacks,
            state.terminusLightStacks + 1,
          );
          state.terminusLightUntil = time + terminus.buffDuration;
        } else {
          state.terminusDarkStacks = Math.min(terminus.maxDarkStacks, state.terminusDarkStacks + 1);
          state.terminusDarkUntil = time + terminus.buffDuration;
        }
        state.terminusNextMode = attackTerminusMode === "light" ? "dark" : "light";
      }
      if (stormrazor) {
        state.stormrazorStacks = Math.min(
          stormrazor.maxStacks,
          state.stormrazorStacks + stormrazor.attackStacks,
        );
      }
      if (hasYunTal) {
        state.yunTalStacks = Math.min(YUN_TAL_MAX_STACKS, state.yunTalStacks + 1);
        if (state.flurryReadyAt > time) {
          state.flurryReadyAt = Math.max(time, state.flurryReadyAt - (1 + attackCritChance));
        }
      }
      // The current attack's temporary attack-speed modifiers affect the next readiness time.
      state.nextAttackReady = time + 1 / attackSpeedAt(time);
      if (attackHadFiendhunter) state.fiendhunterAttacks -= 1;
      return true;
    };

    let cursor = 0;
    for (const action of input.actions) {
      drainDamageThrough(cursor);
      if (cursor > input.durationSeconds || isDead()) break;
      applyRExitEffects(cursor);
      if (action === "R") {
        if (input.ranks.r <= 0) continue;
        const castTime = Math.max(cursor, state.rReadyAt);
        drainDamageThrough(castTime);
        if (isDead()) break;
        if (castTime > input.durationSeconds) break;
        applyRExitEffects(castTime);
        state.rUntil = castTime + R_DURATION_SECONDS;
        state.rExitHandled = false;
        state.qUntil = Math.max(state.qUntil, state.rUntil);
        if (state.wReadyAt > castTime) {
          state.wReadyAt = castTime + (state.wReadyAt - castTime) * 0.2;
        }
        state.eReadyAt = castTime;
        activateFiendhunter(castTime);
        state.rReadyAt =
          castTime + cooldownWithHaste(rCooldownBase(), abilityHaste + ultimateAbilityHaste);
        cursor = castTime + ABILITY_CAST_SECONDS.R;
      } else if (action === "Q") {
        if (input.ranks.q <= 0) continue;
        state.qUntil = Math.max(state.qUntil, cursor + Q_DURATION_SECONDS);
        cursor += ABILITY_CAST_SECONDS.Q;
      } else if (action === "W") {
        if (input.ranks.w <= 0) continue;
        const castTime = Math.max(cursor, state.wReadyAt);
        drainDamageThrough(castTime);
        if (isDead()) break;
        if (castTime > input.durationSeconds) break;
        applyRExitEffects(castTime);
        if (castTime < state.rUntil) {
          const base = [0, 160, 320, 480][input.ranks.r]!;
          add(
            castTime,
            "Arc of Ruin",
            "magic",
            base + 1.2 * (totalAd - BASE_AD - growthAtLevel(AD_GROWTH, input.level)),
            ["R-enhanced W; 120% bonus AD"],
          );
        } else {
          const base = [0, 55, 95, 135, 175, 215][input.ranks.w]!;
          const hit = base + 0.85 * (totalAd - BASE_AD - growthAtLevel(AD_GROWTH, input.level));
          add(castTime, "Arc of Judgment", "magic", hit, ["Initial hit; 85% bonus AD"]);
          pendingDamage.push([
            castTime + 1,
            "Arc of Judgment — linger",
            "magic",
            hit * 0.6,
            ["One representative 60% lingering tick"],
          ]);
        }
        state.wReadyAt = castTime + cooldownWithHaste(ABILITY_COOLDOWN_SECONDS.W);
        cursor = castTime + ABILITY_CAST_SECONDS.W;
      } else if (action === "E") {
        const castTime = Math.max(cursor, state.eReadyAt);
        drainDamageThrough(castTime);
        if (isDead()) break;
        if (castTime > input.durationSeconds) break;
        applyRExitEffects(castTime);
        state.eReadyAt = castTime + cooldownWithHaste(ABILITY_COOLDOWN_SECONDS.E);
        cursor = castTime + ABILITY_CAST_SECONDS.E;
      } else {
        const attackTime = Math.max(cursor, state.nextAttackReady);
        if (attack(attackTime)) cursor = attackTime + SCRIPTED_ATTACK_LOCK_SECONDS;
      }
    }

    if (input.continueAutos && !isDead()) {
      let next = Math.max(cursor, state.nextAttackReady);
      while (next <= input.durationSeconds + 1e-9 && !isDead()) {
        attack(next);
        next = state.nextAttackReady;
      }
    }
    drainDamageThrough(input.durationSeconds);
    advanceStormrazorMovement(input.durationSeconds);

    const ttk = firstKillTime;
    const overkill = overkillTotal;
    const outputSplit = Object.fromEntries(
      Object.entries(split).map(([key, value]) => [key, round(value)]),
    ) as Record<DamageType, number>;
    // Keep the headline and the displayed damage-type split exactly
    // reconciled even though each displayed bucket is rounded independently.
    const totalDamage = round(Object.values(outputSplit).reduce((sum, value) => sum + value, 0));
    const initialQ =
      input.actions[0] === "Q" || input.actions[0] === "R" ? qAttackSpeed(input.ranks.q) : 0;
    const killed = targetMode === "mortal" && state.targetHealth <= EPSILON;
    const yunTalCritChanceStart = hasYunTal
      ? Math.min(1, items.critChance + yunTalStacksStart * YUN_TAL_CRIT_PER_STACK)
      : Math.min(1, items.critChance);
    const yunTalCritChanceEnd = yunTalCritChance();
    return {
      build: input.build.name,
      totalDamage: round(totalDamage),
      dps: round(totalDamage / input.durationSeconds),
      ttk,
      split: outputSplit,
      sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, round(v)])),
      events,
      killed,
      censored: targetMode === "mortal" && !killed,
      overkill: round(overkill),
      targetMode,
      warnings,
      stats: {
        attackDamage: round(totalAd),
        attackSpeed: round(
          Math.min(
            2.5,
            BASE_AS * (1 + growthAtLevel(AS_GROWTH, input.level) + items.attackSpeed + initialQ),
          ),
          2,
        ),
        critChance: yunTalCritChanceStart,
        abilityHaste: round(abilityHaste),
        ultimateAbilityHaste: round(ultimateAbilityHaste),
        critDamage,
        armorPenPercent: items.armorPenPercent,
        yunTalStacksStart,
        yunTalStacksEnd: state.yunTalStacks,
        yunTalCritChanceStart,
        yunTalCritChanceEnd,
        flurryActivations: state.flurryActivations,
        fiendhunterAttacksStart: 0,
        fiendhunterAttacksEnd: state.fiendhunterAttacks,
        stormrazorStacksStart,
        stormrazorStacksEnd: round(state.stormrazorStacks),
        stormrazorProcs: state.stormrazorProcs,
        terminusLightStacksEnd: state.terminusLightStacks,
        terminusDarkStacksEnd: state.terminusDarkStacks,
      },
    };
  },
};

function clampYunTalStacks(value: number | undefined): number {
  return Math.max(0, Math.min(YUN_TAL_MAX_STACKS, Math.round(Number(value ?? 0))));
}

function clampStormrazorStacks(value: number | undefined): number {
  return Math.max(0, Math.min(STORMRAZOR_MAX_ENERGIZE, finiteOr(value, 0)));
}

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

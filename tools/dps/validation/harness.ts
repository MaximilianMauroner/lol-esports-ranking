import { TraceSchema, type Trace } from "../../../src/domains/dps/contracts/index.ts";
import { z } from "zod";

const effectKind = z.enum(["damage", "heal", "shield", "resource", "buff", "lifecycle"]);
const numericKind = z.enum(["damage", "heal", "shield", "resource"]);

export const TraceExpectationsSchema = z
  .object({
    eventOrder: z.array(z.string().min(1)).min(2).optional(),
    numeric: z
      .array(
        z
          .object({
            eventId: z.string().min(1),
            effectIndex: z.number().int().nonnegative(),
            kind: numericKind,
            expected: z.number().finite(),
            absoluteTolerance: z.number().finite().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .optional(),
    effectCounts: z
      .array(
        z
          .object({
            eventId: z.string().min(1),
            kind: effectKind,
            expected: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .optional(),
  })
  .strict()
  .refine(
    (value) => value.eventOrder || value.numeric || value.effectCounts,
    "At least one trace assertion is required",
  );

export type TraceExpectations = z.infer<typeof TraceExpectationsSchema>;

/** Assertions consume only public P01 traces and address exact events and effects. */
export function assertMechanicTrace(value: unknown, expected: TraceExpectations): Trace {
  const assertions = TraceExpectationsSchema.parse(expected);
  const trace = TraceSchema.parse(value);
  if (trace.truncated && (assertions.numeric || assertions.effectCounts))
    throw new Error("Numeric and count assertions require a complete trace");
  const positions = new Map(trace.events.map((event, index) => [event.eventId, index]));

  for (let index = 1; index < (assertions.eventOrder?.length ?? 0); index += 1) {
    const before = assertions.eventOrder![index - 1]!;
    const after = assertions.eventOrder![index]!;
    if (positions.get(before) === undefined || positions.get(after) === undefined)
      throw new Error(`Missing expected event in order assertion: ${before}, ${after}`);
    if (positions.get(before)! >= positions.get(after)!)
      throw new Error(`Event order violation: ${before} must precede ${after}`);
  }

  for (const assertion of assertions.numeric ?? []) {
    const event = trace.events.find((entry) => entry.eventId === assertion.eventId);
    const effect = event?.effects[assertion.effectIndex];
    if (!effect || effect.kind !== assertion.kind || !("amount" in effect || "delta" in effect))
      throw new Error(
        `Missing ${assertion.kind} effect ${assertion.effectIndex} in ${assertion.eventId}`,
      );
    const actual = effect.kind === "resource" ? effect.delta : effect.amount;
    if (Math.abs(actual - assertion.expected) > assertion.absoluteTolerance)
      throw new Error(
        `${assertion.kind} in ${assertion.eventId}: expected ${assertion.expected} ± ${assertion.absoluteTolerance}, got ${actual}`,
      );
  }

  for (const assertion of assertions.effectCounts ?? []) {
    const event = trace.events.find((entry) => entry.eventId === assertion.eventId);
    if (!event) throw new Error(`Missing expected event ${assertion.eventId}`);
    const actual = event.effects.filter((effect) => effect.kind === assertion.kind).length;
    if (actual !== assertion.expected)
      throw new Error(
        `Effect count for ${assertion.kind} in ${assertion.eventId}: expected ${assertion.expected}, got ${actual}`,
      );
  }
  return trace;
}

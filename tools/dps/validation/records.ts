import { z } from "zod";
import { ContentHashSchema } from "../../../src/domains/dps/contracts/index.ts";

const id = z.string().min(1);
const source = z
  .object({
    sourceId: id,
    contentHash: ContentHashSchema,
    locator: id,
    category: z.literal("client-capture"),
  })
  .strict();

const protocol = z
  .object({
    patch: id,
    clientVersion: id,
    hotfixId: id,
    modeId: id,
    championId: id,
    itemIds: z.array(id),
    initialState: z.record(z.string(), z.number().finite()),
    actionTimelineMs: z
      .array(z.number().int().nonnegative())
      .min(1)
      .refine(
        (times) => times.every((time, index) => index === 0 || time >= times[index - 1]!),
        "action timeline must be chronological",
      ),
    targetStats: z.record(z.string(), z.number().finite()),
    repetitions: z.number().int().positive(),
  })
  .strict();

const common = z
  .object({
    fixtureId: id,
    mechanicId: id,
    expectedTracePath: id,
    discrepancy: z.enum([
      "none",
      "input",
      "source-version",
      "timing-rounding",
      "implementation",
      "unobserved",
    ]),
  })
  .strict();

export const ValidationRecordSchema = z.discriminatedUnion("evidenceKind", [
  common.extend({ evidenceKind: z.literal("synthetic"), purpose: id }).strict(),
  common
    .extend({
      evidenceKind: z.literal("legacy"),
      baselineCommit: z.string().regex(/^[0-9a-f]{40}$/),
      knownLimit: id,
    })
    .strict(),
  common
    .extend({
      evidenceKind: z.literal("observed"),
      observationId: id,
      source,
      protocol,
      observedPatch: id,
      reviewerId: id,
      mechanicAuthorId: id,
      disputed: z.boolean(),
    })
    .strict()
    .superRefine((record, context) => {
      if (record.observedPatch !== record.protocol.patch)
        context.addIssue({
          code: "custom",
          path: ["observedPatch"],
          message: "observation patch must match protocol patch",
        });
      if (record.disputed && record.reviewerId === record.mechanicAuthorId)
        context.addIssue({
          code: "custom",
          path: ["reviewerId"],
          message: "disputed mechanics require an independent reviewer",
        });
    }),
]);

export type ValidationRecord = z.infer<typeof ValidationRecordSchema>;

export function assertObservationForPatch(
  record: ValidationRecord,
  patch: string,
  clientVersion: string,
  hotfixId: string,
): void {
  if (record.evidenceKind !== "observed")
    throw new Error("Only observed records can validate a mechanic");
  if (
    record.protocol.patch !== patch ||
    record.protocol.clientVersion !== clientVersion ||
    record.protocol.hotfixId !== hotfixId
  )
    throw new Error("Observation client, patch, or hotfix does not match the ruleset");
}

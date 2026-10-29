/** Build-slot state helpers used by the level-driven UI. Empty slots are zeroes. */
export type BuildSlots = Array<number | 0>;

/**
 * Apply a newly observed level default only to builds the user has not edited.
 * Copies every returned array so React state cannot accidentally share mutable slots.
 */
export function refreshUntouchedBuildDefaults(
  currentA: BuildSlots,
  currentB: BuildSlots,
  recommended: BuildSlots,
  editedA: boolean,
  editedB: boolean,
): { a: BuildSlots; b: BuildSlots } {
  return {
    a: editedA ? [...currentA] : [...recommended],
    b: editedB ? [...currentB] : [...recommended],
  };
}

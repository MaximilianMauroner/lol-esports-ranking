/**
 * Orders strings by UTF-16 code units, the same order as `Array.prototype.sort()`.
 * Published artifacts, state, and hashes use this order so that they do not
 * depend on ICU collation data or the process locale. Display sorting in views
 * may still use `localeCompare`.
 */
export function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

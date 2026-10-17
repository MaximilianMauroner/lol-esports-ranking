/**
 * A winner whose pre-match chance was below this share counts as an upset.
 * The match ledger and the team drawer both read it, so a result is called an
 * upset in one place exactly when it is called one in the other.
 */
export const UPSET_CHANCE = 0.35

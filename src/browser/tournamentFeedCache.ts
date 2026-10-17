import { isTournamentFeed, type TournamentFeed } from '../lib/tournamentFeed'

const FEED_CACHE_KEY = 'tournament-feed'

/** The last valid feed, so a return visit shows the schedule while the fresh copy loads. The version check drops a cached feed of an older shape. */
export function readCachedTournamentFeed(): TournamentFeed | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(FEED_CACHE_KEY) ?? 'null')
    return isTournamentFeed(value) ? value : null
  } catch {
    return null
  }
}

export function cacheTournamentFeed(feed: TournamentFeed) {
  try {
    localStorage.setItem(FEED_CACHE_KEY, JSON.stringify(feed))
  } catch {
    // Storage is full or blocked. The next visit loads the feed as usual.
  }
}

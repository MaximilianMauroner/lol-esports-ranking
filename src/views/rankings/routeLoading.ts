import { lazy } from 'react'
import { type Mode } from '../shellConfig'
import { loadTournamentsView } from '../tournaments/routeLoading'

const loadRegionsView = () => import('../regions/RegionsView').then((module) => ({ default: module.RegionsView }))

const loadMatchesView = () => import('../matches/MatchesView').then((module) => ({ default: module.MatchesView }))

const loadPlayersView = () => import('./PlayersView').then((module) => ({ default: module.PlayersView }))

const loadProfilesView = () => import('../style/StyleProfileRoute').then((module) => ({ default: module.StyleProfileRoute }))

const loadCompareAnalysis = () => import('./CompareAnalysis')

export const RegionsView = lazy(loadRegionsView)

export const MatchesView = lazy(loadMatchesView)

export const PlayersView = lazy(loadPlayersView)

export const StyleProfileRoute = lazy(loadProfilesView)

export const RegionCompareAnalysis = lazy(() => loadCompareAnalysis().then((module) => ({ default: module.RegionCompareAnalysis })))

export const TeamCompareAnalysis = lazy(() => loadCompareAnalysis().then((module) => ({ default: module.TeamCompareAnalysis })))

const VIEW_LOADERS = {
  rankings: undefined,
  players: loadPlayersView,
  profiles: loadProfilesView,
  regions: loadRegionsView,
  matches: loadMatchesView,
  tournaments: loadTournamentsView,
}

export function preloadView(mode: Mode) {
  const load = VIEW_LOADERS[mode]
  if (load) void load().catch(() => { /* Navigation can retry a failed preload. */ })
}

export function preloadComparison() {
  void loadCompareAnalysis().catch(() => { /* Opening the drawer retries. */ })
}

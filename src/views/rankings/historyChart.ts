import { lazy } from 'react'

export const loadTeamHistoryLineChart = () => import('./TeamHistoryLineChart').then((module) => ({ default: module.TeamHistoryLineChart }))

export const LazyTeamHistoryLineChart = lazy(loadTeamHistoryLineChart)

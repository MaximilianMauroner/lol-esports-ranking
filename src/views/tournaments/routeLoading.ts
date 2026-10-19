import { lazy } from 'react'

export const loadTournamentsView = () => import('./TournamentsView').then((module) => ({ default: module.TournamentsView }))

export const TournamentsView = lazy(loadTournamentsView)

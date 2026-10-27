import type { CanonicalSeries } from '../evidence/seriesResolver.ts'
import { gameNumberFor } from '../evidence/seriesResolver.ts'
import { homeLeagueForMatch } from '../evidence/matchContext.ts'
import type { MatchRecord, MatchRosterSnapshot, TeamProfile } from '../../types.ts'
import type { FinalSideRetention, PregamePlayerRatingEdge } from '../players/playerModel.ts'
import { eventKFactorForMatch, eventWeightForMatch } from './eventWeighting.ts'
import { isInternationalMatch } from './ratingCalculations.ts'
import type { RatingRunState } from './ratingRunState.ts'
import { sideAdjustmentFor } from './sideAdjustments.ts'
import type { SeriesResultInput, SeriesResultUpdate } from './seriesResultUpdate.ts'
import {
  seriesPassTeamMaps, seriesPassLeagueMaps,
  type Pair, type SeriesPassCapture, type SeriesPassFrame, type SeriesPassLeague, type SeriesPassMemberTrail,
  type SeriesPassRoster, type SeriesPassSamples, type SeriesPassSideCalculation, type SeriesPassSideTrail,
  type SeriesPassSource, type SeriesPassSeriesTrail, type SeriesPassTeamBefore,
} from './seriesPass.ts'

export type SeriesPassGroup = Readonly<{
  key: string
  matches: readonly MatchRecord[]
  finalMatch: MatchRecord
  teamA: string
  teamB: string
  winsA: number
  winsB: number
  bestOf: CanonicalSeries['format']
  state: CanonicalSeries['state']
  observedOutcomeA: number
}>

function roster(value: MatchRosterSnapshot | undefined): SeriesPassRoster | null {
  return value ? { completeness: value.completeness, players: value.players.map(({ role, id }) => ({ role, id })) } : null
}

function teamBefore(team: string, state: RatingRunState): SeriesPassTeamBefore {
  return {
    team,
    rating: state.ratings.get(team) ?? null,
    executionRating: state.executionRatings.get(team) ?? null,
    uncertainty: state.uncertainties.get(team) ?? null,
    momentum: state.momentums.get(team) ?? null,
    rosterPriorOffset: state.rosterPriorOffsets.get(team) ?? null,
    rosterContinuity: state.currentRosterContinuity.get(team) ?? null,
    previousDisplayRating: state.previousDisplayRatings.get(team) ?? null,
    wins: state.wins.get(team) ?? null,
    losses: state.losses.get(team) ?? null,
    form: state.forms.get(team) ?? null,
    factors: state.factorSums.get(team) ?? null,
    factorCount: state.factorCounts.get(team) ?? null,
    lastRoster: roster(state.lastRosterByTeam.get(team)),
    lastPatch: state.lastPatchByTeam.get(team) ?? null,
    lastRosterFingerprint: state.lastRosterFingerprintByTeam.get(team) ?? null,
    hasLatestRatingUpdate: state.latestRatingUpdates.has(team),
  }
}

function leagueState(league: string, state: RatingRunState): SeriesPassLeague {
  return {
    league,
    score: state.leagueScores.get(league) ?? null,
    previousScore: state.previousLeagueScores.get(league) ?? null,
    wins: state.leagueWins.get(league) ?? null,
    losses: state.leagueLosses.get(league) ?? null,
    expectedWins: state.leagueExpectedWins.get(league) ?? null,
    opponentRatingSum: state.leagueOpponentRatingSums.get(league) ?? null,
    matchCount: state.leagueMatchCounts.get(league) ?? null,
    form: state.leagueForms.get(league) ?? null,
    lastEvent: state.leagueLastEvents.get(league) ?? null,
    lastUpdated: state.leagueLastUpdated.get(league) ?? null,
  }
}

function detached<T>(value: T): T {
  const copy = structuredClone(value)
  const freeze = (value: unknown) => {
    if (value === null || typeof value !== 'object') return
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  freeze(copy)
  return copy
}

/** Observes the production pass. No expected numeric value is calculated here. */
export class SeriesPassRecorder {
  private readonly frame: SeriesPassFrame
  private readonly groups: readonly SeriesPassGroup[]
  private readonly state: RatingRunState
  private readonly teamIndexes: Map<string, number>
  private readonly leagueIndexes: Map<string, number>
  private readonly keysBefore: Map<string, Set<string>>
  private readonly rosterSources = new Map<string, SeriesPassSource>()
  private readonly updateSources = new Map<string, SeriesPassSource>()
  private readonly trails: Array<Omit<SeriesPassSeriesTrail, 'members'> & { members: SeriesPassMemberTrail[] }> = []

  constructor({ groups, matches, profiles, state, lastDate, sideAdjustments, playerEdges, retentions }: {
    groups: readonly SeriesPassGroup[]
    matches: readonly MatchRecord[]
    profiles: Record<string, TeamProfile>
    state: RatingRunState
    lastDate: string
    sideAdjustments: Map<string, number>
    playerEdges: Map<string, PregamePlayerRatingEdge>
    retentions: readonly (FinalSideRetention | undefined)[]
  }) {
    this.groups = groups
    this.state = state
    const teamNames = [...new Set(groups.flatMap((group) => [group.teamA, group.teamB, ...group.matches.flatMap((match) => [match.teamA, match.teamB])]))]
    const leagueNames = [...new Set(groups.flatMap((group) => group.matches.flatMap((match) => [
      homeLeagueForMatch(match, 'A', profiles), homeLeagueForMatch(match, 'B', profiles),
    ])))]
    this.teamIndexes = new Map(teamNames.map((team, index) => [team, index]))
    this.leagueIndexes = new Map(leagueNames.map((league, index) => [league, index]))
    this.keysBefore = new Map([...Object.keys(seriesPassTeamMaps), ...Object.keys(seriesPassLeagueMaps)].map((name) => [
      name, new Set(state[name as keyof typeof seriesPassTeamMaps | keyof typeof seriesPassLeagueMaps].keys()),
    ]))
    for (const team of teamNames) {
      if (state.lastRosterByTeam.has(team)) this.rosterSources.set(team, 'prior')
      if (state.latestRatingUpdates.has(team)) this.updateSources.set(team, 'prior')
    }
    const side = (match: MatchRecord, position: 'A' | 'B') => {
      const team = position === 'A' ? match.teamA : match.teamB
      const league = homeLeagueForMatch(match, position, profiles)
      const edge = playerEdges.get(match.id)
      return {
        team: this.teamIndexes.get(team)!, league: this.leagueIndexes.get(league)!,
        region: (position === 'A' ? match.teamARegion : match.teamBRegion) ?? profiles[team]?.region ?? match.region,
        colour: (position === 'A' ? match.teamASide : match.teamBSide) ?? null,
        sideAdjustment: sideAdjustmentFor(match, position, sideAdjustments),
        playerAdjustment: (position === 'A' ? edge?.teamAAdjustment : edge?.teamBAdjustment) ?? null,
        roster: roster(position === 'A' ? match.teamARoster : match.teamBRoster),
        kills: position === 'A' ? match.teamAKills : match.teamBKills,
        gold: position === 'A' ? match.teamAGold : match.teamBGold,
        towers: (position === 'A' ? match.teamATowers : match.teamBTowers) ?? null,
        dragons: (position === 'A' ? match.teamADragons : match.teamBDragons) ?? null,
        barons: (position === 'A' ? match.teamABarons : match.teamBBarons) ?? null,
      }
    }
    this.frame = detached({
      utcDate: matches[0].date, lastDate,
      authoritativeMatchIds: matches.map((match) => match.officialGameId ?? match.sourceGameId ?? match.id).sort(),
      teams: teamNames.map((team) => teamBefore(team, state)), leagues: leagueNames.map((league) => leagueState(league, state)),
      sideSamples: [...state.sideAdjustmentSamples], processedMatchCount: state.processedMatchCount,
      series: groups.map((group, index) => {
        const final = group.finalMatch
        const leagueFor = (team: string) => homeLeagueForMatch(final, final.teamA === team ? 'A' : 'B', profiles)
        const retention = retentions[index]
        return {
          seriesId: group.key, teams: [this.teamIndexes.get(group.teamA)!, this.teamIndexes.get(group.teamB)!],
          leagues: [this.leagueIndexes.get(leagueFor(group.teamA))!, this.leagueIndexes.get(leagueFor(group.teamB))!],
          bestOf: group.bestOf, wins: [group.winsA, group.winsB],
          members: group.matches.map((match) => ({
            matchId: match.officialGameId ?? match.sourceGameId ?? match.id, id: match.id,
            ordering: { datetimeUtc: match.datetimeUtc ?? null, gameNumber: gameNumberFor(match),
              officialGameId: match.officialGameId ?? null, sourceGameId: match.sourceGameId ?? null },
            sides: [side(match, 'A'), side(match, 'B')], winner: match.winner === match.teamA ? 0 : 1,
            international: isInternationalMatch(match), eventK: eventKFactorForMatch(match, state.eventWeightContext),
            eventWeight: eventWeightForMatch(match, state.eventWeightContext), patch: match.patch, event: match.event, tier: match.tier,
          })),
          ...(retention && (retention.teamA !== 'baseline-contraction' || retention.teamB !== 'baseline-contraction')
            ? { continuityRetention: [retention.teamA, retention.teamB] as const } : {}),
        }
      }),
    })
  }

  recordSeries(seriesIndex: number, input: SeriesResultInput, result: SeriesResultUpdate) {
    const group = this.groups[seriesIndex]
    const continuity = (team: string) => {
      const before = teamBefore(team, this.state)
      return { rosterContinuity: before.rosterContinuity, rating: before.rating, executionRating: before.executionRating, uncertainty: before.uncertainty }
    }
    this.trails.push({ ...detached({
      state: group.state, outcomeA: group.observedOutcomeA,
      continuity: [continuity(group.finalMatch.teamA), continuity(group.finalMatch.teamB)],
      input: {
        currentPowerRating: [input.teams[0].currentPowerRating, input.teams[1].currentPowerRating],
        uncertainty: [input.teams[0].uncertainty, input.teams[1].uncertainty],
        rosterContinuity: [input.teams[0].rosterContinuity ?? null, input.teams[1].rosterContinuity ?? null],
        observedOutcome: [input.observedOutcomeA, input.observedOutcomeB], strengthSignal: input.strengthSignal,
        eventK: input.eventK, international: input.international,
      },
      result,
    }), members: [] })
  }

  recordMember(seriesIndex: number, memberIndex: number, observation: Readonly<{
    seriesFinal: boolean
    gameK: number
    recency: number
    sides: Pair<SeriesPassSideCalculation>
    leagueHistoryStart: number
    sideSamples: SeriesPassSamples
  }>) {
    const match = this.groups[seriesIndex].matches[memberIndex]
    const state = this.state
    const side = (position: 0 | 1): SeriesPassSideTrail => {
      const team = position === 0 ? match.teamA : match.teamB
      const observedRoster = position === 0 ? match.teamARoster : match.teamBRoster
      const source = { member: { series: seriesIndex, member: memberIndex, side: position } }
      if (observedRoster && observedRoster === state.lastRosterByTeam.get(team)
        && observedRoster.completeness === 'complete-five-role' && state.lastRosterFingerprintByTeam.get(team)) {
        this.rosterSources.set(team, source)
      }
      this.updateSources.set(team, source)
      const history = state.histories.get(team)?.at(-1)
      const update = state.latestRatingUpdates.get(team)
      if (!history || !update) throw new Error('Missing observed member history or ledger')
      const before = teamBefore(team, state)
      return {
        ...observation.sides[position],
        executionRating: before.executionRating, rating: before.rating, previousDisplayRating: before.previousDisplayRating,
        rosterPriorOffset: before.rosterPriorOffset, uncertainty: before.uncertainty, momentum: before.momentum,
        history: { rating: history.rating, baseRating: history.baseRating!, leagueAdjustment: history.leagueAdjustment!,
          sideAdjustment: history.sideAdjustment!, delta: history.delta, result: history.result },
        latestRatingUpdate: update, factorSums: before.factors, factorCount: before.factorCount,
        wins: before.wins, losses: before.losses, form: before.form,
        lastPatch: before.lastPatch, lastRoster: this.rosterSources.get(team) ?? null, lastRosterFingerprint: before.lastRosterFingerprint,
        league: leagueState(this.frame.leagues[this.frame.series[seriesIndex].members[memberIndex].sides[position].league].league, state),
      }
    }
    this.trails[seriesIndex].members.push(detached({
      seriesFinal: observation.seriesFinal, gameK: observation.gameK, recency: observation.recency,
      sides: [side(0), side(1)],
      leagueHistory: state.leagueHistory.slice(observation.leagueHistoryStart).map((point) => ({
        ...point, expectedWins: point.expectedWins ?? null, winsOverExpected: point.winsOverExpected ?? null,
        opponentAdjustedWinRate: point.opponentAdjustedWinRate ?? null, averageOpponentRating: point.averageOpponentRating ?? null,
      })),
      sideSamples: observation.sideSamples, processedMatchCount: state.processedMatchCount,
    }))
  }

  finish(): SeriesPassCapture {
    const state = this.state
    const inserted = <K extends keyof typeof seriesPassTeamMaps | keyof typeof seriesPassLeagueMaps>(name: K, indexes: Map<string, number>) =>
      [...state[name].keys()].filter((key) => !this.keysBefore.get(name)!.has(key)).map((key) => {
        const index = indexes.get(key)
        if (index === undefined) throw new Error(`Unexpected affected key ${key}`)
        return index
      })
    return detached({
      frame: this.frame,
      expected: {
        utcDate: this.frame.utcDate, series: this.trails,
        teams: this.frame.teams.map(({ team }) => {
          const { hasLatestRatingUpdate, ...values } = teamBefore(team, state)
          return { ...values, lastRoster: this.rosterSources.get(team) ?? null,
            latestRatingUpdate: hasLatestRatingUpdate ? this.updateSources.get(team) ?? null : null }
        }),
        leagues: this.frame.leagues.map(({ league }) => leagueState(league, state)),
        sideSamples: [...state.sideAdjustmentSamples],
        inserted: {
          teams: {
            ratings: inserted('ratings', this.teamIndexes), executionRatings: inserted('executionRatings', this.teamIndexes),
            uncertainties: inserted('uncertainties', this.teamIndexes), momentums: inserted('momentums', this.teamIndexes),
            rosterPriorOffsets: inserted('rosterPriorOffsets', this.teamIndexes), rosterContinuity: inserted('currentRosterContinuity', this.teamIndexes),
            previousDisplayRatings: inserted('previousDisplayRatings', this.teamIndexes),
            wins: inserted('wins', this.teamIndexes), losses: inserted('losses', this.teamIndexes), forms: inserted('forms', this.teamIndexes),
            factorSums: inserted('factorSums', this.teamIndexes), factorCounts: inserted('factorCounts', this.teamIndexes),
            lastRosters: inserted('lastRosterByTeam', this.teamIndexes), lastPatches: inserted('lastPatchByTeam', this.teamIndexes),
            lastRosterFingerprints: inserted('lastRosterFingerprintByTeam', this.teamIndexes), latestRatingUpdates: inserted('latestRatingUpdates', this.teamIndexes),
          },
          leagues: {
            scores: inserted('leagueScores', this.leagueIndexes), previousScores: inserted('previousLeagueScores', this.leagueIndexes),
            wins: inserted('leagueWins', this.leagueIndexes), losses: inserted('leagueLosses', this.leagueIndexes),
            expectedWins: inserted('leagueExpectedWins', this.leagueIndexes), opponentRatingSums: inserted('leagueOpponentRatingSums', this.leagueIndexes),
            forms: inserted('leagueForms', this.leagueIndexes), matchCounts: inserted('leagueMatchCounts', this.leagueIndexes),
            lastEvents: inserted('leagueLastEvents', this.leagueIndexes), lastUpdated: inserted('leagueLastUpdated', this.leagueIndexes),
          },
        },
        processedMatchCount: state.processedMatchCount,
      },
    })
  }
}

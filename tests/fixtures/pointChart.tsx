import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { RegionDepthChart } from '../../src/components/RegionDepthChart'
import { PowerLadder } from '../../src/views/rankings/PowerLadder'
import type { RankingSummaryStanding } from '../../src/domains/rankings/types'
import '../../src/index.css'

const team = (name: string, rank: number, rating: number) => ({ team: name, teamId: `team:${name}`, code: name.slice(0, 3).toUpperCase(), league: 'LCK', rank, rating, uncertainty: 20, wins: 3, losses: 1, form: ['W', 'L'] }) as unknown as RankingSummaryStanding

const regions = [
  { region: 'North', rank: 1, score: 1900, internationalWins: 4, internationalLosses: 2, topTeams: [
    { team: 'Aurora', code: 'AUR', rating: 2000, rank: 1 },
    { team: 'Boreal', code: 'BOR', rating: 1900, rank: 3 },
    { team: 'Cirrus', code: 'CIR', rating: 1800, rank: 5 },
  ] },
  { region: 'South', rank: 2, score: 1825, internationalWins: 2, internationalLosses: 4, topTeams: [
    { team: 'Delta', code: 'DEL', rating: 1950, rank: 2 },
    { team: 'Estuary', code: 'EST', rating: 1700, rank: 6 },
  ] },
]

createRoot(document.getElementById('root')!).render(createElement('div', { style: { display: 'grid', gap: 24, maxWidth: 760 } },
  createElement('button', null, 'Before depth'),
  createElement(RegionDepthChart, { regions }),
  createElement('button', null, 'After depth'),
  // Clips like a panel. The two-row ladder is shorter than its tooltip.
  createElement('div', { style: { width: '100%', maxWidth: 320, overflow: 'hidden' } },
    createElement(PowerLadder, {
      groups: [[team('Alpha', 1, 2000), team('Bravo', 2, 1990)]],
      tierFor: () => 'A',
      gapExample: 64,
      onOpen: (standing: RankingSummaryStanding) => {
        document.getElementById('opened')!.textContent = `Opened ${standing.team}`
      },
    })),
  createElement('p', { id: 'opened' }, 'Opened none'),
))

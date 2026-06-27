import { readFile, writeFile } from 'node:fs/promises'
import { createPlayerDirectory, createTeamHistory } from '../src/lib/snapshot'

// Regenerates the browser-loadable derived files from the existing full
// snapshot, without re-crunching raw CSVs.
const data = JSON.parse(await readFile('data/derived/ranking-snapshot.full.json', 'utf8'))

const players = createPlayerDirectory(data)
await writeFile('public/data/players.json', JSON.stringify(players) + '\n')
console.log('players.json:', players.ratedPlayerCount, 'players')

const history = createTeamHistory(data)
await writeFile('public/data/team-history.json', JSON.stringify(history) + '\n')
console.log('team-history.json:', history.teamCount, 'teams,', history.pointCount, 'points')

import assert from 'node:assert/strict'
import test from 'node:test'
import { championIconUrl, championInitials } from '../src/lib/championIcons.ts'

const icon = (version: string, id: string) => `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${id}.png`

test('maps Riot year patches and Oracle patches to Data Dragon versions', () => {
  assert.equal(championIconUrl('Ahri', '26.17'), icon('16.17.1', 'Ahri'))
  assert.equal(championIconUrl('Ahri', '26.09'), icon('16.9.1', 'Ahri'))
  assert.equal(championIconUrl('Ahri', '25.S1.3'), icon('15.3.1', 'Ahri'))
  assert.equal(championIconUrl('Ahri', '25.08'), icon('15.8.1', 'Ahri'))
  assert.equal(championIconUrl('Ahri', '16.07'), icon('16.7.1', 'Ahri'))
  assert.equal(championIconUrl('Ahri', '15.24'), icon('15.24.1', 'Ahri'))
  assert.equal(championIconUrl('Ahri', '14.18'), icon('14.18.1', 'Ahri'))
})

test('maps champion display names to Data Dragon ids', () => {
  assert.equal(championIconUrl('Wukong', '26.20'), icon('16.20.1', 'MonkeyKing'))
  assert.equal(championIconUrl("Kai'Sa", '26.20'), icon('16.20.1', 'Kaisa'))
  assert.equal(championIconUrl("K'Sante", '26.20'), icon('16.20.1', 'KSante'))
  assert.equal(championIconUrl("Kog'Maw", '26.20'), icon('16.20.1', 'KogMaw'))
  assert.equal(championIconUrl('Dr. Mundo', '26.20'), icon('16.20.1', 'DrMundo'))
  assert.equal(championIconUrl('Jarvan IV', '26.20'), icon('16.20.1', 'JarvanIV'))
  assert.equal(championIconUrl('Nunu & Willump', '26.20'), icon('16.20.1', 'Nunu'))
  assert.equal(championIconUrl('Renata Glasc', '26.20'), icon('16.20.1', 'Renata'))
  assert.equal(championIconUrl('LeBlanc', '26.20'), icon('16.20.1', 'Leblanc'))
})

test('has no icon when the patch or the name cannot identify one', () => {
  assert.equal(championIconUrl('Ahri', ''), undefined)
  assert.equal(championIconUrl('Ahri', 'unknown'), undefined)
  assert.equal(championIconUrl('Ahri', '26.0'), undefined)
  assert.equal(championIconUrl("'", '26.20'), undefined)
  assert.equal(championInitials('Jarvan IV'), 'Ja')
  assert.equal(championInitials("'"), '?')
})

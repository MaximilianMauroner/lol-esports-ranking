const DATA_DRAGON_CDN = 'https://ddragon.leagueoflegends.com/cdn'

// Data Dragon ids drop spaces and punctuation from the display name. These
// names do not follow that rule (checked against 16.20.1 champion.json).
const DATA_DRAGON_ID_EXCEPTIONS = new Map([
  ["Bel'Veth", 'Belveth'],
  ["Cho'Gath", 'Chogath'],
  ["Kai'Sa", 'Kaisa'],
  ["Kha'Zix", 'Khazix'],
  ['LeBlanc', 'Leblanc'],
  ['Nunu & Willump', 'Nunu'],
  ['Renata Glasc', 'Renata'],
  ["Vel'Koz", 'Velkoz'],
  ['Wukong', 'MonkeyKing'],
])

/** Icon URL for a champion on the game's patch, or undefined when the patch or name cannot identify one. */
export function championIconUrl(champion: string, patch: string) {
  const version = dataDragonVersion(patch)
  const id = DATA_DRAGON_ID_EXCEPTIONS.get(champion) ?? champion.replace(/[^A-Za-z0-9]/g, '')
  return version && id ? `${DATA_DRAGON_CDN}/${version}/img/champion/${id}.png` : undefined
}

export function championInitials(champion: string) {
  return champion.replace(/[^A-Za-z]/g, '').slice(0, 2) || '?'
}

// From 2025 Riot names patches by year (25.S1.3, 25.8, 26.17) while Data
// Dragon keeps counting (15.3.1, 15.8.1, 16.17.1), so year majors drop by 10.
// Older patches and Oracle's Elixir's 15.x/16.x patches already match.
function dataDragonVersion(patch: string) {
  const parsed = /^(\d+)\.(?:S\d+\.)?(\d+)/.exec(patch.trim())
  if (!parsed) return undefined
  const major = Number(parsed[1])
  const minor = Number(parsed[2])
  if (minor < 1) return undefined
  return `${major >= 25 ? major - 10 : major}.${minor}.1`
}

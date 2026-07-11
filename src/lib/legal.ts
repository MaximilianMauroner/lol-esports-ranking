export const RIOT_PROJECT_NOTICE = 'LoL Esports Power Index was created under Riot Games\' "Legal Jibber Jabber" policy using assets owned by Riot Games. Riot Games does not endorse or sponsor this project. LoL Esports Power Index isn\'t endorsed by Riot Games and doesn\'t reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.'

export const PROJECT_REPOSITORY_URL = 'https://github.com/MaximilianMauroner/lol-esports-ranking'
export const PROJECT_CONTACT_EMAIL = 'lab4code@mauroner.net'
export const PROJECT_FEEDBACK_URL = `${PROJECT_REPOSITORY_URL}/issues/new?title=${encodeURIComponent('[Feedback] ')}&body=${encodeURIComponent('Thanks for helping improve the LoL Esports Power Index.\n\nWhat did you notice?\n\nWhat did you expect instead?\n')}`

export type LegalPageName = 'legal' | 'privacy' | 'licenses'

export function legalPageFromPath(pathname: string): LegalPageName | undefined {
  const page = pathname.replace(/^\/+|\/+$/g, '')
  return page === 'legal' || page === 'privacy' || page === 'licenses' ? page : undefined
}

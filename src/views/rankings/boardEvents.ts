import type { MouseEvent } from 'react'

const TEAM_ROW_CLICK_EXCLUDED_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[contenteditable="true"]',
  '[data-row-click-exclude]',
].join(',')

export function shouldIgnoreTeamRowClick(event: MouseEvent<HTMLTableRowElement>) {
  if (event.defaultPrevented) return true
  const target = event.target
  return target instanceof Element && Boolean(target.closest(TEAM_ROW_CLICK_EXCLUDED_SELECTOR))
}

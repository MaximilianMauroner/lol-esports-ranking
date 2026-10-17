/** Wider than this, a logo is a wordmark rather than a mark. */
const MAX_MARK_ASPECT = 2
/** Share of visible pixels that must be dark grey before a logo is inverted. */
const DARK_NEUTRAL_SHARE = 0.9

/**
 * Decides how a team logo sits on the dark mark tile, from the image's natural
 * size and a downscaled RGBA sample.
 * Only a logo that is almost entirely dark grey is inverted: inverting black
 * text beside a coloured symbol would also change the symbol's colour.
 */
export function logoTreatment(width, height, rgba) {
  if (width > 0 && height > 0 && width / height > MAX_MARK_ASPECT) return 'code'

  let visible = 0
  let darkNeutral = 0
  for (let index = 0; index + 3 < rgba.length; index += 4) {
    if (rgba[index + 3] < 128) continue
    visible += 1
    const high = Math.max(rgba[index], rgba[index + 1], rgba[index + 2])
    const low = Math.min(rgba[index], rgba[index + 1], rgba[index + 2])
    if (high < 80 && high - low < 32) darkNeutral += 1
  }

  if (visible === 0) return 'code'
  return darkNeutral / visible >= DARK_NEUTRAL_SHARE ? 'invert' : 'logo'
}

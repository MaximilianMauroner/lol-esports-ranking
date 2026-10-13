/**
 * How a team logo can sit on the dark mark tile.
 *
 * - `logo`: show it as published.
 * - `invert`: a near-black monochrome logo drawn for light pages. Inverted, it
 *   reads like the white logos around it.
 * - `code`: a wordmark, which shrinks to a sliver in a near-square tile, or an
 *   image with nothing visible. The team code is clearer than either.
 */
export type LogoTreatment = 'logo' | 'invert' | 'code'

export function logoTreatment(width: number, height: number, rgba: ArrayLike<number>): LogoTreatment

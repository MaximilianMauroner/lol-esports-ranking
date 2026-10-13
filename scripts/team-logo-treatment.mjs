import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logoTreatment } from '../src/lib/teamLogo.mjs'

const run = promisify(execFile)
/** The rule was tuned on a 24 x 24 area-averaged RGBA sample. */
const SAMPLE_SIZE = 24
const MISSING_FFMPEG = 'data:team-branding needs ffmpeg and ffprobe to classify team logos. Install ffmpeg and run it again.'

/** Fails before any download when the tools that read logo pixels are missing. */
export async function requireFfmpeg() {
  try {
    await run('ffmpeg', ['-version'])
    await run('ffprobe', ['-version'])
  } catch (error) {
    throw new Error(MISSING_FFMPEG, { cause: error })
  }
}

/**
 * Reads a logo file with ffmpeg and returns its treatment. A file ffmpeg
 * cannot decode is shown as published, with a warning.
 */
export async function logoFileTreatment(path) {
  try {
    const { stdout: size } = await run('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path,
    ])
    const { stdout: sample } = await run('ffmpeg', [
      '-v', 'error', '-i', path, '-frames:v', '1',
      '-vf', `scale=${SAMPLE_SIZE}:${SAMPLE_SIZE}:flags=area`, '-pix_fmt', 'rgba', '-f', 'rawvideo', '-',
    ], { encoding: 'buffer' })
    if (sample.length !== SAMPLE_SIZE * SAMPLE_SIZE * 4) throw new Error(`ffmpeg returned ${sample.length} bytes`)
    const [width, height] = size.trim().split(',').map(Number)
    return logoTreatment(width, height, sample)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(MISSING_FFMPEG, { cause: error })
    console.warn(`Could not read ${path} with ffmpeg; showing it as published: ${error instanceof Error ? error.message : String(error)}`)
    return 'logo'
  }
}

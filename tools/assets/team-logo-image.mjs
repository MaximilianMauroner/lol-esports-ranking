import { execFile } from 'node:child_process'
import { rename, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Transparent icon-sized images cover the largest team mark at high density. */
export async function optimizeTeamLogo(path) {
  const extension = extname(path).toLowerCase()
  if (extension === '.svg') return path
  const webp = extension === '.webp'
  const output = join(dirname(path), `${basename(path, extname(path))}${webp ? '.webp' : '.png'}`)
  const temporary = `${output}.tmp${extname(output)}`
  try {
    await run('ffmpeg', [
      '-nostdin', '-v', 'error', '-threads', '1', '-filter_threads', '1', '-i', path,
      '-frames:v', '1', '-vf', "scale=w='min(128,iw)':h='min(128,ih)':force_original_aspect_ratio=decrease:flags=lanczos",
      ...(webp ? ['-c:v', 'libwebp', '-lossless', '1', '-compression_level', '6'] : ['-c:v', 'png', '-compression_level', '9', '-pred', 'mixed']),
      '-threads', '1', '-y', temporary,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 })
    await rename(temporary, output)
    if (path !== output) await rm(path)
    return output
  } finally {
    await rm(temporary, { force: true })
  }
}

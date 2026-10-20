import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { collectLeaguepediaTournamentFeed } from '../scripts/leaguepedia-tournament-feed'
import { fetchScheduleProbe } from '../scripts/lolesports-schedule-probe.mjs'
import { collectTournamentFeed } from '../scripts/tournament-feed-collector'

for (const outcome of ['successful cancellation', 'rejected cancellation', 'errored body']) {
  for (const collector of [collectLeaguepediaTournamentFeed, collectTournamentFeed, fetchScheduleProbe]) {
    test(`${collector.name} preserves its HTTP error after ${outcome}`, async () => {
      let released = false
      const fetcher: typeof fetch = async () => new Response(new ReadableStream({
        start(controller) {
          if (outcome === 'errored body') controller.error(new Error('body terminated'))
          else controller.enqueue(new TextEncoder().encode('forbidden'))
        },
        cancel() {
          released = true
          if (outcome === 'rejected cancellation') throw new Error('cancel rejected')
        },
      }), { status: 403 })
      await assert.rejects(collector({ fetcher }), {
        message: collector === collectLeaguepediaTournamentFeed
          ? 'Leaguepedia returned HTTP 403' : 'HTTP 403 from getSchedule',
      })
      assert.equal(released, outcome !== 'errored body')
    })
  }

  for (const scenario of [
    { name: 'Leaguepedia CSV', script: 'fetch-leaguepedia.mjs', flags: ['--output', 'leaguepedia.json'] },
    { name: 'LoL Esports schedule', script: 'fetch-lolesports-schedule.mjs', flags: ['--output', 'schedule.json'] },
    { name: 'Riot GPR', script: 'fetch-riot-gpr-snapshot.mjs', flags: ['--output', 'gpr.json'] },
    { name: 'Oracle CSV', script: 'download-local-data.mjs', flags: ['--oracle-csv-url', 'https://fixture.invalid/2026.csv', '--oracle-drive', 'false'] },
    { name: 'Oracle Drive discovery', script: 'download-local-data.mjs', flags: [] },
  ]) {
    test(`${scenario.name} preserves its HTTP error after ${outcome}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'provider-caller-cleanup-'))
      try {
        const flags = ['--start', '2026-01-01', '--end', '2026-12-31', '--out-dir', root,
          '--leaguepedia', 'false', '--lolesports', 'false',
          ...scenario.flags.map((value, index) => scenario.flags[index - 1] === '--output' ? join(root, value) : value)]
        const program = `
          import assert from 'node:assert/strict'
          import { readFile } from 'node:fs/promises'
          const outcome = ${JSON.stringify(outcome)}
          let released = 0
          globalThis.fetch = async () => {
            const response = new Response(new ReadableStream({
              start(controller) {
                if (outcome === 'errored body') controller.error(new Error('body terminated'))
                else controller.enqueue(new TextEncoder().encode('forbidden'))
              },
              cancel() {
                released += 1
                if (outcome === 'rejected cancellation') throw new Error('cancel rejected')
              },
            }), { status: 403 })
            response.clone = () => new Response('forbidden', { status: 403 })
            return response
          }
          process.argv = [process.execPath, ${JSON.stringify(resolve('scripts', scenario.script))}, ...${JSON.stringify(flags)}]
          const run = import(${JSON.stringify(new URL(`../scripts/${scenario.script}`, import.meta.url).href)})
          if (${JSON.stringify(scenario.script)} === 'download-local-data.mjs') {
            await run
            const manifest = JSON.parse(await readFile(${JSON.stringify(join(root, 'manifest.json'))}, 'utf8'))
            const [failure] = manifest.sources.oracle.failures
            assert.equal(failure.error, ${JSON.stringify(scenario.name === 'Oracle CSV'
              ? 'HTTP 403 from https://fixture.invalid/2026.csv' : 'HTTP 403 from Oracle Google Drive folder')})
          } else {
            await assert.rejects(run, ${scenario.name === 'Leaguepedia CSV'
              ? "{ message: 'HTTP 403 from Leaguepedia CargoExport' }" : '/HTTP 403 from https:\\/\\//'})
          }
          assert.equal(released, outcome === 'errored body' ? 0 : 1, 'Release the rejected response before the caller finishes')
        `
        await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', program], {
          timeout: 5_000,
        })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
}

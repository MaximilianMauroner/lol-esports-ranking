import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { buildParityFixtures } from './parity-fixtures'

const PARITY_FIXTURE_PATH = 'tests/fixtures/parity/contracts.json'

await mkdir(dirname(PARITY_FIXTURE_PATH), { recursive: true })
await writeFile(PARITY_FIXTURE_PATH, `${JSON.stringify(buildParityFixtures(), null, 2)}\n`)
console.log(`Wrote ${PARITY_FIXTURE_PATH}`)

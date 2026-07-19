import test from 'node:test'
import { assertReleaseData } from '../scripts/release-data-assertions.ts'

test('materialized release data satisfies current live golden claims', async () => {
  await assertReleaseData(
    process.env.RANKING_RELEASE_DATA_DIR ?? '.generated/ranking-data',
    { allowFixture: process.env.RANKING_RELEASE_DATA_ALLOW_FIXTURE === 'true' },
  )
})

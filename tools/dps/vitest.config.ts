import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/dps/**/*.test.{ts,tsx}'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
})

#!/usr/bin/env bash
set -euo pipefail
sha256sum --check .agents/artifacts/season-2026-audit/final-inputs.sha256
test "$(git -C /tmp/lol-2026-audit-baseline rev-parse HEAD)" = 904919f97b8059b2b152ae2c40d699c187e47178
pnpm exec tsx --tsconfig tsconfig.app.json scripts/replay-season-audit.ts /tmp/lol-2026-audit-baseline
pnpm exec tsx --tsconfig tsconfig.app.json .agents/artifacts/season-2026-audit/player-parity.mts
pnpm exec tsx --tsconfig tsconfig.app.json --test --test-concurrency=1 tests/communitySourceIdentity.test.ts tests/importers.test.ts tests/season2026LeagueScope.test.ts tests/seriesResolver.test.ts tests/conditionalPowerReplay.test.ts tests/conditionalPowerReplayBasis.test.ts tests/incrementalRankingIntegration.test.ts tests/rollingMovement.test.ts tests/stableMatchPagination.test.ts

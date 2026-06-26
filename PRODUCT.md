# Product Context

## Register

product

## Product Purpose

Build a better LoL Esports Global Power Rankings experience: a ranking workbench that explains why teams move, how tournaments are weighted, and how team/player strength changes across seasons and events.

## Users

- LoL esports fans who want a clearer answer than a static rank table.
- Analysts and creators who need defensible ranking explanations.
- Builders experimenting with alternate ranking models from public match data.

## Core Workflows

- See the current global ranking and quickly filter by season, event, and region.
- Select a team and understand the drivers behind its rating.
- Compare tournament weights, recency, opponent strength, and execution signals.
- Inspect team, player, season, and event timelines without leaving the ranking context.

## Product Principles

- Explain the rank, not only the number.
- Distinguish official reference data, public-source data, and seeded/demo data.
- Show confidence when rankings are close or data is thin.
- Keep controls dense, predictable, and analyst-friendly.
- Treat player importance as dynamic. Role weights are priors, not fixed truth; a support with repeated opponent-adjusted objective, vision, engage, award-residual, and form signal should be able to carry more roster value than an average mid laner.
- Optimize for forward-looking prediction with walk-forward backtests before promoting new features into the official scoring layer.
- Before 1.0, favor correctness over compatibility. Breaking schema, snapshot, model, or UI changes are acceptable when they make the ranking more accurate, fair, explainable, or maintainable, as long as the change is versioned and documented.

## Anti-References

- Static ranking tables with no movement explanation.
- Opaque model scores where small rating gaps look more certain than they are.
- Decorative esports dashboards that hide the actual data behind oversized visuals.

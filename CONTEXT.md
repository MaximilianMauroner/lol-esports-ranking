# Context Glossary

## Global Power Ranking

A ranking snapshot that orders LoL esports teams by estimated current strength.

## Rating

The numeric strength estimate behind a ranking position.

## Tournament Weight

The importance assigned to a match because of its competitive context, such as Worlds playoffs, MSI bracket play, regional playoffs, or regular season.

## Ranking Snapshot

A dated view of ratings, ranks, movement, confidence, and explanatory factors.

## Run

A single execution of the ranking pipeline that produces one coherent set of public artifacts. All artifacts from the same run share `runId`, `generatedAt`, `modelVersion`, and `modelConfigHash`.

## Artifact

A generated public JSON file with a declared purpose, schema version, provenance metadata, and a stable URL. Artifacts are the audit surface for the browser and read wrappers.

## Scope

The selected ranking view inside a run, such as all matches or a source season. A scope filters ranking rows without changing the entity IDs used across artifacts.

## Entity

A stable ID-addressable domain object such as a team, player, event, or league. Display names and provider names are metadata for an entity, not join keys.

## Team Timeline

The history of a team's rating and rank changes across matches or events.

## Player Skill Timeline

The history of a player's estimated contribution over time, separated from the team's overall rating where possible.

## Season Timeline

A season-level sequence of events, patches, and rating changes.

## Event Timeline

An event-level sequence showing which matches changed ratings and confidence.

## Confidence

The trust level attached to a rating, based on match volume, recency, and closeness of nearby teams.

## League Strength

A league-level strength score updated by international or cross-league matches. The league strength score contributes an adjustment to every team in that league, so collective overperformance or underperformance affects all member teams.

## Source Provenance

The recorded origin of a match or ranking snapshot, including provider, URL or file name, retrieval time, attribution, and whether it was used as active model input or reference-only context.

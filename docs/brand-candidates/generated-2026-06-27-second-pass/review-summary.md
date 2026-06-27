# 2026-06-27 Second-Pass Icon Review

Generated with the Codex `imagegen` skill after the first-pass compass icon was rejected as too AI-generated. These are original app-icon candidates for the LoL Esports Ranking workbench and are not Riot, LoL Esports, team, tournament, or data-source assets.

## Process

1. Five generator agents created initial candidates: `rating-grid.png`, `region-rings.png`, `delta-band.png`, `match-ladder.png`, and `source-anchor.png`.
2. Three reviewer agents scored the initial sheet for anti-AI restraint, product/domain fit, and small-size clarity.
3. The same five generator agents received the review data and produced revised candidates.
4. Three final reviewer agents ranked the five revised candidates.

## Final Ranking

| Rank | Candidate | Final reviewer scores | Notes |
| ---: | --- | --- | --- |
| 1 | `revised/rating-grid-revised.png` | 8.5, 8.0, 8.5 | Unanimous winner; flattest and least AI-coded, with a clear rankings-workbench signal. |
| 2 | `revised/match-ladder-revised.png` | 7.0, 7.0, 7.5 | Strong ranking movement signal, but closer to generic progress-chart language. |
| 3 | `revised/delta-band-revised.png` | 7.5, 6.5, 5.5 | Clean and compact, but more abstract and less domain-specific. |
| 4 | `revised/source-anchor-revised.png` | 5.5, 5.5, 6.5 | Useful provenance cue, but still reads like a generic data/source mark. |
| 5 | `revised/region-rings-revised.png` | 6.5, 4.5, 4.0 | Improved, but still too close to network-intelligence logo language. |

## Decision

Selected `revised/rating-grid-revised.png` as the active app icon. It directly addresses the rejection of the first-pass icon: no glossy render, no bevel, no faux-3D, no badge language, no glow, no decorative gold accent, and no AI-logo-pack treatment. The mark is intentionally simple: a flat grid with three selected cells stepping diagonally to imply ranking/model output.

## Selected Prompt

```text
Use case: logo-brand
Asset type: square web app icon candidate for LoL Esports Ranking
Primary request: revise the rating-grid concept into a simple 3x3 rating grid with thick stone strokes and three bold muted-cyan selected cells stepping diagonally.
Style/medium: flat 2D vector-like editorial product icon.
Composition/framing: large centered mark with strong 32px silhouette and generous padding.
Color palette: charcoal background, off-white/stone grid, muted cyan selected cells.
Constraints: no text; no letters; no numbers; no watermark; no Riot logo; no League of Legends logo; no LoL Esports logo; no team logos; no data-source logos; no trophy; no shield; no crown; no sword; no mascot; no fantasy map; no 3D; no bevel; no glass; no metal; no glow; no gradients; no shadows; no app-store mockup tile.
Avoid: AI-logo-pack look, fake depth, glossy rendering, tiny nodes, thin-line detail, decorative gold dot.
```

## Served Assets

- `public/logo.png` - 512px generated raster mark.
- `public/logo.svg` - SVG wrapper for the generated app mark.
- `public/favicon.png` - 64px favicon used by `index.html`.
- `public/favicon.ico` - multi-size fallback favicon.
- `public/favicon.svg` - SVG compatibility wrapper for the generated favicon.
- `public/apple-touch-icon.png` - 180px touch icon.
- `public/icons.svg` - rating-grid `logo-mark` symbol for sprite consistency.

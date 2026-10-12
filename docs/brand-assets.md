# Brand assets

The Power Index mark is a custom pi glyph: a gold beam over cyan legs, with a
curled right foot. Opus 5.5 selected and approved it for the site.
It suggests the initials P.I. and a rating built from a model, and stays distinct
from team mascots in the rankings.

The approved family is in `src/data/brandMark.ts`: the 64-unit startup tile,
pixel-aligned bare 36px header, hand-drawn 16px favicon, and maskable version.
The startup screen uses the tile inline so first paint needs no image download.
Install icons and the social image use the same shape.

After editing the master, regenerate the static files:

```sh
pnpm exec tsx scripts/build-brand-assets.ts
```

This manual command needs ffmpeg with librsvg support. It is not part of the
production build. Commit the generated SVG, PNG and ICO files with the master.
The ICO contains 16, 32 and 48 pixel frames. The 16px frame and vector favicon
use the approved small drawing; the larger frames use the tile master. Install icons use an opaque tile;
the maskable icon adds a safe inset for circle and squircle crops.

The social card contains the product name and purpose, with no team names,
ratings, dates, model values or sample standings. It stays the same when data
refreshes. Its SVG is the editable source; the PNG is used by link previews.
The manifest and metadata use `#060708`, the sRGB rendering of the app background.

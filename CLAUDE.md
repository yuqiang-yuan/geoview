# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

geoview is a parser and renderer for `.ggb` files (GeoGebra's format — a ZIP archive containing `geogebra.xml`), rendered on Canvas 2D without requiring the GeoGebra application. Packaged as an ES library; 3D rendering (three.js) is planned but not yet implemented.

## Commands

```bash
npm run dev          # Svelte playground (dev/, port 5174) - load .ggb files interactively
npm test             # run all tests (vitest)
npm run test:watch   # vitest in watch mode
npx vitest run test/floor.test.ts          # run a single test file
npx vitest run test/floor.test.ts -t "name" # run a single test
npm run typecheck    # tsc --noEmit
npm run build        # tsc + vite build -> dist/
```

Tests run in a Node environment; `test/setup.ts` polyfills `DOMParser` with `@xmldom/xmldom` so the parser works outside the browser. Test fixtures are real `.ggb` files in `test/fixtures/`.

## Architecture

Pipeline: `.ggb` bytes → archive → XML → typed document → scene → render. Each stage is one module in `src/`:

1. **`archive.ts`** — unzip via fflate, extract `geogebra.xml` etc. into `GgbArchive`.
2. **`parser.ts`** — `parseXml()` parses the XML with `DOMParser` into a `GgbDocument` (`types.ts` holds all parse-side types). Construction items are kept in XML document order because order encodes dependencies.
3. **`viewport.ts`** — maps math coords ↔ pixel coords from the GGB `coordSystem` (`xZero`, `yZero`, `scale`, `yscale`). Note Canvas y is downward.
4. **`sampler.ts`** — compiles function expressions (`"f(x) = sin(x)"`) with mathjs and samples them into polylines, splitting at discontinuities. Discontinuity detection (asymptotes, jumps, poles) is pixel-space based so it stays zoom-independent.
5. **`scene-builder.ts`** — the bridge between parsing and rendering. Converts `GgbDocument` into a backend-agnostic `Scene` of `Renderable` objects (`render-types.ts`). Resolves label references between expressions, commands, and elements via lookup tables (`elementMap`, `coordMap`, `outputLabelToCommand`) — GeoGebra splits one logical object across multiple XML nodes (an `<expression>` plus an `<element>` with the same label, or a `<command>` whose output labels refer to `<element>` nodes).
6. **`renderer-2d.ts`** — `createRenderer2D()` draws a `Scene` to Canvas 2D: background, grid, axes/ticks/numbers, curves, points/lines/polygons. Owns interactive pan/zoom by mutating the viewport in place and re-rendering.
7. **`api.ts`** — `parseGgb()` and `renderGgb()` combine the whole pipeline; `index.ts` is the public export surface.

Key conventions:

- The Scene/Renderable layer is backend-agnostic so a three.js 3D backend can be added later without touching the parser.
- GeoGebra color alpha is inverted relative to CSS (GGB 0 = opaque); use `ggbColorToCss`.
- Labels render via a pluggable `LabelRenderer` callback; the dev playground (`dev/src/mathjax-labels.ts`) shows a MathJax → SVG → Image implementation.
- GeoGebra's `angleUnit` setting does NOT apply to function expressions — `sin(x)` always means radians; the sampler passes x to mathjs unconverted.

## Commit style

Conventional commits (`feat:`, `fix:`, `test:`, `chore:`) with lowercase summaries.

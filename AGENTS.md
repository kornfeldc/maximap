# AGENTS.md — Maximap

Route planner for motorcycle club group rides (German UI, Austrian focus). Users enter a list of stops, the app geocodes them, draws a driving route on a satellite map, and prints an A4 portrait sheet or saves a PNG. No backend, no database, no auth — everything runs client-side with localStorage persistence.

## Commands

```bash
npm install
npm run dev        # dev server at http://localhost:5173
npm run build      # production build (adapter-auto)
npm run check      # svelte-check + TypeScript (the only "test"/lint gate; no test suite exists)
```

There is no test framework, no ESLint, no CI. Use `npm run check` to verify changes.

## Stack & Architecture

- **SvelteKit 2 + Svelte 5 (runes mode forced)** via `vite.config.ts` — the SvelteKit plugin sets `runes: true` for all project files. Always use `$state`/`$effect`/`$derived`, never legacy `let` reactivity.
- **Tailwind CSS v4** via `@tailwindcss/vite` plugin (no `tailwind.config.js`; v4 CSS-based config in `src/app.css`).
- **shadcn-svelte-style components** in `src/lib/components/ui/` (bits-ui under the hood; aliases configured via `components.json`). Use these primitives rather than hand-rolling UI.
- **Leaflet** for the map. **jspdf** for PNG export. Both are dynamically imported — Leaflet is imported only inside `onMount` to avoid SSR issues.

### Code layout

- `src/routes/+page.svelte` — the entire app in one file (~1200 lines): state, map lifecycle, geocoding orchestration, print layout, and all markup/styles. Single-page app; there are no other routes.
- `src/lib/route.ts` — external service calls: geocoding (Nominatim primary, Photon fallback) and routing (OSRM demo server).
- `src/lib/parse.ts` — heuristic parsing of unstructured stop lists (pasted text from WhatsApp/email).
- `src/lib/utils.ts` — `cn()` helper (clsx + tailwind-merge), standard shadcn pattern.

### Data flow

1. `stops` state (Svelte 5 `$state`) → persisted to localStorage under key `maximap.state.v1` via `$effect`.
2. "Route berechnen" → sequentially geocodes each stop (1.1s delay between requests to respect Nominatim's 1 req/s limit, 2 attempts with retry) → `fetchRoute` on OSRM → Leaflet polylines + numbered div-icon markers → `fitBounds`.
3. Print: map is captured to an image (Leaflet tiles with `crossOrigin: true` to keep the canvas untainted), rendered into a hidden `.print-sheet` div, then `window.print()` with print CSS that hides everything else. `onafterprint` cleans up.

## External services (all free, no API keys)

| Service | Purpose | Constraint |
| --- | --- | --- |
| Esri World Imagery | Satellite tiles (+ separate label tile layer) | attribution required |
| Nominatim (OSM) | Geocoding, `countrycodes=at`, German results | max 1 req/sec — the 1100ms delay in `computeRoute` is intentional, don't remove |
| Photon (Komoot) | Geocoding fallback, Austria bbox `9.0,46.3,17.5,49.1` | automatic fallback |
| OSRM demo server | Driving route | demo server, fair use |

All geocoding/routing assumes **Austria** (bounding box, countrycodes). Changing that means touching both `geocodeNominatim` and `geocodePhoton`.

## Conventions & gotchas

- **Language**: all UI text, comments, and error messages are **German**. Keep it that way.
- **Indentation**: tabs (Svelte files, JSON configs).
- The app is **client-only by nature**: guard browser APIs with `browser` from `$app/environment` (see `loadState`) — SSR runs on first render.
- Leaflet state (`map`, layers, markers) lives in plain non-reactive variables set inside `onMount`; don't wrap the map object in `$state`. The map is initialized at a hardcoded start view (Schützen am Gebirge).
- Stop entries carry stable `id`s (monotonic counter) used for DOM focus (`ort-${id}`) — keyboard navigation (Enter adds/focuses next, arrows move) depends on them; don't replace with array indices.
- Route lines are drawn twice: a dark casing polyline under an amber one — keep both when restyling.
- Print/export relies on tile layers having `crossOrigin: true`; dropping it breaks the canvas capture.
- `static/logo.png` is a placeholder logo rendered on the print sheet, toggleable via `showLogo` state.

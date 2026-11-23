# Control plane website

The OpenInfer website: React, TypeScript and Vite, with Tailwind CSS. It talks to the control plane server (`../server`) on the same origin, over its browser API under `/api/v1` and a WebSocket; it has no server of its own.

Run in this directory (Node.js 22.18 or newer):

```sh
npm ci --ignore-scripts
npm test               # vitest: the state modules and the pages, in jsdom
npm run typecheck
npm run build          # type check, then the production build in dist/
```

The server serves `dist/` when `OPENINFER_WEB_DIR` points at it; `npm run demo` in the repository's root builds the website and does that.

## Developing

`npm run dev` starts the Vite dev server. Without a control plane behind it, open `/preview.html` on that server: it runs the real app on a fake backend (`src/test/preview.tsx`), with query flags for the cases it can show (for example `?signed-out`, `?preflight=fail`, `?stress`; the file lists them all).

Two scripts open the pages in a real browser and need a Chromium (`CHROMIUM_PATH`, or the Playwright cache on macOS):

- `npm run check:mobile` fails if any page overflows sideways at phone width;
- `node scripts/screenshots.mjs <directory> <step>` takes screenshots at desktop and phone width, light and dark, and fails on the same overflow and on text that must not be shown to users (`scripts/leaks.mjs`).

The code: `src/pages/` holds the pages, `src/state/` the logic behind them as plain functions (each with its `*.test.ts`), `src/api/` the client of the server's API, `src/components/` the shared components.

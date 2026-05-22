# Heaven Gardens Card Battle

Heaven Gardens is a Hebrew browser card-battle game. The current playable game is preserved as a legacy static build while the project is prepared for production, modularization, GitHub, Netlify, and a future Neon Postgres backend.

## Current State

- The playable prototype lives at `public/legacy-card-battle.html`.
- Images, frames, and music live under `public/assets`.
- The Vite app in `src/` currently wraps the legacy game in a full-screen iframe.
- No database is used yet. Browser persistence is still handled by the legacy game's `localStorage` code.

## Scripts

```bash
npm install
npm run dev
npm run build
npm run preview
```

## Production Direction

The next production pass should move behavior out of the legacy HTML in small, tested slices:

1. Extract card data into versioned JSON or TypeScript modules.
2. Extract pure game rules into a simulation module with no DOM access.
3. Add a storage adapter that keeps `localStorage` now and can swap to HTTP later.
4. Move rendering into modular UI code after the rules are isolated.
5. Keep debug tools, cheats, and layout editing behind explicit development flags.
6. Add Netlify Functions before Neon so database secrets stay server-side.

## Neon Boundary

When Neon is added, browser code should call Netlify Functions such as:

- `GET /api/cards`
- `GET /api/decks/:id`
- `POST /api/decks`
- `POST /api/matches`

Netlify Functions will use a server-only environment variable such as `NETLIFY_DATABASE_URL`. Do not put Neon connection strings in `src/` or any browser-delivered file.

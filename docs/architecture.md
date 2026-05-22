# Architecture Notes

## Goals

- Preserve the current playable prototype while production work begins.
- Separate simulation state from rendering and browser APIs.
- Keep a clear path from `localStorage` to Netlify Functions backed by Neon Postgres.
- Avoid changing game balance during structural refactors.

## Current Legacy Surface

The current legacy game combines:

- Static card definitions
- Game state and turn rules
- AI behavior
- DOM rendering
- Layout editor
- Cheats panel
- Music and fullscreen controls
- `localStorage` persistence

That file remains available at `public/legacy-card-battle.html` and should be treated as the behavioral reference until the modular version reaches parity.

## Target Module Shape

```text
src/
  app/
    routes and screen composition
  game/
    engine.js
    rules.js
    ai.js
    state.js
  cards/
    cards.json
    abilities.json
    schema.js
  storage/
    localStorageAdapter.js
    remoteAdapter.js
  api/
    client.js
  ui/
    components and rendering helpers
```

## Data Boundary

Card and deck data should be serializable and validated before use. Imported JSON, future admin-generated data, and database-returned rows must go through the same normalization path.

## Runtime Boundary

The game engine should expose pure operations:

- `createGame(seed, deckConfig)`
- `playCard(game, action)`
- `castSpell(game, action)`
- `startBattle(game)`
- `advanceTurn(game)`

Rendering should consume snapshots and dispatch actions. It should not own the rules.

## Future Netlify + Neon Boundary

Neon access belongs in Netlify Functions only. Browser code calls HTTP endpoints, and those endpoints use server-only environment variables.

Early endpoints can stay simple:

- Cards: read-only catalog
- Decks: save/load player deck
- Matches: store match summaries later

This keeps the first production release possible without a database while leaving the path ready.

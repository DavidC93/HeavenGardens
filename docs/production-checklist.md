# Production Checklist

## Before GitHub

- Initialize Git.
- Commit the legacy-preserving scaffold.
- Decide whether music assets should stay in repo or move to external storage later.
- Add license/ownership notes for generated or sourced artwork and music.

## Before Netlify Preview

- Run `npm install`.
- Run `npm run build`.
- Confirm `dist/legacy-card-battle.html` exists.
- Confirm `dist/assets` includes card frames, card images, and music.
- Deploy preview through Netlify.

## Before Public Production

- Hide or gate cheats and layout editor.
- Review imported JSON handling and remove unsafe `innerHTML` paths for untrusted data.
- Add basic smoke tests for loading, starting a game, summoning, casting, battle resolution, restart, and mobile layout.
- Optimize large assets, especially audio and high-weight card images.
- Add error boundaries or user-facing fallback states for failed asset loading.

## Before Neon

- Define card, deck, player, and match schemas.
- Add Netlify Functions for server-side access.
- Store Neon connection string only in Netlify environment variables.
- Keep local development on `localStorage` until remote storage parity is ready.

# Database System

The game now has a production-oriented database boundary:

- Browser code calls Netlify Functions.
- Netlify Functions use Neon through `DATABASE_URL` or `NETLIFY_DATABASE_URL`.
- The browser never receives the database connection string.

## Environment Variables

Set these in Netlify:

```text
DATABASE_URL=postgresql://...
SITE_URL=https://heaven-gardens.netlify.app
```

Optional password reset email via Resend:

```text
RESEND_API_KEY=...
PASSWORD_RESET_FROM="Heaven Gardens <noreply@your-domain.com>"
```

If Resend is not configured, password reset endpoints still create tokens and return a reset URL as a development fallback.

## Setup

After creating a Neon database and setting the connection string locally:

```bash
npm run db:setup
```

This runs:

- `db:migrate`: creates users, sessions, password reset tokens, cards, and user decks.
- `db:seed:cards`: imports the current legacy card catalog into the `cards` table.

## Admin

The first registered user becomes `admin`. Later users are regular `user` accounts.

Admins see the in-game card admin screen and can edit the full card JSON. Saving updates the Neon `cards` table and the game reloads the updated catalog.


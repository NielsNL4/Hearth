# Hearth

A development-first, DM-focused virtual tabletop. **Milestone 2 is implemented:** accounts, persistent rooms, invitation redemption, authoritative tactical rooms, large tiled maps, grids, and owned tokens.

See [`docs/plans/implementation-plan.md`](docs/plans/implementation-plan.md) for the complete product roadmap and [`docs/plans/milestone-2-tactical-map-and-tokens.md`](docs/plans/milestone-2-tactical-map-and-tokens.md) for this milestone's detailed scope.

Supabase provides authentication, room metadata, lobby presence, and durable Postgres persistence. A self-hosted Colyseus service is authoritative for active tactical rooms; private map and token data is processed by the asset service and stored in MinIO.

## What works

- Email/password signup, confirmation, login, and local-device logout.
- Persistent Supabase sessions and account-required invitations.
- DM creation of a campaign and its first room in one transaction.
- Invite links and copyable 32-character codes, visible to the DM.
- Invite redemption as a player; repeated joins preserve the existing role.
- A dashboard listing the signed-in user's rooms, campaign names, and roles.
- A lobby with saved membership, room activity, and online/away presence.
- Database-enforced membership and role permissions.
- Idempotent commands, durable command receipts, and a committed event stream.
- A versioned, render-independent empty scene persisted with each room.
- Responsive layouts, keyboard-operable forms/dialogs, error states, and reconnect indicators.
- Versioned SceneV2 state with explicit SceneV1 migration and typed wall foundations.
- Authenticated Colyseus rooms with membership checks, reconnect, idempotent commands, optimistic revisions, and durable snapshots/events.
- Private map and token uploads through presigned URLs, background image processing, and short-lived download URLs.
- Large-map WebP tile pyramids with viewport-based tile selection in an orthographic Three.js renderer.
- Configurable square grids, owned token placement/movement, HP, size, rotation, and off-map positioning.

## Start with a hosted Supabase project

### 1. Install dependencies

Use **Node 22.12+ and npm 11+**.

```bash
npm ci
```

If your system npm is older, `npx --yes npm@11 ci` also works. The environment used to build this project had an npm 9 dependency-resolution failure; npm 11 installed successfully.

### 2. Apply the database migration

Create a development Supabase project. Apply both files in `supabase/migrations/` in filename order, or use the CLI:

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

Use one migration method. If you apply SQL manually, the CLI migration history will not be populated automatically.

The migrations assume Supabase's existing `auth` and `realtime` schemas. They create the room model, SceneV2 persistence, snapshots, asset metadata, policies, and service-only command functions. Existing auth accounts are backfilled with profiles.

### 3. Configure authentication and realtime

In **Authentication → URL Configuration**:

- Site URL: `http://localhost:5173`
- Additional redirect URL: `http://localhost:5173/auth/callback**`
- If using the numeric loopback address, also add `http://127.0.0.1:5173/auth/callback**`.

The callback carries a `next` query parameter so email confirmation can return to an invitation. Keep the default confirmation email template's `{{ .ConfirmationURL }}`. Enable email/password signup and email confirmation, and set the minimum password length to 8. Hosted signup email delivery uses your project's configured email provider and rate limits.

In **Realtime → Settings**, disable **Allow public access** to enforce private channels. The migration adds member-only presence policies to `realtime.messages`. No Postgres Changes publication is required for this milestone.

### 4. Configure local services

Copy `infra/.env.example` to `infra/.env`. Set the same Supabase URL and a server-only service-role key, then replace both example secrets. Never expose the service-role key or `INTERNAL_JOB_SECRET` to the browser.

Start MinIO, the asset API, and Colyseus:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.yml up --build
```

MinIO listens on ports 9000/9001, the asset API on 3100, and Colyseus on 2567.

### 5. Set frontend environment variables

Copy `apps/web/.env.example` to `apps/web/.env` and fill in:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
VITE_MULTIPLAYER_URL=ws://localhost:2567
VITE_ASSET_API_URL=http://localhost:3100
```

Use the project's browser-safe **publishable key**. A legacy browser-safe `anon` key works in the same variable. Never put a service-role or secret key in a `VITE_` variable: Vite embeds these values in the browser bundle.

### 6. Run

```bash
npm run dev
```

Open **http://localhost:5173**. Restart Vite after changing environment variables. Without valid configuration, the app displays a setup screen rather than fake rooms or a broken login form.

## Optional: fully local Supabase

Docker and the Supabase CLI are needed. From the repository root:

```bash
npx supabase start
npx supabase db reset
npx supabase status
```

`db reset` recreates the **local development database**, applies migrations, and removes its existing data. Run it for initial setup or deliberate resets.

Use the API URL and browser-safe publishable/anon key reported by `supabase status` in `apps/web/.env`. Confirm signup emails through the local mail viewer URL reported by the CLI. Local Studio is configured on port 54323; the API is on port 54321. Stop only this project's stack with `npx supabase stop` from this directory.

Run the services from the previous section against local Supabase by setting `SUPABASE_URL=http://host.docker.internal:54321` on Docker Desktop. On Linux, either expose the local Supabase API to the containers or add an appropriate host-gateway mapping.

## Checks

```bash
npm run check
npx playwright install chromium
npm run test:e2e
```

On a minimal Linux installation, Playwright may additionally need `npx playwright install --with-deps chromium`.

| Check | Coverage |
| --- | --- |
| TypeScript | Web application, asset service, multiplayer service, and imported shared packages |
| Vitest + PGlite | Actual SQL migration, transactional commands, grants, RLS, invite handling, idempotency, role preservation, persisted reads, and presence policy predicates |
| Playwright / Chromium | Signup/invite flow, callback destinations, login, lobby controls, tactical grid/map/token workflows, and mobile layout |
| Vite build | Production frontend bundle |

Browser tests use intercepted Supabase, Colyseus, and asset-service boundaries and an isolated Vite server. They never contact a real project. PGlite tests use real PostgreSQL behavior, with minimal stubs for Supabase-owned auth/realtime objects. These checks **do not verify hosted email delivery, live WebSockets, or real object storage**; verify those with the two-browser acceptance flow below.

## Connected acceptance flow

1. **DM:** Sign up and confirm the email. Create campaign “Salt & Shadow” and room “The Sunken Keep”. Verify the lobby shows the DM role and invitation controls.
2. **Player:** Open the invitation in a separate browser profile/private window. Create a different account, confirm, and accept the invitation. Verify the player role and absence of DM invite controls.
3. **Presence:** Keep both lobbies open. Both should show “Live connection” and both party members at the table. Close one lobby and confirm it becomes away after Realtime detects the disconnect. Multiple tabs count as one member.
4. **Recovery:** Disable networking temporarily, restore it, and check presence recovery. The saved roster/activity also refreshes every 15 seconds and when presence synchronizes.
5. **Persistence:** Reload, then sign out and sign back in. The room remains accessible from My adventures, with the same roles and roster.
6. **Isolation:** In a third account, open the room URL directly before using its invite. Verify “Room unavailable”. Database reads for that nonmember must return no room, roster, campaign, invitation, or events.
7. **Idempotency:** Redeem the same invitation again. Membership and activity must not duplicate, and a DM redeeming their own invitation must remain a DM.
8. **Tactical sync:** Open the table in both browsers. Upload a map as DM and a token as either member; place and move the owned token and verify both browsers converge after reconnect/reload.
9. **Authorization:** Verify a player cannot set the map or move another player's token, and that private MinIO objects cannot be fetched without a fresh signed URL.

## Project layout

```text
apps/web/src/
  auth/                 Account entry and session lifecycle
  components/           Shared UI and app shell
  pages/                Dashboard, invitation, lobby, tactical table
  lib/                  Supabase bootstrap and error formatting
apps/assets/            Fastify asset API and image processing
apps/multiplayer/       Authoritative Colyseus room service
packages/domain/src/    Command contracts and input validation
packages/room-schema/   Colyseus Schema and DTO conversion
packages/scene/src/     Serializable SceneV1/V2 contracts and geometry
packages/sync/src/      Supabase lobby adapter and Colyseus client lifecycle
infra/                  MinIO and application-service Compose stack
supabase/migrations/    Tables, RLS, authoritative commands, events
tests/                  PostgreSQL integration and browser contract tests
```

## Data and permission model

- Each room currently creates a new campaign. Selecting an existing campaign and organizing multiple maps will be a later UI increment.
- `auth.users` supplies identity. A trigger creates a private-to-self profile. Room membership captures the display name at join time; profile editing is not exposed in this milestone.
- A membership row grants room/scene/roster/event visibility. Campaign visibility alone never grants access to another room.
- Only DMs can read invitation records. Invite possession plus a signed-in account grants player membership through `join_room`.
- Invites are unguessable UUID-derived codes, remain valid across sessions, and are reusable. Rotation, expiry, and player removal are later room-management features.
- Browser roles have read access under RLS; they cannot write tables directly. Commands derive the actor from `auth.uid()`, validate input, and run atomically as fixed-search-path definer functions.
- Command receipts are private, keyed by actor and command UUID, and serialized with a transaction-level advisory lock. Retrying the same command returns its original result; changed input with the same ID is rejected. The creation form retains its command ID across in-place retries.
- Durable events contain only room-safe activity data. Invitation codes are not published in events.
- Private room channels carry transient presence only. Presence is advisory and can never grant permissions or prove identity. Saved memberships are the authority.
- Durable roster/activity reads happen on entry, presence sync, network recovery, and every 15 seconds. This intentionally small development-first implementation does not yet broadcast durable map commands.
- The scene model stores world data, never Three.js objects or camera state. Rendering and geometry tools are milestone 2 work. Private DM content must use separately authorized records when added.

## Next implementation boundary

The next milestone can build fog editing, wall tools, initiative UI, and rules integration on the SceneV2 and authoritative-room foundations. The 5e edition and exact rules-automation behaviors remain an explicit decision gate; Open5e v2 is the selected content source, not the rules engine.

For frontend hosting later, serve `apps/web/dist` and rewrite application paths (`/rooms/*`, `/join/*`, `/auth/callback`) to `index.html`. Update the Supabase Site URL and callback allowlist for that origin.

## Work tracking

Jira was unavailable in the build environment. No Jira ticket or commit has been created.

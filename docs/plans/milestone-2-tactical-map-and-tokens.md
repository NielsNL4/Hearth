# Milestone 2: Tactical Map and Tokens

This is the detailed execution plan for milestone 2. The complete product roadmap is in [`implementation-plan.md`](./implementation-plan.md).

## Replaced Assumptions

- **REPLACED:** Supabase Postgres Changes is no longer the durable in-room sync stream; Colyseus Schema is the live synchronized state.
- **REPLACED:** Supabase Realtime Broadcast is no longer used for token previews; authoritative Colyseus room messages mutate synchronized token state.
- **REPLACED:** browser-to-Postgres RPCs no longer mutate tactical state; authenticated Colyseus command handlers validate, persist, and mutate it.
- **REPLACED:** walls are not deferred generic records; an empty typed 2D wall collection enters the scene and Colyseus schemas now.

## Goal

Deliver the first playable tactical table:

- Large map upload and tiled rendering.
- Pan and zoom.
- Adjustable square grid and grid snapping.
- Token image uploads and a reusable token palette.
- Token placement, movement, resizing, rotation, labels, and ownership.
- DM override plus a `players can move all tokens` room setting.
- Realtime drag previews and authoritative final positions.
- Persistent room state across reloads and reconnects.
- Self-hosted Colyseus room authority with automatic binary state deltas.
- Typed wall foundations for later movement, fog, lighting, and 3D behavior.

Fog, drawings, measurement, pings, and initiative remain the next milestone.

## Decisions

| Area | Decision |
| --- | --- |
| Renderer | Three.js with React Three Fiber and an orthographic camera |
| Scene coordinates | Intrinsic map pixels as world units |
| Camera | Local-only; never persisted or synchronized |
| Storage | Self-hosted MinIO with a Node asset-processing API |
| Maps | Up to 250 MB, 30,000 px maximum side, processed into WebP tiles |
| Tokens | Up to 25 MB source images, normalized to bounded WebP textures |
| Upload permissions | DM uploads maps; all room members upload token images |
| Token boundaries | Tokens may be placed outside the map |
| Multiplayer | Self-hosted Colyseus Node.js rooms |
| Live sync | Colyseus Schema binary delta synchronization |
| Persistence | Colyseus server checkpoints snapshots and events to Supabase Postgres |
| Reconnection | Colyseus automatic reconnect plus stored-token manual reconnect |
| Conflict handling | Server-serialized handlers, command idempotency, and per-token revisions |

Supabase Storage is not selected because its Free plan currently has a 50 MB per-file ceiling. A single giant image would also exceed practical browser and GPU texture limits. Tiling solves both issues.

## Architecture

The persisted scene remains independent of Three.js:

```ts
interface SceneV2 {
  version: 2;
  coordinateSystem: {
    origin: 'top-left';
    axes: 'x-right-y-down';
    worldUnit: 'map-pixel';
  };
  map: {
    assetId: string;
    width: number;
    height: number;
  } | null;
  grid: {
    type: 'square';
    visible: boolean;
    cellSize: number;
    offset: { x: number; y: number };
    distancePerCell: number;
    unit: 'ft' | 'm';
    snap: boolean;
  };
  permissions: {
    playerMovement: 'owned' | 'all';
  };
  tokens: Record<string, SceneToken>;
  walls: Record<string, SceneWall>;
  fog: SceneFog;
  drawings: Record<string, SceneDrawing>;
  structures: Record<string, SceneStructure>;
  lights: Record<string, SceneLight>;
  effects: Record<string, SceneEffect>;
  initiative: SceneInitiative;
  extensions: Record<string, unknown>;
}

type WallType = 'blocking' | 'terrain' | 'ethereal' | 'door';
type DoorState = 'open' | 'closed' | 'locked';

interface SceneWall {
  id: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  type: WallType;
  doorState?: DoorState;
  height: number;
  thickness: number;
  elevation: number;
  revision: number;
}
```

Each token stores an asset ID, world position, dimensions, rotation, label, owner, HP fields, visibility, stacking order, and revision. Provider URLs, signed URLs, textures, cameras, Colyseus objects, and Three.js objects remain outside persisted scene data.

Existing milestone 1 `SceneV1` records remain readable through an explicit, tested `SceneV1 -> SceneV2` migration. The database migration backfills existing rooms with empty typed walls and versioned empty fog/initiative state rather than silently changing the meaning of version 1.

Wall behavior is centralized even though editing and collision ship later:

| Type/state | Blocks sight | Blocks movement |
| --- | --- | --- |
| `blocking` | Yes | Yes |
| `terrain` | Yes | No |
| `ethereal` | No | Yes |
| `door/open` | No | No |
| `door/closed` | Yes | Yes |
| `door/locked` | Yes | Yes |

## Colyseus Multiplayer Service

Add `apps/multiplayer` and `packages/room-schema`.

One persisted room maps to one active Colyseus room. The multiplayer service will:

- Verify Supabase JWTs and persisted room membership in `onAuth`.
- Load the latest Postgres room snapshot in `onCreate`.
- Convert renderer-independent DTOs into Colyseus Schema classes.
- Synchronize members, map/grid, tokens with default HP fields, room permissions, typed walls, versioned empty fog state, and versioned empty initiative state.
- Use per-client State Views for DM-only or player-specific fields as those fields activate.
- Validate all client messages and derive the actor from `client.auth`.
- Persist final actions and events before acknowledging success.
- Checkpoint active rooms periodically and on disposal.
- Call `allowReconnection` after unexpected disconnects.

Use `MapSchema` for UUID-keyed entities. Keep explicit, tested conversion functions between persisted scene DTOs and Colyseus Schema classes so generators, geometry, persistence, and renderers never depend on Colyseus internals.

The browser stores the latest `room.reconnectionToken` in `sessionStorage`. While the room instance survives, the SDK retries automatically after `onDrop` and the UI handles `onReconnect`/`FAILED_TO_RECONNECT`. After reload it calls `client.reconnect(reconnectionToken)` and reattaches callbacks to the returned room. If the seat has expired or the server restarted, it clears the stale token, performs a new authenticated join, and receives state restored from Postgres.

## Storage Service

Add `apps/assets` and `infra/docker-compose.yml`.

The service will:

- Verify Supabase access tokens.
- Confirm room membership and upload permissions.
- Generate constrained MinIO upload forms.
- Stream uploads without retaining entire files in memory.
- Inspect images using `sharp`.
- Reject unsupported, animated, corrupt, oversized, or decompression-bomb inputs.
- Generate 512 px multiresolution WebP map tiles and a manifest.
- Generate bounded token textures and thumbnails.
- Track processing status in Postgres.
- Return short-lived, batch-signed download URLs.
- Resume or mark interrupted processing jobs after restart.

Development defaults:

- Maps: JPEG, PNG, or WebP; 250 MB; 30,000 px maximum side.
- Tokens: JPEG, PNG, or WebP; 25 MB; normalized to at most 2048 x 2048.
- Private MinIO buckets.
- Configurable room quota and stale-upload cleanup.
- MinIO credentials and Supabase service credentials remain server-only.

### Upload Flow

1. The browser requests an asset reservation through an authenticated Colyseus room command.
2. The Colyseus server verifies the role, writes the reservation to Postgres, and returns its ID.
3. The asset service verifies the Supabase token and reservation.
4. The service returns a constrained, presigned MinIO upload form.
5. The browser uploads directly to MinIO with progress reporting.
6. The browser asks the asset service to process the completed upload.
7. The service validates the source and creates map tiles or token derivatives.
8. The service marks the asset ready or failed in Postgres and notifies the active room.
9. The frontend receives short-lived signed URLs for only the assets needed by the current room and viewport.

The original map is retained by default so it can be reprocessed. Original token uploads may be removed after successful normalization. Both behaviors remain configurable for development.

## Database Changes

Add a new migration rather than changing milestone 1 history.

It will introduce:

- `rooms.scene_revision`.
- Durable room snapshots suitable for Colyseus restore.
- `room_assets` metadata and processing states.
- Server-only persistence functions for asset reservations and room checkpoints.
- Per-token optimistic concurrency checks.
- Scene event types and resulting revisions.
- DM-only map management.
- Member token uploads.
- DM-only ownership assignment and token deletion.
- Player transform permission for owned tokens or when room-wide movement is enabled.

Direct browser writes to rooms, assets, tokens, or events remain prohibited.

## Authoritative Commands

Implement typed Colyseus room messages and matching server handlers:

- `asset.reserve`
- `map.set`
- `grid.set`
- `permissions.playerMovement.set`
- `token.create`
- `token.transform.preview`
- `token.transform.commit`
- `token.details.update`
- `token.delete`

Asset processing completion is performed by the trusted asset service.

Every user command will:

- Derive the actor from `client.auth`.
- Validate membership and role.
- Reject invalid or non-finite coordinates.
- Reuse the milestone 1 idempotency mechanism.
- Persist each final action and resulting snapshot/event in Postgres.
- Mutate only its targeted Colyseus Schema entity.
- Let Colyseus distribute the resulting binary delta.
- Return a typed acknowledgement with the command and entity revision.

Token transform commands include the expected token revision. This permits concurrent changes to different tokens while rejecting stale changes to the same token.

## Renderer

Add a lazy-loaded tactical route at `/rooms/:roomId/table`.

The renderer will use:

- An orthographic Three.js camera.
- Frustum-based selection of visible map tiles.
- Textured planes for map tiles and tokens.
- A shader or line layer for the square grid.
- Pointer raycasting for token selection and manipulation.
- Device-pixel-ratio limits for mobile stability.
- Visible off-map staging space.
- Local camera persistence in browser storage, scoped to room and user.

Controls will include:

- Wheel and pinch zoom around the pointer.
- Middle-button or space-drag panning.
- Touch pan and pinch zoom.
- Reset and fit-map actions.
- Grid visibility, size, and X/Y offset controls.
- Selection handles for moving, resizing, and rotating tokens.
- Inspector controls as keyboard-accessible alternatives.

The rendering package consumes the shared scene contract. It does not own game state, permissions, persistence, Colyseus calls, or Supabase calls. A future perspective renderer can consume the same scene data.

## Token Behavior

- Token positions are center points in world coordinates.
- Grid snapping places token centers at grid-cell centers.
- Token size is expressed in world units and may span multiple cells.
- Rotation is normalized before persistence.
- Tokens may be staged outside map bounds.
- The DM can move, resize, rotate, relabel, reassign, or delete any token.
- A player can transform an owned token.
- When shared movement is enabled, players can transform all tokens.
- Ownership changes and deletion remain DM-only.
- Live Schema updates never bypass server-side permission checks.

## Synchronization

Use one authenticated Colyseus room connection for presence and tactical state.

Transient dragging:

- Send `token.transform.preview` at approximately 20 updates per second.
- Validate ownership/shared movement on every preview message.
- Update bounded preview transform fields in the server Schema.
- Let Colyseus send compressed state deltas to clients.
- Include a drag ID and sequence so the server rejects stale previews.
- Restore committed transforms when a drag expires or its client leaves permanently.

Final state:

- Send one `token.transform.commit` message on pointer release.
- Reuse the same command ID after ambiguous failures.
- Include the expected token revision.
- Reject stale updates to the same token.
- Permit concurrent updates to different tokens.
- Persist the final transform before acknowledging it.
- Revert Schema state to the last committed transform if persistence fails.
- Rely on Colyseus full-state synchronization after reconnect.
- Rejoin from the durable Postgres snapshot if the reconnect seat expires.

The active Colyseus room is the live authority; its committed Postgres snapshot is the restart/resume authority. Client state, pointer previews, and payload actor IDs never grant permissions or prove ownership.

## Expected Files and Modules

| Path | Purpose |
| --- | --- |
| `apps/multiplayer` | Colyseus room lifecycle, auth, commands, persistence, and reconnect handling |
| `apps/assets` | Authenticated upload, processing, and signed-download API |
| `apps/web/src/pages/TacticalRoom.tsx` | Tactical route and data lifecycle |
| `apps/web/src/components/tactical/` | Canvas, tools, palette, inspector, and interactions |
| `apps/web/src/tactical.css` | Route-specific responsive tactical styles |
| `infra/docker-compose.yml` | MinIO and asset-service development infrastructure |
| `packages/domain` | Asset and tactical command contracts |
| `packages/scene` | Scene schemas, migration, coordinates, snapping, and hit testing |
| `packages/room-schema` | Colyseus Schema classes and persisted DTO converters |
| `packages/rendering` | Three.js tactical renderer abstraction |
| `packages/sync` | Colyseus client connection plus Supabase lobby adapters |
| `supabase/migrations` | Asset metadata, snapshots, events, RLS, and server persistence functions |
| `tests` | Scene, database, sync, browser, and authorization coverage |

## Implementation Order

1. Save this plan and create the Jira milestone task if Jira access becomes available.
2. Add scene schemas, typed empty walls, migration parsing, geometry utilities, and unit tests.
3. Add Colyseus Schema classes and DTO conversion tests.
4. Add the Colyseus service, Supabase authentication, room authorization, persistence, and reconnection.
5. Migrate lobby presence from Supabase Realtime to Colyseus.
6. Add MinIO Docker Compose infrastructure and the asset API.
7. Add asset metadata, snapshots, events, server-only persistence functions, and database tests.
8. Refactor the sync package into a Colyseus room client and Supabase lobby repository.
9. Add the fullscreen tactical route and renderer abstraction.
10. Implement tiled map loading, camera navigation, and recovery states.
11. Implement map upload progress, processing status, and map selection.
12. Implement grid controls and snapping.
13. Implement token uploads, palette, creation, labels, ownership, and synchronized HP defaults.
14. Implement drag, resize, rotation, off-map placement, and keyboard controls.
15. Add server-authoritative previews, durable commits, revision conflicts, and reconnect recovery.
16. Add Playwright, Colyseus, multi-user, and responsive interaction tests.
17. Update setup, security, storage, and acceptance documentation.

## Testing

### Scene Tests

- Parse `SceneV1` and migrate it explicitly to `SceneV2`.
- Parse and validate every wall type and door state.
- Reject malformed scene data.
- Round-trip screen and world coordinates.
- Preserve the world point under cursor-centered zoom.
- Normalize grid offsets and rotations.
- Snap correctly around positive and negative coordinates.
- Hit-test rotated tokens.
- Convert persisted scene DTOs to/from Colyseus Schema without data loss.

### Database Tests

- Enforce map and token upload permissions.
- Isolate assets between rooms.
- Keep direct table writes prohibited.
- Validate idempotent commands and command-ID collisions.
- Enforce token ownership and shared movement.
- Permit concurrent updates to different tokens.
- Reject stale updates to the same token.
- Update scene, revision, and event atomically.
- Reject invalid coordinates, sizes, rotations, labels, and asset references.
- Enforce server-only snapshot/event persistence and outsider denial.

### Colyseus Tests

- Reject invalid Supabase JWTs and nonmembers in `onAuth`.
- Synchronize token transforms through binary Schema patches.
- Enforce DM, owner, and shared-movement permissions server-side.
- Prevent hidden State View fields from reaching unauthorized clients.
- Reuse command IDs after ambiguous acknowledgements.
- Restore committed values after persistence failure.
- Reconnect automatically while the seat is held.
- Reconnect manually after reload with the stored token.
- Rejoin from Postgres after seat expiry or server restart.

### Asset Service Tests

- Reject invalid JWTs and nonmembers.
- Enforce source size, type, dimension, and pixel-count limits.
- Reject animated and corrupt images.
- Generate deterministic manifests, map tiles, token textures, and thumbnails.
- Prevent cross-room signed URL access.
- Recover or fail interrupted processing jobs.
- Clean up stale reservations and partial output.

### Browser Tests

- Upload and render a large tiled map.
- Change grid size and offset.
- Pan, zoom, reset, and fit the map.
- Upload and create tokens.
- Drag with grid snapping.
- Resize, rotate, relabel, and assign ownership.
- Deny player manipulation of unowned tokens.
- Persist one final command per completed interaction.
- Reuse command IDs after ambiguous failures.
- Restore final state after reload.
- Keep controls usable on mobile viewports.

### Connected Acceptance Test

Use two authenticated browser profiles against Supabase, Colyseus, MinIO, and the asset service:

1. The DM uploads and activates a large map.
2. Both clients render the same visible tiles and grid.
3. The DM assigns a token to the player.
4. The other client receives binary Schema transform deltas before the move is committed.
5. Releasing the token produces one authoritative transform.
6. Reloading both clients restores identical state.
7. A short disconnect automatically reconnects to the same room state.
8. A reload manually reconnects with the saved token; an expired seat rejoins from Postgres.
9. Moving an unowned token is rejected by the Colyseus server.
10. A nonmember cannot join the Colyseus room or read scene data, assets, or tiles.

## Acceptance Criteria

- A map up to 250 MB and 30,000 px on either side can be uploaded without loading the source fully into browser memory.
- Large maps render through visible tiles rather than one GPU texture.
- DM and player browser sessions see transient token movement live.
- Reloading both sessions produces identical committed positions.
- Players cannot persist movement of unowned tokens unless the DM enables shared movement.
- Players can upload token images but cannot upload or replace maps.
- The DM can assign ownership and modify every token.
- Two users can move different tokens concurrently.
- Conflicting writes to the same token recover to authoritative state.
- Nonmembers cannot join room state or access scene data, source assets, or tiles.
- Desktop and mobile layouts remain usable.
- Existing milestone 1 room and invitation behavior continues passing.
- Every room includes the typed empty wall schema without exposing a wall editor yet.
- Tokens with HP fields, versioned fog state, and versioned initiative state are represented in server-owned Colyseus Schema classes even before their later editing controls ship.

## Verification Commands

```bash
npm run check
npm run test:e2e
docker compose -f infra/docker-compose.yml up --build
```

The connected two-browser acceptance test additionally verifies MinIO uploads, Colyseus binary state deltas, durable checkpoints, automatic/manual reconnect recovery, and server-side ownership rejection.

## Risks and Boundaries

- Processing a 250 MB, high-resolution image is resource intensive. The worker must use bounded concurrency and `sharp`/libvips rather than decoding the complete image in JavaScript memory.
- A 30,000 x 30,000 image is 900 megapixels. A separate configurable total-pixel ceiling is required to protect development machines even when each side is within the dimension limit.
- Presigned URLs must be short-lived and scoped to exact object paths. Provider URLs must never enter persisted scene state.
- Colyseus Schema is optimized for synchronized fields, not arbitrary large documents. Map tile manifests and future Open5e descriptions stay outside room Schema; only compact references and mutable game state are synchronized.
- Original map retention increases local storage use. Cleanup and retention settings must be documented before public hosting.
- Frequent preview mutations increase patch traffic. Throttle input, quantize suitable transforms, measure patch bytes, and persist only final transforms.
- A Colyseus process crash can lose uncommitted previews. Final actions are acknowledged only after persistence; periodic checkpoints bound loss for other mutable state.

## Work Tracking

Jira access was unavailable when this plan was created. Suggested task:

**Project:** `SCRUM`

**Title:** `[Realtime] Migrate room authority to Colyseus`

**Status:** In Progress when implementation begins.

Use this document's scope, acceptance criteria, affected modules, and verification sections as the ticket description.

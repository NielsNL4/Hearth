# Hearth Complete Implementation Plan

## Short Change Summary: Replaced Assumptions

Every item marked **REPLACED** supersedes an earlier assumption in this plan.

- **REPLACED:** Supabase Postgres Changes plus Realtime Broadcast -> self-hosted Colyseus Schema state, for one authoritative multiplayer process with binary deltas and reconnection.
- **REPLACED:** later generic wall records -> typed 2D wall segments in the Phase 1 scene contract, avoiding a breaking migration before visibility, collision, and 3D.
- **REPLACED:** unspecified wall-to-mesh generation -> deterministic `THREE.Shape` plus `THREE.ExtrudeGeometry`, with optional `SVGLoader` import from interchange SVG.
- **REPLACED:** a locally maintained 5e content database -> Open5e API v2 with attributed campaign/session caches.
- **REPLACED:** a custom particle/effect engine -> `three.quarks` with versioned JSON-authored effects and a batched Three.js runtime.
- **REPLACED:** custom GLB/glTF upload as the first avatar route -> Ready Player Me Avatar Creator and its returned `.glb` URL.
- **REPLACED:** a generator designed from scratch -> `dungeon-generator` by domasx2 behind a canonical-scene adapter and compatibility tests.
- **REPLACED:** an internal-only module registry -> a manifest, sandboxed iframe, toolbar action, and typed host-API extension model.
- **REPLACED:** unrestricted drag-only encounter movement -> a shared grid-movement model using PathFinding.js A*, reachable-cell previews, and server-authoritative path-cost validation; drag remains for setup and compatible destination input.
- **REPLACED:** a single generic 3D orbit camera -> separate tactical 2D, 3D overview, and immersive token-follow camera modes over the same Three.js scene.

## 1. Product Goal

Build a web-based virtual tabletop for tactical D&D and other TTRPG combat. The product should reach a useful shared-map release quickly, then add 3D, DM tooling, effects, character support, and procedural generation as independent modules.

The application must preserve these constraints from the first release:

- Scene data is serializable and independent of React, Three.js, cameras, and network transports.
- The same scene can drive an orthographic tactical renderer and a perspective 3D renderer.
- Fog, walls, lighting, measurements, and generated content use shared geometry primitives.
- Durable game commands are separate from realtime delivery.
- Optional modules consume typed scene extensions and committed events without modifying core synchronization code.
- Colyseus is authoritative while a room is active; Postgres is the durable source used to create and restore rooms.
- Private DM information is never delivered to unauthorized clients.
- Advanced features cannot block release of the usable tactical MVP.

## 2. Confirmed Decisions

| Area | Decision |
| --- | --- |
| Frontend | React, TypeScript, and Vite |
| Spatial rendering | Three.js through React Three Fiber |
| Database and authentication | Managed Supabase Postgres and Auth |
| Authoritative multiplayer | Self-hosted Colyseus on Node.js; Colyseus Cloud is a later scaling option |
| State synchronization | Colyseus Schema with automatic binary delta patches |
| Durable persistence | Colyseus server writes snapshots, command receipts, and events to Supabase Postgres |
| Transient messages | Colyseus room messages for pings and non-state notifications |
| Accounts | Accounts required for DMs and players |
| Development scale | Development usage; production concurrency is not yet specified |
| Asset hosting | Self-hosted MinIO behind a Node asset API |
| Large map target | 250 MB source file and 30,000 px maximum side |
| Token upload target | At least 20 MB; use a 25 MB milestone limit |
| Player uploads | Room members may upload token images; only DMs may upload maps |
| Off-map staging | Tokens may be placed outside the map |
| Grid movement | `pathfinding` (PathFinding.js) behind a system-neutral adapter; Colyseus recomputes and validates paths and movement cost |
| Camera modes | Orthographic tactical 2D plus perspective overview and immersive token-follow modes over one scene |
| Rules | Shared rolls and combat basics are desired |
| Rules edition | Unresolved; automation waits for a 2014 versus 2024 decision |
| Rules content | Open5e API v2, filtered by approved source documents and cached per campaign/session |
| Effects | `three.quarks` JSON effects |
| Avatar models | Ready Player Me first; arbitrary model upload deferred |
| Dungeon generation | `dungeon-generator` behind an adapter and compatibility tests |
| Monetization | Not defined and not required for development milestones |

Supabase Storage is not used for source maps because its Free plan currently limits individual files to 50 MB. MinIO also avoids coupling persisted scenes to a hosted storage provider. Large maps are converted to tiles because a single high-resolution texture would exceed practical browser memory and GPU limits.

## 3. Delivery Strategy

Work is divided into independently releasable milestones. Each milestone must preserve previous behavior, pass automated checks, and include a connected multi-browser acceptance test where realtime behavior is involved.

| Milestone | Outcome | Release status |
| --- | --- | --- |
| 1 | Accounts, persistent rooms, invitations, lobby, presence | Implemented |
| 2 | Colyseus migration, large maps, grid, typed wall schema, tokens, ownership, realtime movement | Next |
| 3 | Fog, drawing, ruler, pings, initiative | Completes lean tactical MVP |
| 4 | 3D walls, buildings, doors, floors, roofs, orbit camera | Phase 2a |
| 5 | Geometry-based line of sight, fog, and lighting foundation | Phase 2a/2c bridge |
| 6 | DM dashboard, encounter builder, combat tracking, private notes | Phase 2b |
| 7 | AoE templates, dynamic lighting, spell effects, weather | Phase 2c |
| 8 | Character overview and combat rules module | Phase 3 |
| 9 | Ready Player Me character model integration | Phase 3 |
| 10 | Procedural tactical maps and dungeons | Phase 3 |
| 11 | Procedural city generation | Phase 3 |
| 12 | Community assets and marketplace foundation | Future |

Milestones 4 through 11 are modules. Their code, database tables, scene extensions, and UI should be removable without breaking room, map, token, fog, drawing, or initiative fundamentals.

Phase mapping:

- Phase 1 spans milestones 1 through 3 and ends with the complete lean tactical MVP.
- Phase 2a spans milestones 4 and 5.
- Phase 2b is milestone 6.
- Phase 2c is milestone 7.
- Phase 3 spans milestones 8 through 11; milestone 12 remains future work.

Click-to-move is deliberately split across phases without splitting its authority model:

- **Phase 1 / milestone 2:** canonical grid movement, PathFinding.js adapter, wall-edge traversal, server-owned allowance/spend/path state, and authoritative destination validation.
- **Phase 1 / milestone 3:** initiative resets and remaining-movement state integrate with the existing model; developer diagnostics may expose reachability without making the full feature a release blocker.
- **Phase 2a / milestone 4:** the shared 3D scene adds overview and immersive token-follow cameras plus wall-aware visual traversal.
- **Phase 3 / milestone 9:** Ready Player Me idle/walk animation completes immersive path presentation; flat-token tweening remains the permanent fallback.

The typed wall contract belongs to Phase 1. Because milestone 1 was implemented before this decision, the first Phase 1 schema migration that can add it is milestone 2; milestone 3 and all later work must consume that contract rather than introduce another wall model.

## 4. Repository Architecture

Target workspace layout:

```text
apps/
  web/                   React application and route composition
  multiplayer/           Authoritative Colyseus rooms, auth, persistence, content proxy
  assets/                MinIO upload, processing, and signed-access API
packages/
  domain/                Commands, permissions, events, and shared validation
  scene/                 Versioned renderer-independent scene contracts
  room-schema/            Shared Colyseus Schema classes and DTO conversion
  geometry/              Polygons, rays, intersections, visibility, measurement
  movement/              PathFinding.js adapter, wall-edge traversal, reachability, and path-cost rules
  rendering/             Renderer interfaces and shared render resources
  rendering-tactical/    Orthographic Three.js renderer
  rendering-diorama/     Perspective Three.js renderer
  sync/                  Colyseus client adapter plus Supabase lobby/persistence adapters
  extensions/            Manifest, host SDK, iframe bridge, and built-in registrations
  open5e/                 Open5e v2 adapter, normalization, source policy, and cache contracts
  rules-5e/              Optional edition-specific rules adapter
  generation/            Shared seeded generation primitives
infra/
  docker-compose.yml     Colyseus, MinIO, and asset service development stack
supabase/
  migrations/            Postgres schema, RLS, snapshots, commands, events, and caches
tests/
  database/              PostgreSQL integration and security tests
  e2e/                   Browser workflows
  fixtures/              Maps, tokens, models, and expected generated scenes
docs/
  plans/                 Master and milestone execution plans
  architecture/          Data, security, module, and deployment decisions
```

Packages should only be introduced when their boundary is used. The current compact package structure remains acceptable until a milestone needs the proposed split.

## 5. Core Architecture

### 5.1 Scene Model

The authoritative scene is a versioned, JSON-serializable document. It contains world state but no renderer instances, cached URLs, browser blobs, camera controls, or socket objects.

Target top-level model:

```ts
interface SceneV2 {
  version: 2;
  coordinateSystem: {
    origin: 'top-left';
    axes: 'x-right-y-down';
    worldUnit: 'map-pixel';
  };
  map: SceneMap | null;
  grid: SceneGrid;
  permissions: ScenePermissions;
  tokens: Record<string, SceneToken>;
  drawings: Record<string, SceneDrawing>;
  fog: SceneFog;
  walls: Record<string, SceneWall>;
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
  start: ScenePoint;
  end: ScenePoint;
  type: WallType;
  doorState?: DoorState;
  height: number;
  thickness: number;
  elevation: number;
  revision: number;
}

interface SceneTokenMovement {
  allowanceCells: number | null;
  spentCells: number;
  activePath: GridPoint[];
  pathCostCells: number;
  pathStartedAtServerMs: number | null;
  millisecondsPerCell: number;
  status: 'idle' | 'moving' | 'interrupted';
  revision: number;
}
```

Rules:

- Map pixels are the initial world units.
- Token positions represent centers.
- Geometry uses explicit points, polygons, segments, elevations, and units.
- Stable UUIDs identify every editable entity.
- Entity-local revisions prevent unrelated edits from conflicting.
- Scene migrations are pure, deterministic, and tested; milestone 1 `SceneV1` records migrate explicitly to `SceneV2`.
- Unknown extension data survives round trips.
- Generators produce valid scene fragments accepted by the manual editor.
- Walls are always pure 2D points plus line segments; generated meshes are derived output.
- `doorState` is present only for `door` segments and is validated server-side.
- Token movement state is system-neutral and grid-based. A manually configured allowance is available before character rules exist; a future rules adapter may supply speed without changing the movement contract.

Wall behavior is defined centrally and reused by movement, visibility, fog, and 3D conversion:

| Wall type/state | Blocks sight | Blocks movement |
| --- | --- | --- |
| `blocking` | Yes | Yes |
| `terrain` | Yes | No |
| `ethereal` | No | Yes |
| `door/open` | No | No |
| `door/closed` | Yes | Yes |
| `door/locked` | Yes | Yes |

Pathfinding consumes this exact table: `blocking`, `ethereal`, and closed/locked doors prevent crossing their segment; `terrain` and open doors do not. It never maintains a second obstacle grid that can drift from scene walls.

**REPLACED:** walls are no longer deferred generic records. Typed fields and movement-edge consumption enter milestone 2; wall editing, line of sight, and extrusion activate incrementally later. Existing milestone 1 scenes are backfilled with an empty typed wall collection.

### 5.2 Coordinate and Geometry Model

Maintain explicit coordinate spaces:

- World space: persisted scene values.
- Screen space: pointer and viewport coordinates.
- Camera space: renderer-only transforms.
- Grid space: integer cell coordinates and fractional cell positions.
- 3D space: world X/Y map coordinates plus elevation and height.

Shared geometry covers:

- World/screen transformations.
- Grid snapping and distance conventions.
- Lines, rectangles, ellipses, polygons, cones, circles, and cubes.
- Segment intersection and point-in-polygon tests.
- Wall topology and opening intervals.
- 2D ray casting and visibility polygons.
- Extrusion input for the 3D renderer.
- Area-of-effect footprints.
- Wall-type behavior lookup for sight and movement.
- Deterministic conversion from a wall segment to a rectangular `THREE.Shape` input.

Grid movement is implemented through a provider-neutral movement adapter backed initially by the `pathfinding` npm package (PathFinding.js):

- Scene grid cells become PathFinding.js nodes, but canonical wall segments remain edge constraints rather than duplicated blocked-cell data.
- A neighbor is traversable only when moving between the two cells does not cross a movement-blocking wall segment or closed/locked door.
- Door-state, wall-revision, occupancy, or token-footprint changes invalidate cached reachability results.
- Client and server share deterministic diagonal and cost configuration, but the server always rebuilds the path and cost from the destination instead of trusting a submitted client path.
- Reachability calculates every destination within the authoritative remaining allowance and returns predecessor/cost data for tactical highlighting.
- Large tokens evaluate every occupied grid cell and cannot clip corners or cross a blocked edge.
- Off-grid staged tokens may be positioned by setup transforms but must enter the encounter grid through a server-approved destination.
- Accepted paths are integer `GridPoint[]` cell coordinates. Rendering converts each cell to its world-space center; path state never mixes screen or world coordinates.
- Room state owns a monotonic `navigationRevision`, incremented whenever grid settings, movement-blocking wall/door state, occupancy policy inputs, or relevant token footprints change. Destination commands include the expected navigation revision.
- A successful move persists the final world position immediately with `activePath`, path cost, server epoch start time, milliseconds per cost unit, and movement status. Clients animate this authoritative path against server time; reconnects past its calculated end render the final position, and replacement/interruption increments the movement revision.

The 2D and 3D renderers may optimize geometry independently, but optimized objects are derived caches and never authoritative data. SVG may be used as an editor/import interchange format, but it is never the canonical scene model.

### 5.3 Colyseus Room State

**REPLACED:** Supabase Postgres Changes and Realtime Broadcast are no longer the in-room state transport. Supabase remains the account system and durable database; Colyseus becomes the live authority.

Each persisted room maps to one Colyseus room session. On room creation or activation, the server loads the latest durable snapshot and converts it to synchronized Schema classes. The shared Schema includes at minimum:

- Connected members and roles.
- Map/grid references and room permissions.
- Tokens, ownership, transforms, labels, HP, and visibility flags.
- Typed walls and door state.
- Monotonic navigation revision plus token movement allowance, spend, accepted grid path, timing, and status.
- Fog geometry and visibility state.
- Initiative order, active turn, and round.
- Drawings, templates, lights, and effects as their milestones activate.

Use `MapSchema` for entities keyed by stable UUID and nested Schema classes to stay below per-schema field limits. Use explicit conversion functions in `packages/room-schema`:

```text
Persisted RoomSnapshot DTO <-> Colyseus RoomState Schema -> renderer-independent Scene DTO
```

The conversion layer prevents Colyseus classes from leaking into generators, geometry code, persistence records, or Three.js renderers.

The Phase 1 Colyseus state defines real, versioned fields even before every editing UI exists:

```ts
interface TokenState {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  hpCurrent: number;
  hpMaximum: number;
  hpHidden: boolean;
  movementAllowanceCells: number;
  movementSpentCells: number;
  movementUnlimited: boolean;
  activePath: ArraySchema<GridPointState>;
  pathStartedAtServerMs: number;
  pathCostCells: number;
  millisecondsPerCell: number;
  movementStatus: 'idle' | 'moving' | 'interrupted';
  revision: number;
}

interface FogState {
  revision: number;
  mode: 'shared' | 'per-player';
  regions: MapSchema<FogRegionState>;
}

interface InitiativeState {
  entries: MapSchema<InitiativeEntryState>;
  order: ArraySchema<string>;
  activeIndex: number;
  round: number;
  revision: number;
}
```

Milestone 2 initializes and synchronizes these fields with empty fog/initiative collections, token HP defaults, and system-neutral movement defaults. A nullable/unlimited movement allowance supports setup before turn tracking exists. Milestone 3 connects allowance reset and remaining movement to initiative; milestone 6 adds encounter-aware HP controls; milestone 8 may derive allowance from character speed. This is authoritative state with staged behavior, not an untyped placeholder.

Room lifecycle:

1. `onAuth` verifies the Supabase JWT and resolves durable room membership.
2. `onCreate` loads the persisted snapshot and initializes Schema state.
3. `onJoin` binds one authenticated user to a room client and a filtered state view.
4. Client messages are validated and handled serially by authoritative command handlers.
5. Colyseus automatically sends binary state deltas after Schema mutations.
6. Final commands append durable events and checkpoint the snapshot in Postgres.
7. `onDrop` calls `allowReconnection`; transient disconnects retain the player's seat.
8. `onReconnect` restores the live client and sends/reconciles the full current state.
9. `onDispose` flushes a final checkpoint before room shutdown where possible.

Store refreshed reconnection tokens in `sessionStorage`. While the live room object exists, register `onDrop`, `onReconnect`, and `onLeave`; the Colyseus SDK performs automatic retries with exponential backoff after `onDrop`. After page reload, call `client.reconnect(reconnectionToken)` and attach callbacks to the returned room instance. If the seat expired, retries end with `FAILED_TO_RECONNECT`, or the process restarted, clear the stale token, authenticate, and join the durable room again; the server rebuilds state from Postgres.

### 5.4 Commands and Events

Use this flow for durable changes:

```text
UI intent
  -> validated domain command
  -> authenticated Colyseus room message
  -> server permission and revision check
  -> durable event/snapshot transaction for final actions
  -> Colyseus Schema mutation
  -> automatic binary delta patch
  -> client state callback
```

Command requirements:

- Every command has a UUID generated before the first attempt.
- Retries reuse the same command UUID.
- Reusing an ID with different input is rejected.
- The actor always comes from `client.auth`, never from a message payload.
- Room messages accept narrow typed operations, not arbitrary JSON patches.
- Commands update only the targeted entity or scene fragment.
- Results contain authoritative data and resulting revisions.
- Relevant modules may consume committed events through typed subscribers.
- Postgres credentials and privileged persistence functions are server-only.
- Existing room-creation and invitation RPCs may remain in Supabase; in-room game mutations move to Colyseus handlers.
- `token.move.commit` contains a grid destination, expected token/navigation/movement revisions, and command UUID, not an authoritative client path. The server rebuilds A*, checks ownership, blockers, occupancy, and remaining allowance, then atomically persists the final position, active path, timing, cost, and budget.
- Reachable-cell and path previews are disposable client projections. A server rejection or different authoritative path replaces them immediately.

Continuous token transforms may update bounded Schema preview fields so clients receive compressed deltas. Final pointer release performs the durable setup-transform command. In budgeted encounter mode, click or drag supplies only a destination to `token.move.commit`; neither interaction can bypass path or speed validation. Pings, one-shot effects, and extension notifications use typed Colyseus room messages rather than persistent state.

### 5.5 Reconciliation and Persistence

Clients join a Colyseus room, receive its full Schema state, then receive automatic binary delta patches.

- Bind rendering state through Colyseus state callbacks rather than polling Postgres.
- Ignore stale command acknowledgements and entity revisions.
- Let automatic reconnect reconcile the existing state tree.
- Reattach callbacks after manual `client.reconnect(reconnectionToken)` returns a new room instance.
- Rejoin from the durable Postgres snapshot when a reconnect seat has expired.
- Roll back rejected optimistic state.
- Preserve local camera and panel state during a full-state replacement.
- Do not acknowledge a final action as durable until its Postgres transaction succeeds.
- If persistence fails, restore the last committed values in Schema state and return a typed error.
- Periodically checkpoint active rooms and compact event history without replacing the event audit trail required by analytics.

### 5.6 Extension and Plugin System

**REPLACED:** the earlier internal-only module interface becomes a lightweight Owlbear-style extension model. MVP features still register in-process, while the contracts also support sandboxed iframe extensions later.

Each extension has a manifest:

```ts
interface HearthExtensionManifest {
  id: string;
  name: string;
  version: string;
  entry?: string;
  permissions: ExtensionPermission[];
  capabilities: ExtensionCapability[];
  toolbarActions?: ToolbarActionManifest[];
  panels?: PanelManifest[];
}
```

Built-in modules register through typed interfaces:

```ts
interface HearthModule {
  id: string;
  version: string;
  sceneExtensions?: SceneExtensionRegistration[];
  roomMessages?: RoomMessageRegistration[];
  eventSubscribers?: EventSubscriberRegistration[];
  panels?: PanelRegistration[];
  tools?: ToolRegistration[];
  tacticalLayers?: RenderLayerRegistration[];
  dioramaLayers?: RenderLayerRegistration[];
}
```

Module rules:

- Core routes work when optional modules are disabled.
- Modules own namespaced scene extensions and migrations.
- Modules may subscribe to committed server events and authorized Colyseus state projections.
- Modules cannot bypass core authentication or room membership.
- Large modules are route- or feature-lazy-loaded.
- Module failures are isolated with UI and renderer error boundaries.
- Module capabilities are stored per room or campaign, not hardcoded globally.
- Extension messages and scene keys are namespaced by extension ID.
- Third-party iframe extensions run with a restrictive `sandbox` and explicit origin allowlist.
- The host validates every `postMessage` envelope, origin, nonce, schema, permission, and capability.
- Iframes never receive raw Supabase tokens, Colyseus reconnection tokens, MinIO credentials, or direct database access.
- The host SDK exposes scoped reads, commands, selection, toolbar actions, and subscriptions.
- Remote third-party extension installation remains disabled in the MVP; only the manifest and host contracts are established.
- Milestone 2 must establish the namespaced scene-extension envelope, typed committed-event subscriber contract, and built-in registration API. The iframe host and third-party installation UI can remain dormant until a later built-in module validates the boundary.
- Movement authority, pathfinding, and camera-mode contracts are core capabilities because they enforce shared spatial rules and stable renderer switching. Perspective overview/follow renderers remain removable milestone-4 modules; dice, combat tracker, notes, optional render layers, and avatar presentation may consume extension points without owning core movement state.

The dice roller, combat tracker, and notes panel should be the first built-in consumers of these contracts. Building them as first-party extensions validates the API before any third-party installation flow is enabled.

## 6. Data and Security Architecture

### 6.1 Core Data

Primary records include:

- Profiles.
- Campaigns.
- Rooms.
- Room memberships and roles.
- Room invitations.
- Versioned scenes and scene revisions.
- Room assets and processing status.
- Command receipts.
- Committed room events.
- Sessions and combat encounters.
- Character summaries and rules data.
- Private DM records in separately authorized tables.

Large renderer assets never live in Postgres. Postgres stores provider-neutral asset IDs, metadata, dimensions, hashes, ownership, status, and object keys.

### 6.2 Authorization

Enforce authorization in Postgres, the authoritative Colyseus server, or the trusted asset service, never only in React.

- Nonmembers cannot discover room state, membership, events, or assets.
- Players can transform owned tokens unless the DM enables shared movement.
- DMs can transform all tokens and configure room-level behavior.
- DM-only notes, tokens, encounter details, hidden HP, and unrevealed geometry are omitted from player snapshots and Colyseus State Views.
- Colyseus `onAuth` verifies Supabase identity and persisted membership before room access.
- Colyseus State Views or equivalent server-filtered projections prevent hidden HP, fog, notes, and secret entities from entering unauthorized client state.
- Asset API authorization verifies Supabase JWTs and room membership.
- MinIO is private and never exposes permanent public object URLs.
- Service-role and MinIO credentials are server-only.
- Uploaded file names are metadata; generated object paths use controlled IDs.
- SVG, HTML, executable content, and untrusted archives are rejected.
- Extension iframes receive only explicitly granted host APIs and are subject to CSP and origin restrictions.

### 6.3 Private Information

Visual masking is not sufficient protection. Private data must be withheld server-side.

Store separately:

- DM notes.
- Secret tokens.
- Hidden encounter stat blocks.
- Hidden HP values.
- Unrevealed per-player fog geometry when individual fog is enabled.
- Private character details that are not shared with other players.

If strict unexplored-map secrecy is required, the asset API must serve visibility-filtered tiles. A client that downloads the complete source map can otherwise inspect it outside the application.

## 7. Asset Pipeline

### 7.1 Map Ingestion

Map source limits for development:

- JPEG, PNG, and WebP.
- 250 MB source file.
- 30,000 px maximum side.
- Configurable total-pixel ceiling to prevent decompression bombs.
- Animated images rejected.

Processing steps:

1. Reserve metadata through an authenticated command.
2. Upload directly to a constrained MinIO incoming object.
3. Inspect type, dimensions, animation, and total pixels with `sharp`/libvips.
4. Generate a multiresolution pyramid of 512 px WebP tiles.
5. Produce a manifest with levels, dimensions, checksums, and tile paths.
6. Create a small room/dashboard preview.
7. Atomically mark the asset ready after all required output exists.
8. Retain the original by default for reprocessing.

The renderer requests only visible tiles at the appropriate level. Signed tile URLs are short-lived and returned in batches after room authorization.

### 7.2 Token Ingestion

Token defaults:

- JPEG, PNG, and WebP.
- 25 MB source file.
- Bounded source dimensions and total pixels.
- Normalize to WebP up to 2048 x 2048 while preserving alpha.
- Produce a small palette thumbnail.
- Remove the original after successful processing unless retention is enabled.

Room members may upload token images. The DM controls token ownership, shared movement, and removal of shared assets.

### 7.3 Future Assets

The same provider-neutral metadata supports:

- Animated effects.
- Weather textures.
- Audio if later approved.
- Optional user-uploaded glTF/GLB models after the Ready Player Me integration.
- Building kits.
- Marketplace assets.

Each type receives a separate validator, processor, quota, and authorization policy.

## 8. Rendering Architecture

### 8.1 Tactical Renderer

The default renderer uses an orthographic Three.js camera.

Layers:

1. Background/map tiles.
2. Floors and terrain.
3. Grid.
4. Drawings and templates.
5. Fog and visibility masks.
6. Tokens and labels.
7. Selection handles and measurements.
8. Reachable-cell shading, candidate paths, transient cursors, pings, and drag previews.

Requirements:

- Frustum-based tile selection and cache eviction.
- Pointer-centered wheel and pinch zoom.
- Mouse, pen, and touch pointer events.
- Device-pixel-ratio cap.
- GPU context-loss recovery.
- Texture disposal and object URL cleanup.
- Visible off-map staging area.
- Local per-room camera persistence.
- Accessible inspector alternatives for drag, resize, and rotation.
- Local PathFinding.js previews for reachable, blocked, and over-budget cells, reconciled against the server-approved path and cost.
- A destination-click interaction that coexists with drag setup. Encounter-mode drag resolves through the same destination command rather than a privileged free transform.

### 8.2 Diorama and Immersive Renderer

The 3D renderer consumes the same scene with two local perspective camera controllers: overview/orbit and immersive token-follow. Tactical 2D remains a separate orthographic controller, but all modes render projections of the same canonical scene and switch without rewriting scene data.

- Maps and floors become horizontal planes.
- Wall segments become extruded meshes through `THREE.ExtrudeGeometry`.
- Doors and windows become openings or tagged wall intervals.
- Flat tokens become billboards or discs.
- Ready Player Me GLB avatars replace billboards when available.
- Lights become Three.js light or shader inputs.
- Effects register `three.quarks` particle systems or animated meshes.
- The immersive camera follows the selected or active token from a configurable third-person eye-height offset. Camera smoothing, yaw, pitch, collision avoidance, and reduced-motion behavior remain renderer-local.
- While a server-approved `activePath` is playing, flat tokens use a linear path tween. Ready Player Me avatars use `AnimationMixer` with idle/walk cross-fades when compatible clips are available, then fall back to the same transform tween.

The DM controls whether players may enter 3D mode. A simple Tactical 2D / Overview 3D / Immersive 3D toggle changes only renderer and camera state. Camera state remains local unless a future guided-camera feature explicitly synchronizes it.

Wall extrusion is a deterministic adapter from canonical 2D scene data:

1. Convert each segment and its thickness into a rectangular `THREE.Shape` in floor-plan space.
2. Split or alter the shape for door/window openings and current door state.
3. Pass the shape to `THREE.ExtrudeGeometry` with the segment height.
4. Transform the resulting geometry into the scene's floor/elevation coordinate system.
5. Cache geometry by segment ID, revision, and material parameters; dispose it when invalidated.

If an editor or generator uses SVG as an interchange format, load it with `SVGLoader` and convert paths to `Shape` objects before the same extrusion step. **REPLACED:** neither SVG nor generated meshes become a second persisted 3D data source; the pure 2D points, segments, types, and dimensions remain authoritative.

## 9. Milestone Plans

### Milestone 1: Authenticated Persistent Rooms

Status: implemented.

Delivered:

- Email/password authentication.
- Account-required room access.
- DM room and campaign creation.
- Invite links and code redemption.
- Persistent memberships and roles.
- Lobby roster, activity, and presence.
- RLS-protected reads.
- Idempotent commands and durable event foundation.
- Initial versioned empty scene.

Remaining operational validation:

- Verify hosted email confirmation.
- Verify the currently implemented Supabase presence with two connected browsers before it is replaced.
- Set the real Supabase project URL and publishable key.

**REPLACED going forward:** milestone 1 shipped Supabase Realtime presence and Postgres-oriented command foundations. Milestone 2 migrates lobby presence and all in-room state synchronization to Colyseus. Supabase Auth, room metadata, invitations, RLS, and durable Postgres persistence remain.

### Milestone 2: Tactical Map and Tokens

Detailed plan: [`milestone-2-tactical-map-and-tokens.md`](./milestone-2-tactical-map-and-tokens.md)

Deliverables:

- Self-hosted Colyseus multiplayer service and browser client adapter.
- Supabase JWT verification and room-membership authorization in Colyseus `onAuth`.
- Colyseus Schema state for members, map/grid, tokens with HP fields, typed empty walls, room permissions, versioned fog state, and versioned initiative state.
- Automatic and manual reconnection with a held seat and durable-room fallback.
- MinIO and asset-processing API.
- Large tiled map upload and rendering.
- Orthographic tactical route.
- Camera navigation and map fit/reset.
- Adjustable square grid.
- Token asset palette.
- Token creation, transform, rotation, labels, stacking, and ownership.
- Owned/shared movement authorization.
- Binary delta-synchronized drag state and server-authoritative final transforms.
- Phase 1 grid-movement foundation: pinned PathFinding.js adapter, wall-edge traversal, reachable-cell cost calculation, system-neutral movement allowance state, and server-authoritative destination validation.
- A durable `token.move.commit` command that atomically updates token position and movement budget; drag cannot bypass it when budgeted encounter movement is active.
- Durable revisioned token commands persisted by the Colyseus server.
- Typed wall schema with `blocking`, `terrain`, `ethereal`, and `door` behavior before the wall editor exists.

Release criteria:

- A DM and players can run a basic shared token encounter on a large map.
- Reload and reconnect restore identical authoritative state.
- Unauthorized token movement and asset access fail server-side.
- A dropped client reconnects to the same Colyseus room state; an expired seat rejoins from the durable Postgres snapshot.
- Client and server path calculations agree for the selected diagonal/cost policy, while a forged destination, path, wall revision, or movement cost is rejected.

### Milestone 3: Fog, Drawing, Measurement, Pings, and Initiative

This milestone completes the lean Owlbear-style MVP.

#### Fog of War

Deliver:

- Geometry-based shared player fog mask.
- DM reveal and hide brush.
- Rectangle and polygon reveal/hide tools.
- Undo for the active stroke or shape operation.
- DM translucent preview.
- Optional per-player masks behind a capability flag.

Implementation:

- Store fog as polygonal reveal/hide operations or a normalized polygon set, not a bitmap tied to screen resolution.
- Use stencil buffers or render targets only as renderer caches.
- Persist final strokes/shapes through narrow commands.
- Synchronize in-progress brush previews through Colyseus without persisting every pointer sample.
- Keep DM-only fog geometry out of player State Views where it reveals hidden information.

#### Drawing and Ruler

Deliver:

- Freehand, line, rectangle, ellipse, and polygon annotations.
- Color, width, fill, visibility, and deletion controls.
- Grid-aware ruler with explicit D&D diagonal-distance settings.
- Player and DM drawing permissions.

Persist simplified world-space geometry. Use point reduction for freehand paths before committing them.

#### Pings and Pointers

Deliver:

- Ephemeral map pings.
- Optional live pointer sharing.
- User color/name attribution.
- Automatic expiry and reduced-motion behavior.

Pings and pointers are typed Colyseus room messages and are never written to the scene.

#### Initiative

Deliver:

- Ordered entries linked optionally to tokens or characters.
- Players add and edit their own entries.
- DM adds, reorders, removes, and advances entries.
- Active-turn indicator in the tracker and on the map.
- Round number and turn history events.
- Colyseus Schema synchronization and persistent resume.

Tokens, fog, initiative, and HP are all first-class server-owned Colyseus Schema state by the end of this milestone. Hidden initiative details and HP use per-client State Views rather than client-side concealment.

Initiative activation also resets the active token's system-neutral movement budget. Full player-facing reachable-cell and destination-click interaction remains scheduled for milestone 9, after milestone 4 supplies the immersive scene/camera; milestone 3 may expose only development diagnostics for validating turn integration.

Release criteria:

- A group can run and resume a complete map-based combat session with manual fog, annotations, measurement, pings, and initiative.

### Milestone 4: 3D Buildings and Camera Overview

Deliver as the first optional immersive module.

- 2D wall drawing and editing.
- Wall height, thickness, material, and elevation.
- Floors, roofs, doors, and windows.
- Snap endpoints and detect connected wall topology.
- Lightweight block-based building tools.
- Perspective orbit/overview and third-person token-follow camera controllers.
- Flat tactical, 3D overview, and immersive 3D view switching over one scene.
- Player access toggle for the 3D view.

Architecture:

- Reuse the typed 2D wall segments added to the core scene schema in milestone 2.
- Persist wall points, line segments, type, height, thickness, elevation, and opening intervals rather than meshes.
- Convert each segment into a `THREE.Shape` and extrude it with `THREE.ExtrudeGeometry` using the height parameter.
- Use `SVGLoader` only when SVG paths enter through an editor/import adapter; convert them to `Shape` objects and then run the same extrusion pipeline.
- Keep extrusion a deterministic, side-effect-free conversion from existing 2D scene data; do not maintain a separate 3D wall source.
- Keep materials provider-neutral.
- Reuse Phase 1 pathfinding edge constraints against the now-editable walls. Wall/door revisions invalidate movement previews and cached routes immediately.
- Treat roofs as visibility-aware structures that can hide automatically in tactical or cutaway views.
- Run mesh generation in a worker when scenes become complex.

Release criteria:

- A DM can draw a simple multi-room building in 2D and immediately inspect it in 3D without changing scene data formats.
- Switching camera modes preserves selection and authoritative movement state; the immersive camera can follow a flat fallback token before avatars exist.

### Milestone 5: Line of Sight and Lighting Foundation

**REPLACED:** movement collision is no longer introduced here. Milestone 2 already establishes wall-aware path traversal for authoritative movement; this milestone adds sight, fog, and lighting consumption of the same behavior table.

Deliver:

- Wall-aware 2D line-of-sight polygons.
- `blocking` walls blocking sight and movement.
- `terrain` walls blocking sight but not movement.
- `ethereal` walls blocking movement but not sight.
- Doors toggling between `open`, `closed`, and `locked`, with centralized sight/movement behavior.
- Token vision origins and ranges.
- Shared and optional per-player visibility.
- 3D ray/occlusion inputs generated from wall geometry.
- Light source data shared by tactical and diorama renderers.

Implementation sequence:

1. Implement deterministic 2D visibility against wall segments.
2. Integrate doors and windows.
3. Use worker-based recalculation and spatial indexes.
4. Connect visibility to fog exploration state.
5. Add 3D occlusion using generated wall meshes and renderer acceleration structures.

Release criteria:

- Visibility updates when a token moves or a door changes state, without exposing hidden tokens or private geometry to unauthorized players.

### Milestone 6: DM Analytics and Session Tools

#### Combat Sessions

Deliver:

- Explicit session start/end.
- Session timer and pause state.
- Persistent encounter and turn history.
- Searchable combat activity log.
- Session summaries across past sessions.

Events become the source for derived analytics. Build projections rather than embedding analytics state in tactical scene data.

#### Encounter Builder

Deliver:

- Open5e API v2 search and filtering for creatures, spells, and items.
- Pre-staged monsters and NPC templates created from normalized Open5e creature records.
- System-neutral stat block envelope.
- Drag from encounter tray to map.
- Current/max HP, temporary HP, and conditions.
- Per-field player visibility controls.
- Duplicate and group operations.

**REPLACED:** do not build or maintain a local 5e content database. Add an `Open5eProvider` adapter that calls API v2 and caches normalized responses per campaign/session in Postgres. Cache the Open5e key, source document, game system, fetched timestamp, attribution/license metadata, normalized fields, and original response version. Active encounters retain a snapshot so an upstream content change cannot alter a running session.

Open5e integration rules:

- Proxy requests through the trusted server to centralize caching, source filters, timeouts, and rate limits.
- Use `/v2/creatures`, `/v2/spells`, and `/v2/items`; request only fields needed by the UI.
- Apply an approved source-document allowlist because Open5e aggregates differently licensed publishers and game systems.
- Show source attribution in search results and stat blocks.
- Keep Open5e descriptions out of Colyseus Schema; synchronize compact encounter references and mutable combat fields such as HP.
- Serve cached records when Open5e is temporarily unavailable.
- Keep the encounter envelope provider-neutral so another rules/content provider can be added later.

#### Notes and Secrets

Deliver:

- Private DM notes pinned to world coordinates.
- DM-only tokens and areas.
- Campaign notes independent of a room.
- Explicit reveal action that creates a shared record rather than changing read policy in place.

#### Engagement Statistics

Optional and disabled by default:

- Average turn duration.
- Time since player interaction.
- Participation counts.

Before release, define purpose, retention, player visibility, deletion, and consent. Do not present engagement metrics as objective measures of player quality.

Release criteria:

- The DM can prepare and run an encounter, track combat state, keep private notes, and review a reliable session summary.

### Milestone 7: Dynamic Effects

#### Area-of-Effect Templates

Deliver:

- Cone, sphere/circle, line, and cube templates.
- 5e-compatible dimension presets without hardcoding all logic to 5e.
- Drag placement, rotation, grid snapping, and affected-cell preview.
- Persistent and ephemeral placement modes.

#### Dynamic Lighting

Deliver:

- Point, directional, cone, magical darkness, and dim-light sources.
- Wall and door occlusion.
- Tactical light masks and 3D renderer lights.
- Quality settings for low-powered devices.

#### Spell Effects

Deliver:

- `three.quarks` as the Three.js particle/VFX runtime.
- Reusable fire, ice, lightning, and healing effects authored through the Quarks editor workflow.
- Versioned JSON import/export for effect definitions and a validated effect registry.
- Duration, scale, color, attachment, and loop controls.
- Reduced-motion and disable-effects preferences.
- Renderer resource limits and pooled particles.

**REPLACED:** do not build a custom particle engine. Pin compatible `three`, `@react-three/fiber`, and `three.quarks` versions, use one `BatchedRenderer`, validate imported effect JSON, and keep effect texture references provider-neutral.

Connect Open5e spells to effects through a curated mapping registry keyed by Open5e document/key, with optional fallback rules based on damage type, school, and shape. When a selected spell has a cone, sphere/circle, line, or cube template, placement commits the template and sends an effect trigger containing only effect ID, transform, seed, start time, and duration. Clients instantiate the matching `three.quarks` JSON locally; particle instances are not synchronized individually. Unknown or incomplete Open5e spell shapes fall back to manual template selection rather than guessing.

#### Weather

Deliver:

- Rain, fog, embers, and snow overlays.
- Intensity, direction, color, and speed.
- DM-controlled player visibility.
- Independent tactical and diorama implementations driven by shared effect data.

Release criteria:

- Templates remain tactically accurate while lighting and effects degrade gracefully on low-end or reduced-motion clients.

### Milestone 8: Character Overview and Rules

#### Character Overview

Deliver:

- Character record linked to a player and optional token.
- HP, temporary HP, AC, speed, conditions, abilities, saves, and inventory summary.
- Player editing and DM summary access.
- Explicit field-level visibility.
- Quick-reference panel beside the tactical map.

#### Rules Decision Gate

Do not implement edition-sensitive behavior until these are approved:

- 2014 or 2024 D&D 5e.
- Licensed or permitted rules content source.
- Whether attacks resolve automatically against AC.
- Whether conditions modify rolls or remain labels.
- Critical hit behavior.
- Resistance, vulnerability, immunity, and temporary HP behavior.
- Concentration checks.
- Spell slot and spell resolution scope.
- Whether non-5e rooms remain fully supported.

#### First Rules Increment

After the gate is resolved, deliver:

- Shared dice rolls and roll log.
- Ability checks and saving throws.
- Attack rolls.
- Advantage and disadvantage.
- Manual damage and healing.
- HP and temporary HP bookkeeping.
- Condition tracking.

Use a system-neutral rules interface with a 5e adapter. Scene/token movement cannot depend on the 5e package.

Release criteria:

- Players can maintain a compact character summary and execute the approved combat basics while system-neutral rooms continue working.

### Milestone 9: Ready Player Me Character Models

Deliver:

- Ready Player Me API integration and application/subdomain configuration.
- Embeddable Avatar Creator through the React SDK or a sandboxed iframe.
- Strictly validated `postMessage` events and allowed Ready Player Me origins.
- Capture and persist the returned Ready Player Me `.glb` URL and avatar metadata.
- Load the GLB URL directly with the Three.js `GLTFLoader` in the 3D scene.
- 3D model attachment to a token.
- Scale, facing, elevation, animation selection, and fallback image.
- Flat token image remains authoritative in tactical view unless explicitly configured otherwise.
- Resolve and validate compatible idle/walk clips, then drive them through Three.js `AnimationMixer` with cross-fades while a server-approved path is active.
- Match animation playback rate to path movement speed and stop or return to idle when movement completes, is rejected, or is interrupted.
- Fall back to deterministic linear path tweening for flat tokens, missing clips, incompatible skeletons, reduced-motion mode, or failed model loads.

#### Immersive Click-to-Move Activation

Activate the complete presentation after the Phase 1 movement authority and milestone 4 camera/wall renderer are available:

- Selecting an eligible token highlights all reachable cells within its remaining server-owned allowance.
- Hover/focus previews the cheapest candidate path and cost; clicking submits only the destination and expected revisions.
- The server recomputes PathFinding.js A*, persists the accepted path/cost/budget, and Colyseus synchronizes playback state.
- Tactical 2D animates the token along the accepted path; Immersive 3D follows it with the third-person camera and uses the Ready Player Me walk loop when available.
- Keyboard and touch users can select a destination from the reachable-cell set without requiring precise pointer drag.
- Drag remains available for setup and as destination input, but budgeted encounter movement always passes through the same path command.

Security:

- Accept messages only from configured Ready Player Me origins and expected event types.
- Validate returned URLs against HTTPS and the Ready Player Me host allowlist before persistence or loading.
- Apply renderer-side model, animation, texture, and memory budgets.
- Record user consent and required Ready Player Me terms/privacy links in the avatar flow.
- Preserve the 2D token fallback if Ready Player Me or its model URL is unavailable.

**REPLACED:** arbitrary user GLB/glTF upload, sanitization, and server-side model processing are no longer day-one requirements for this feature. Add custom model uploads later as a separate optional asset type with independent validation, quotas, private storage, and security review.

Release criteria:

- A valid model appears in the 3D view, while unsupported devices and the tactical view retain a functional 2D fallback.
- Tactical and immersive clients play the same accepted route, enforce the same remaining movement, and recover the active/final path state after reconnect.

### Milestone 10: Procedural Maps and Dungeons

All generators are deterministic producers of normal scene data.

#### Terrain Generator

Deliver:

- Seeded forest, ruins, cave, and open-terrain presets.
- Terrain regions, obstacles, paths, and scatter assets.
- Parameter controls and deterministic preview.
- Commit generated output as editable scene entities.

#### Dungeon Generator

Deliver:

- Seeded, configurable room-and-corridor generation using the `dungeon-generator` npm package by domasx2.
- Cellular-automata cave generation.
- Door, wall, floor, and encounter-marker output.
- Connectivity validation and spawn/exit guarantees.
- Export directly into tactical and 3D-compatible scene geometry.

Implementation:

- Run generation in Web Workers.
- Wrap `dungeon-generator` in a provider adapter; never expose its grid/child-object output directly to the editor.
- Map its grid, rooms, corridors, and child objects into the same floor, typed wall-segment, door, and marker scene records produced by manual tools.
- Pin the exact package version and add deterministic compatibility fixtures before relying on it.
- Treat package compatibility as a required spike: the published package is version `0.0.1` from 2016 and declares no tests.
- Persist seed and parameters for reproducibility.
- Store generated entities individually after acceptance.
- Use the standard editor for all post-generation changes.

**REPLACED:** do not introduce a generator-specific persisted model. Generated output is converted immediately to canonical 2D scene geometry, after which the same tactical renderer, wall behavior, `THREE.ExtrudeGeometry` adapter, fog tools, and manual editor apply.

License constraint: `JavaScript-DnD-Dungeon-Generator` / Mystic Waffle uses CC BY-NC. It may be reviewed as reference or inspiration, but its code or assets must not be reused if the application may be commercial. Record package licenses in dependency documentation and preserve the MIT notice for `dungeon-generator`.

Release criteria:

- A generated dungeon can be edited with normal map, wall, token, fog, and building tools and rendered in both tactical and diorama modes.

### Milestone 11: City Generation

Deliver as a distinct higher-level generator:

- Seeded roads, blocks, districts, parcels, and landmarks.
- Terrain-aware road routing.
- Density and district-style parameters.
- Building footprints compatible with the building module.
- Separate tactical-detail and overview-detail outputs.
- Progressive generation and cancellation.

City generation must not reuse dungeon assumptions about scale, connectivity, or encounter density.

Release criteria:

- A generated city can serve as an overview map, and selected blocks can be expanded into editable tactical scenes.

### Milestone 12: Community Assets and Marketplace

Do not begin until authentication, moderation, storage cost, licensing, and monetization are explicitly decided.

Potential scope:

- Publish/unpublish workflow.
- Asset metadata, tags, previews, versions, and compatibility.
- Search and collections.
- Attribution and licenses.
- Reporting and moderation.
- Malware/content review pipeline.
- Creator ownership and takedown handling.
- Entitlements and purchase records if paid assets are approved.
- Importing a marketplace asset creates a room-scoped reference or licensed copy without changing scene formats.

Release criteria cannot be finalized before the decision gate below.

## 10. Cross-Cutting User Experience

Every milestone must support:

- Desktop and mobile layouts.
- Keyboard navigation for non-spatial controls.
- Inspector alternatives for precision transforms.
- Touch-sized controls.
- Visible save, processing, connection, and conflict states.
- Reduced-motion preferences.
- Recoverable renderer and network failures.
- Empty, loading, denied, and stale-state views.
- Clear separation of DM-only and player-visible state.
- Autosave with authoritative confirmation.

Spatial interactions that cannot be fully replicated with a keyboard must expose equivalent numeric or list-based controls where practical.

## 11. Testing Strategy

### Unit Tests

Cover:

- Scene parsing and migrations.
- Persisted DTO to Colyseus Schema conversion in both directions.
- Coordinate conversion and camera math.
- Grid snapping and distance rules.
- PathFinding.js adapter behavior, reachable-cell sets, diagonal/path costs, wall-edge traversal, large-token footprints, occupancy, and deterministic client/server agreement.
- Geometry and visibility algorithms.
- Every typed wall and door-state sight/movement behavior.
- Deterministic wall-segment to `THREE.Shape` and `ExtrudeGeometry` parameters.
- Command validation and event reducers.
- Server-authoritative movement-budget reset, spend, stale-revision rejection, DM override, and atomic position/budget persistence.
- Generator determinism and invariants.
- Open5e normalization and source-document filtering.
- `three.quarks` effect JSON validation and spell-effect mapping.
- Extension manifest and iframe message validation.
- Edition-specific rules behavior after approval.

### Database Integration Tests

Apply real migrations to PostgreSQL-compatible test infrastructure and verify:

- RLS visibility matrices.
- Role and ownership enforcement.
- Direct-write denial.
- Command idempotency.
- Revision conflicts.
- Event/state atomicity.
- Private DM data isolation.
- Asset metadata and quota rules.
- Module table isolation.
- Open5e cache isolation, provenance, expiry, and active-encounter snapshots.

### Colyseus Integration Tests

Start real test rooms and verify:

- Supabase JWT and durable membership authorization in `onAuth`.
- DM, owner, shared-movement, and nonmember command permissions.
- Binary Schema patches for tokens, typed walls, fog, initiative, and HP.
- Per-client State Views never serialize hidden HP, fog, notes, or secret tokens.
- Invalid, stale, duplicated, and unauthorized messages do not mutate state.
- Forged paths, understated costs, blocked destinations, stale wall graphs, and over-budget movement are rejected; the server accepts only its recomputed route.
- Final commands persist before success acknowledgement and roll back live state on failure.
- Automatic reconnection retains the client seat and synchronizes missed changes.
- Manual reconnection restores callbacks and current state after page reload.
- Expired reconnection falls back to a new authenticated join backed by the Postgres snapshot.
- Room disposal flushes checkpoints and a restarted process reconstructs the same state.

### Asset Tests

Use valid, malformed, truncated, animated, oversized, and decompression-bomb fixtures. Verify deterministic output, cleanup, authorization, and interrupted-job recovery.

### Renderer Tests

Test pure scene-to-render projections separately from WebGL. Add fixed-scene screenshots for tactical and diorama smoke tests. Verify texture disposal, context recovery, tile selection, reachable-cell/path overlays, wall extrusion, camera-mode switching, immersive follow behavior, Ready Player Me idle/walk fallback, `three.quarks` batching, and quality fallback.

### Browser Tests

Use Playwright for:

- Authentication and invitations.
- DM/player permission differences.
- Map and asset workflows.
- Token, fog, drawing, initiative, and builder interactions.
- Mobile viewport behavior.
- Reload and reconnect recovery.
- Module enable/disable behavior.
- Sandboxed extension origin, permission, toolbar action, and `postMessage` behavior.
- Open5e cached/offline behavior and source attribution.
- Ready Player Me completion events with a mocked allowed origin and rejection from an unknown origin.
- Reachable-cell highlighting, destination click/keyboard selection, server route reconciliation, movement interruption, tactical/immersive camera switching, and reconnect during path playback.

### Connected Tests

Mocked tests cannot prove hosted email, Colyseus WebSockets, or third-party API availability. Before each release, run at least two browser profiles against the configured development services and test Schema synchronization, persistence, automatic/manual reconnects, State View privacy, and denied operations. Open5e and Ready Player Me receive separate contract smoke tests that do not make the normal automated suite depend on their uptime.

### Performance Budgets

Establish measurable budgets per milestone:

- Initial dashboard JavaScript excludes renderer and module bundles.
- Tactical renderer is lazy-loaded.
- Camera movement remains responsive while tiles stream.
- Pointer previews do not trigger React renders for every event.
- Colyseus patch bytes, patch frequency, room memory, and reconnect duration are measured with representative scenes.
- Visibility and generation jobs are cancellable workers.
- Texture memory and particle counts have hard caps.
- Event and snapshot sizes are logged in development.

Exact frame-time and scale targets require representative fixtures and production device requirements.

## 12. Deployment Environments

### Local Development

- Vite web application.
- Hosted or local Supabase.
- Docker Compose self-hosted Colyseus, MinIO, and asset API.
- Local asset volume.
- Local email viewer when using Supabase CLI.
- Stubbed Open5e and Ready Player Me contract fixtures for deterministic tests.

### Shared Development

- Hosted Supabase Free project.
- Self-hosted Colyseus Node.js service over HTTPS/WSS.
- Privately reachable MinIO and asset API with HTTPS.
- Explicit CORS origins.
- Development-only quotas and cleanup.
- No assumption of production durability.

### Production Decision Gate

Before a public launch, decide:

- Expected concurrent rooms and players.
- Geographic latency requirements.
- Asset storage provider and region.
- CDN and private tile-delivery strategy.
- Backups and disaster recovery.
- Queue and worker scaling.
- Colyseus process/room topology, presence driver, load balancing, and sticky connection requirements.
- Database connection quotas and snapshot/event throughput.
- Whether to remain self-hosted or adopt Colyseus Cloud.
- Domain, TLS, monitoring, and alerting.
- Account deletion and data export.
- Abuse prevention and rate limits.
- Monetization and entitlement model.

Do not treat the development MinIO volume as a production backup strategy.

## 13. Observability and Operations

Add incrementally:

- Structured request and command logs with correlation IDs.
- Asset job duration, failure, and output-size metrics.
- Colyseus active room/client counts, patch bytes, disconnects, reconnections, and failed joins.
- Command rejection and revision-conflict counters.
- Snapshot latency, checkpoint failures, and room restore duration.
- Open5e request/cache/error metrics without logging licensed content bodies.
- Effect counts, particle budgets, and renderer degradation decisions.
- Extension load, permission denial, timeout, and crash metrics.
- Client error boundaries and opt-in error reporting.
- Database migration and deployment logs.
- Health endpoints for asset API, MinIO access, and worker readiness.
- Cleanup reports for stale uploads and orphaned assets.

Never log access tokens, invitation codes, signed URLs, private notes, character secrets, or raw uploaded file contents.

## 14. Data Lifecycle

Development defaults must still establish lifecycle rules:

- Rooms and campaigns persist until explicitly deleted.
- Deleting a room schedules its private assets for deletion.
- Pending uploads expire and are cleaned up.
- Failed processing output is removed.
- Event history has a documented retention policy before analytics launch.
- Originals and derived files have separate retention settings.
- Account deletion removes or transfers owned campaigns through an explicit workflow.
- Marketplace publication never becomes the only copy of a creator's source without consent.

Deletion work must be idempotent and retryable across Postgres and object storage.

## 15. Open Questions and Decision Gates

### Remaining Open Questions

- **Hosting scale:** Colyseus is self-hosted for development and MVP. Expected concurrent rooms/players, regions, process topology, and the threshold for Colyseus Cloud remain undefined.
- **Dice and rules automation:** shared rolls and combat basics are desired, but 2014 versus 2024 rules and the exact automation boundary remain unresolved. Open5e supplies content; it does not decide or implement the game engine behavior.
- **Asset storage:** development storage is resolved as MinIO with 250 MB map and 25 MB token limits. Production provider, capacity, CDN, retention, backups, and cost controls remain unresolved.
- **Authentication and monetization:** Supabase accounts are required for DMs and players. Social providers, account recovery policy, anonymous guests, subscriptions, paid tiers, and entitlements remain unresolved.
- **Movement rules:** decide the diagonal cost convention, whether tokens block cells, how squeezing and tokens larger than one cell behave, how terrain may later express difficult movement cost, and whether the DM can override or edit a movement budget.
- **Pre-character speed:** confirm the default/manual system-neutral allowance and reset behavior before milestone 8 supplies character speed; movement cannot depend directly on `rules-5e`.
- **Ethereal consistency:** the canonical table currently makes `ethereal` block movement but not sight. Confirm this interpretation because the click-to-move request also described `ethereal` as non-blocking movement; until resolved, the canonical table governs pathfinding.
- **Pathfinding package:** `pathfinding`/PathFinding.js is selected, but pinning requires a compatibility spike covering maintenance status, license, bundle/server cost, deterministic behavior, and custom wall-edge neighbors.
- **Avatar locomotion:** select and license an idle/walk animation source compatible with Ready Player Me avatars, and define retargeting support when returned GLBs do not contain those clips.

### Before Milestone 8 Rules Automation

- Select 2014 or 2024 5e rules.
- Approve the rules content source and license.
- Approve the Open5e source-document allowlist and attribution presentation.
- Define attack, damage, condition, concentration, spell, and automation behavior.
- Confirm whether system-neutral rooms are a permanent requirement.

### Before Public Hosting

- Set room/player concurrency targets.
- Load-test self-hosted Colyseus and define the measurable threshold for Colyseus Cloud or horizontal scaling.
- Select production asset hosting and CDN strategy.
- Define quotas, file retention, backup, and recovery.
- Define authentication providers and account recovery.
- Define monetization and paid tiers.
- Add privacy policy, terms, export, and deletion behavior.

### Before Engagement Analytics

- Define player visibility and consent.
- Define retention and deletion.
- Confirm which metrics are genuinely useful and non-punitive.

### Before Marketplace Work

- Define free versus paid assets.
- Define creator identity, licensing, attribution, moderation, and takedowns.
- Select payment and tax providers if paid assets are included.

## 16. Definition of Done

Every milestone is complete only when:

- Acceptance criteria pass.
- TypeScript and production builds pass.
- Unit, database, and relevant browser tests pass.
- Connected realtime acceptance passes where applicable.
- Colyseus server-state, reconnect, persistence, and State View privacy tests pass where applicable.
- Migrations include authorization and rollback/recovery consideration.
- New private data is proven inaccessible to unauthorized accounts.
- Loading, empty, error, reconnect, and denied states are implemented.
- Desktop and mobile behavior is verified.
- Documentation and environment templates are updated.
- No credentials or provider-specific signed URLs are persisted in scene data.
- Jira status and completion comment are updated when Jira access exists.

## 17. Immediate Next Actions

1. Configure the real Supabase project and complete milestone 1 connected acceptance.
2. Create the Jira task `[Realtime] Migrate room authority to Colyseus` in project `SCRUM` when Jira access is available.
3. Revise and execute the detailed milestone 2 plan, starting with Colyseus Schema, persistence, typed empty walls, and reconnection.
4. Run the PathFinding.js compatibility spike and approve diagonal, occupancy, footprint, and pre-character allowance rules before freezing the movement command contract.
5. Release the tactical map, token, and authoritative movement-foundation slice before beginning fog or 3D work.
6. Implement milestone 3 to complete the lean battle-map MVP and connect initiative to authoritative movement-budget resets; activate the complete player-facing click-to-move interaction in milestone 9 after the milestone-4 immersive renderer exists.

## 18. Work Tracking

Jira access was unavailable when this plan was written. No ticket was created or transitioned.

Suggested current ticket:

- Project: `SCRUM`
- Type: Story
- Title: `[Realtime] Migrate room authority to Colyseus`
- Status: In Progress when implementation begins
- Description: Replace in-room Supabase Realtime/Postgres Changes assumptions with authoritative Colyseus Schema state, Supabase-authenticated room joins, durable Postgres snapshots/events, reconnection, and typed wall foundations. Use the linked milestone 2 plan for acceptance criteria.

Complex later milestones that touch three or more layers should receive separate linked tickets for database, backend/processing, renderer, and UI work rather than one oversized ticket.

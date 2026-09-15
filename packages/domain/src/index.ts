import { z } from 'zod';
import { fogOperationSchema, initiativeEntrySchema, pointSchema, sizeSchema, structureIdSchema, structureRecordInputSchema, tokenRecordSchema, wallIdSchema, wallRecordInputSchema } from '@hearth/scene';

export const displayNameSchema = z.string().trim().min(1).max(40);
export const createRoomSchema = z.object({
  name: z.string().trim().min(1, 'Give your room a name.').max(80),
  campaignName: z.string().trim().min(1, 'Give your campaign a name.').max(80),
});
export const inviteCodeSchema = z.string().trim().toLowerCase()
  .regex(/^[a-f0-9]{32}$/, 'Enter the 32-character invite code shared by your DM.');
export const commandResultSchema = z.object({ room_id: z.uuid() });
export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type RoomRole = 'dm' | 'player';

export interface Campaign {
  id: string;
  name: string;
  owner_id: string;
}
export interface Room {
  id: string;
  campaign_id: string;
  name: string;
  created_by: string;
  created_at: string;
  revision: number;
}
export interface RoomMember {
  room_id: string;
  user_id: string;
  role: RoomRole;
  display_name: string;
  joined_at: string;
}
export interface RoomEvent {
  id: number;
  room_id: string;
  actor_id: string;
  type: 'room.created' | 'member.joined';
  payload: Record<string, unknown>;
  created_at: string;
}

// Keep the game-facing API independent of the hosted transport.
export interface RoomCommands {
  createRoom(input: CreateRoomInput, commandId: string): Promise<string>;
  joinRoom(code: string, commandId: string): Promise<string>;
}

// Shared wire templates. Keeping these in domain makes client and server validation identical.
export const ZBox = {
  id: z.string().min(1).max(128),
  commandId: z.uuid(),
  finite: z.number().finite(),
  positive: z.number().finite().positive(),
  tokenRevision: z.number().int().min(0).max(0xffff_ffff),
  point: pointSchema,
  size: sizeSchema,
} as const;
export const ZodBox = ZBox;

const envelope = <T extends z.ZodType>(payload: T) => z.object({
  commandId: ZBox.commandId,
  payload,
}).strict();

export const mapSetCommandSchema = envelope(z.object({
  map: z.object({ assetId: ZBox.id, width: ZBox.positive, height: ZBox.positive }).strict().nullable(),
}).strict());
export const gridSetCommandSchema = envelope(z.object({
  visible: z.boolean(),
  cellSize: ZBox.positive,
  offset: ZBox.point,
  distancePerCell: ZBox.positive,
  unit: z.enum(['ft', 'm']),
  snap: z.boolean(),
}).strict());
export const playerMovementSetCommandSchema = envelope(z.object({
  playerMovement: z.enum(['owned', 'all']),
}).strict());
export const playerDrawingSetCommandSchema = envelope(z.object({
  playerDrawing: z.enum(['none', 'own', 'all']),
}).strict());
export const playerPerspectiveViewSetCommandSchema = envelope(z.object({
  enabled: z.boolean(),
}).strict());
export const tokenCreateCommandSchema = envelope(z.object({
  token: tokenRecordSchema.omit({ revision: true }).extend({ revision: z.literal(0).optional() }),
}).strict());
export const tokenTransformPreviewSchema = z.object({
  tokenId: ZBox.id,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  position: ZBox.point,
  rotation: ZBox.finite,
}).strict();
export const tokenTransformCommitSchema = envelope(tokenTransformPreviewSchema.omit({ sequence: true }).extend({
  expectedTokenRevision: ZBox.tokenRevision,
}));
export const tokenMoveCommitSchema = envelope(z.object({
  tokenId: ZBox.id,
  destination: z.object({ column: z.number().int(), row: z.number().int() }).strict(),
  expectedTokenRevision: ZBox.tokenRevision,
  expectedNavigationRevision: ZBox.tokenRevision,
  expectedMovementRevision: ZBox.tokenRevision,
}).strict());
export const tokenDetailsUpdateCommandSchema = envelope(z.object({
  tokenId: ZBox.id,
  expectedTokenRevision: ZBox.tokenRevision,
  details: z.object({
    label: z.string().max(200).optional(),
    ownerId: z.string().max(128).optional(),
    hpCurrent: ZBox.finite.nonnegative().optional(),
    hpMaximum: ZBox.finite.nonnegative().optional(),
    hpHidden: z.boolean().optional(),
    size: ZBox.size.optional(),
    z: ZBox.finite.optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, 'At least one detail is required.'),
}).strict());
export const tokenDeleteCommandSchema = envelope(z.object({
  tokenId: ZBox.id,
  expectedTokenRevision: ZBox.tokenRevision,
}).strict());
export const wallCreateCommandSchema = envelope(z.object({
  wall: wallRecordInputSchema,
  expectedWallRevision: ZBox.tokenRevision,
}).strict());
export const wallUpdateCommandSchema = envelope(z.object({
  wall: wallRecordInputSchema,
  expectedWallRevision: ZBox.tokenRevision,
  expectedRecordRevision: ZBox.tokenRevision,
}).strict());
export const wallDeleteCommandSchema = envelope(z.object({
  wallId: wallIdSchema,
  expectedWallRevision: ZBox.tokenRevision,
  expectedRecordRevision: ZBox.tokenRevision,
}).strict());
export const structureCreateCommandSchema = envelope(z.object({
  structure: structureRecordInputSchema,
  expectedStructureRevision: ZBox.tokenRevision,
}).strict());
export const structureUpdateCommandSchema = envelope(z.object({
  structure: structureRecordInputSchema,
  expectedStructureRevision: ZBox.tokenRevision,
  expectedRecordRevision: ZBox.tokenRevision,
}).strict());
export const structureDeleteCommandSchema = envelope(z.object({
  structureId: structureIdSchema,
  expectedStructureRevision: ZBox.tokenRevision,
  expectedRecordRevision: ZBox.tokenRevision,
}).strict());
export const initiativeEntryAddCommandSchema = envelope(z.object({
  entry: initiativeEntrySchema,
  expectedInitiativeRevision: ZBox.tokenRevision,
}).strict());
export const initiativeEntryUpdateCommandSchema = envelope(z.object({
  entryId: ZBox.id,
  expectedInitiativeRevision: ZBox.tokenRevision,
  details: z.object({
    label: z.string().max(200).optional(),
    score: ZBox.finite.optional(),
    hidden: z.boolean().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, 'At least one initiative detail is required.'),
}).strict());
export const initiativeEntryRemoveCommandSchema = envelope(z.object({
  entryId: ZBox.id,
  expectedInitiativeRevision: ZBox.tokenRevision,
}).strict());
export const initiativeReorderCommandSchema = envelope(z.object({
  entryIds: z.array(ZBox.id).max(1_000),
  expectedInitiativeRevision: ZBox.tokenRevision,
}).strict());
const initiativeLifecycleCommandSchema = envelope(z.object({
  expectedInitiativeRevision: ZBox.tokenRevision,
}).strict());
export const initiativeStartCommandSchema = initiativeLifecycleCommandSchema;
export const initiativeAdvanceCommandSchema = initiativeLifecycleCommandSchema;
export const initiativeStopCommandSchema = initiativeLifecycleCommandSchema;
export const fogOperationCommitCommandSchema = envelope(z.object({
  operation: fogOperationSchema.omit({ playerId: true, revision: true }).extend({
    points: z.array(pointSchema).min(3).max(2_048),
  }),
  expectedFogRevision: ZBox.tokenRevision,
}).strict());
export const fogUndoCommandSchema = envelope(z.object({
  expectedFogRevision: ZBox.tokenRevision,
  expectedOperationId: ZBox.id.optional(),
}).strict());
export const fogClearCommandSchema = envelope(z.object({
  expectedFogRevision: ZBox.tokenRevision,
}).strict());
export const drawingCreateCommandSchema = envelope(z.object({
  drawing: z.object({
    id: ZBox.id,
    kind: z.enum(['line', 'polygon']),
    points: z.array(pointSchema).min(2).max(4_096),
    color: z.string().min(1).max(64),
    width: ZBox.positive,
    fill: z.string().min(1).max(64).nullable().default(null),
    hidden: z.boolean().default(false),
    z: ZBox.finite,
  }).strict(),
  expectedDrawingRevision: ZBox.tokenRevision,
}).strict());
export const drawingUpdateCommandSchema = envelope(z.object({
  drawingId: ZBox.id,
  expectedDrawingRevision: ZBox.tokenRevision,
  expectedRecordRevision: ZBox.tokenRevision,
  details: z.object({
    color: z.string().min(1).max(64).optional(),
    width: ZBox.positive.optional(),
    fill: z.string().min(1).max(64).nullable().optional(),
    hidden: z.boolean().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, 'At least one drawing detail is required.'),
}).strict());
export const drawingDeleteCommandSchema = envelope(z.object({
  drawingId: ZBox.id,
  expectedDrawingRevision: ZBox.tokenRevision,
  expectedRecordRevision: ZBox.tokenRevision,
}).strict());
export const mapPingSchema = z.object({
  id: ZBox.id,
  position: pointSchema,
}).strict();
export const mapPingEventSchema = mapPingSchema.extend({
  userId: ZBox.id,
  displayName: displayNameSchema,
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  serverTimeMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().nonnegative(),
}).strict();
export type MapPingInput = z.input<typeof mapPingSchema>;
export type MapPingEvent = z.output<typeof mapPingEventSchema>;
export const assetReserveCommandSchema = envelope(z.object({
  kind: z.enum(['map', 'token']),
  sourceMetadata: z.record(z.string(), z.json()).default({}),
}).strict());

export const multiplayerCommandSchemas = {
  'map.set': mapSetCommandSchema,
  'grid.set': gridSetCommandSchema,
  'permissions.playerMovement.set': playerMovementSetCommandSchema,
  'permissions.playerDrawing.set': playerDrawingSetCommandSchema,
  'permissions.playerPerspectiveView.set': playerPerspectiveViewSetCommandSchema,
  'token.create': tokenCreateCommandSchema,
  'token.transform.preview': tokenTransformPreviewSchema,
  'token.transform.commit': tokenTransformCommitSchema,
  'token.move.commit': tokenMoveCommitSchema,
  'token.details.update': tokenDetailsUpdateCommandSchema,
  'token.delete': tokenDeleteCommandSchema,
  'wall.create': wallCreateCommandSchema,
  'wall.update': wallUpdateCommandSchema,
  'wall.delete': wallDeleteCommandSchema,
  'structure.create': structureCreateCommandSchema,
  'structure.update': structureUpdateCommandSchema,
  'structure.delete': structureDeleteCommandSchema,
  'initiative.entry.add': initiativeEntryAddCommandSchema,
  'initiative.entry.update': initiativeEntryUpdateCommandSchema,
  'initiative.entry.remove': initiativeEntryRemoveCommandSchema,
  'initiative.reorder': initiativeReorderCommandSchema,
  'initiative.start': initiativeStartCommandSchema,
  'initiative.advance': initiativeAdvanceCommandSchema,
  'initiative.stop': initiativeStopCommandSchema,
  'fog.operation.commit': fogOperationCommitCommandSchema,
  'fog.undo': fogUndoCommandSchema,
  'fog.clear': fogClearCommandSchema,
  'drawing.create': drawingCreateCommandSchema,
  'drawing.update': drawingUpdateCommandSchema,
  'drawing.delete': drawingDeleteCommandSchema,
  'asset.reserve': assetReserveCommandSchema,
} as const;

export type MultiplayerCommandName = keyof typeof multiplayerCommandSchemas;
export type MultiplayerCommand<T extends MultiplayerCommandName> = z.output<(typeof multiplayerCommandSchemas)[T]>;

export * from './projection.js';

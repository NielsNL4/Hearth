import { z } from 'zod';
import { pointSchema, sizeSchema, tokenRecordSchema } from '@hearth/scene';

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
export const assetReserveCommandSchema = envelope(z.object({
  kind: z.enum(['map', 'token']),
  sourceMetadata: z.record(z.string(), z.json()).default({}),
}).strict());

export const multiplayerCommandSchemas = {
  'map.set': mapSetCommandSchema,
  'grid.set': gridSetCommandSchema,
  'permissions.playerMovement.set': playerMovementSetCommandSchema,
  'token.create': tokenCreateCommandSchema,
  'token.transform.preview': tokenTransformPreviewSchema,
  'token.transform.commit': tokenTransformCommitSchema,
  'token.details.update': tokenDetailsUpdateCommandSchema,
  'token.delete': tokenDeleteCommandSchema,
  'asset.reserve': assetReserveCommandSchema,
} as const;

export type MultiplayerCommandName = keyof typeof multiplayerCommandSchemas;
export type MultiplayerCommand<T extends MultiplayerCommandName> = z.output<(typeof multiplayerCommandSchemas)[T]>;

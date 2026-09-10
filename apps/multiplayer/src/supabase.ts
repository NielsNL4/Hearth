import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { parseSceneV2 } from '@hearth/scene';
import { z } from 'zod';
import type { AuthProvider, Persistence } from './contracts.js';

const loadResult = z.object({ room_id: z.uuid(), scene_revision: z.number().int().nonnegative(), scene: z.unknown() });
const commitResult = z.object({ room_id: z.uuid(), scene_revision: z.number().int().nonnegative(), event_id: z.number().int() });
const reserveResult = z.object({
  id: z.uuid(), room_id: z.uuid(), status: z.string(), source_object_key: z.string(), output_object_prefix: z.string(),
});
const roomAssetResult = z.object({
  id: z.uuid(),
  room_id: z.uuid(),
  kind: z.enum(['map', 'token']),
  status: z.enum(['reserved', 'uploading', 'processing', 'ready', 'failed']),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});

export function createSupabaseServices(url: string, serviceRoleKey: string): { auth: AuthProvider; persistence: Persistence } {
  const client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return createSupabaseServicesFromClient(client);
}

export function createSupabaseServicesFromClient(client: SupabaseClient): { auth: AuthProvider; persistence: Persistence } {
  const rpc = async (name: string, parameters: Record<string, unknown>) => {
    const { data, error } = await client.rpc(name, parameters);
    if (error) throw error;
    if (data === null) throw new Error(`${name} returned no room.`);
    return data;
  };
  return {
    auth: {
      async verifyAccessToken(accessToken) {
        const { data, error } = await client.auth.getUser(accessToken);
        if (error || !data.user) throw error ?? new Error('Invalid access token.');
        return { userId: data.user.id };
      },
      async getMembership(roomId, userId) {
        const { data, error } = await client.from('room_members').select('user_id,role,display_name')
          .eq('room_id', roomId).eq('user_id', userId).maybeSingle();
        if (error) throw error;
        if (!data) return null;
        const member = z.object({ user_id: z.string(), role: z.enum(['dm', 'player']), display_name: z.string() }).parse(data);
        return { userId: member.user_id, role: member.role, displayName: member.display_name };
      },
    },
    persistence: {
      async getRoomAsset(assetId) {
        const { data, error } = await client.from('room_assets').select('id,room_id,kind,status,width,height')
          .eq('id', assetId).maybeSingle();
        if (error) throw error;
        if (!data) return null;
        const value = roomAssetResult.parse(data);
        return {
          id: value.id, roomId: value.room_id, kind: value.kind, status: value.status,
          width: value.width, height: value.height,
        };
      },
      async loadRoomState(roomId) {
        const value = loadResult.parse(await rpc('server_load_room_state', { p_room_id: roomId }));
        return { roomId: value.room_id, sceneRevision: value.scene_revision, scene: parseSceneV2(value.scene) };
      },
      async commitRoomState(input) {
        const value = commitResult.parse(await rpc('server_commit_room_state', {
          p_command_id: input.commandId,
          p_room_id: input.roomId,
          p_actor_id: input.actorId,
          p_expected_scene_revision: input.expectedSceneRevision,
          p_scene: input.scene,
          p_event_type: input.eventType,
          p_event_payload: input.eventPayload,
        }));
        return { roomId: value.room_id, sceneRevision: value.scene_revision, eventId: value.event_id };
      },
      async reserveRoomAsset(input) {
        const value = reserveResult.parse(await rpc('server_reserve_room_asset', {
          p_command_id: input.commandId,
          p_room_id: input.roomId,
          p_creator_id: input.creatorId,
          p_kind: input.kind,
          p_source_metadata: input.sourceMetadata,
        }));
        return {
          id: value.id, roomId: value.room_id, status: value.status,
          sourceObjectKey: value.source_object_key, outputObjectPrefix: value.output_object_prefix,
        };
      },
    },
  };
}

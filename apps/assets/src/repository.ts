import type { AssetRepository, AssetStatus, RoomAsset, UserIdentity } from './types.js';

export class SupabaseRepository implements AssetRepository {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceKey: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  private serviceHeaders(): Record<string, string> {
    return { apikey: this.serviceKey, authorization: `Bearer ${this.serviceKey}` };
  }

  async verifyToken(token: string): Promise<UserIdentity> {
    const response = await this.request(`${this.baseUrl}/auth/v1/user`, {
      headers: { apikey: this.serviceKey, authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error('INVALID_TOKEN');
    const user = await response.json() as { id?: string };
    if (!user.id) throw new Error('INVALID_TOKEN');
    return { id: user.id };
  }

  async getAsset(id: string): Promise<RoomAsset | null> {
    const params = new URLSearchParams({
      id: `eq.${id}`,
      select: 'id,room_id,created_by,kind,status,source_object_key,output_object_prefix,source_metadata,width,height,updated_at',
      limit: '1',
    });
    const response = await this.request(`${this.baseUrl}/rest/v1/room_assets?${params}`, { headers: this.serviceHeaders() });
    if (!response.ok) throw new Error(`Supabase asset lookup failed: ${response.status}`);
    return ((await response.json()) as RoomAsset[])[0] ?? null;
  }

  async isRoomMember(roomId: string, userId: string): Promise<boolean> {
    const params = new URLSearchParams({ room_id: `eq.${roomId}`, user_id: `eq.${userId}`, select: 'room_id', limit: '1' });
    const response = await this.request(`${this.baseUrl}/rest/v1/room_members?${params}`, { headers: this.serviceHeaders() });
    if (!response.ok) throw new Error(`Supabase membership lookup failed: ${response.status}`);
    return ((await response.json()) as unknown[]).length === 1;
  }

  async setStatus(id: string, status: AssetStatus, details: {
    width?: number;
    height?: number;
    error?: Record<string, unknown>;
  } = {}): Promise<void> {
    const response = await this.request(`${this.baseUrl}/rest/v1/rpc/server_set_room_asset_status`, {
      method: 'POST',
      headers: { ...this.serviceHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        p_asset_id: id,
        p_status: status,
        p_width: details.width ?? null,
        p_height: details.height ?? null,
        p_error: details.error ?? null,
      }),
    });
    if (!response.ok) throw new Error(`Asset status update failed: ${response.status} ${await response.text()}`);
  }

  async findStaleReservations(before: Date, limit: number): Promise<RoomAsset[]> {
    const params = new URLSearchParams({
      status: 'eq.reserved',
      updated_at: `lt.${before.toISOString()}`,
      order: 'updated_at.asc',
      limit: String(limit),
      select: 'id,room_id,created_by,kind,status,source_object_key,output_object_prefix,source_metadata,width,height,updated_at',
    });
    const response = await this.request(`${this.baseUrl}/rest/v1/room_assets?${params}`, { headers: this.serviceHeaders() });
    if (!response.ok) throw new Error(`Supabase stale lookup failed: ${response.status}`);
    return await response.json() as RoomAsset[];
  }
}

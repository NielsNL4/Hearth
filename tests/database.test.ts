import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dm = '00000000-0000-4000-8000-000000000001';
const player = '00000000-0000-4000-8000-000000000002';
const outsider = '00000000-0000-4000-8000-000000000003';
const createId = '10000000-0000-4000-8000-000000000001';
const joinId = '10000000-0000-4000-8000-000000000002';
const legacyCampaignId = '20000000-0000-4000-8000-000000000001';
const legacyRoomId = '20000000-0000-4000-8000-000000000002';
const db = new PGlite();
let roomId: string;
let code: string;
let backfilledScene: Record<string, unknown>;

async function asUser(id: string | null, sql: string, params: unknown[] = []) {
  await db.exec(`reset role;`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [id ?? '']);
  await db.exec(`set role ${id ? 'authenticated' : 'anon'}`);
  try { return await db.query(sql, params); }
  finally { await db.exec('reset role'); }
}

async function asService(sql: string, params: unknown[] = []) {
  await db.exec('reset role; set role service_role;');
  try { return await db.query(sql, params); }
  finally { await db.exec('reset role'); }
}

beforeAll(async () => {
  // These are the Supabase-owned objects; the real application migration is
  // applied unchanged so tests exercise PostgreSQL functions, grants, and RLS.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    create schema realtime;
    create table realtime.messages (topic text, extension text);
    alter table realtime.messages enable row level security;
    create function realtime.topic() returns text language sql stable as $$
      select current_setting('realtime.topic', true)
    $$;
    grant usage on schema public, realtime to anon, authenticated;
    grant execute on function realtime.topic() to authenticated;
    grant select, insert on realtime.messages to authenticated;
  `);
  await db.exec(readFileSync(new URL('../supabase/migrations/202609100001_rooms.sql', import.meta.url), 'utf8'));
  await db.query(`insert into auth.users(id, raw_user_meta_data) values
    ($1, '{"display_name":"Dungeon Master"}'),
    ($2, '{"display_name":"River"}'), ($3, '{}')`, [dm, player, outsider]);
  await db.query(`insert into public.campaigns(id, owner_id, name) values ($1, $2, 'Legacy campaign')`, [legacyCampaignId, dm]);
  await db.query(`insert into public.rooms(id, campaign_id, created_by, name, scene) values
    ($1, $2, $3, 'Legacy room', '{"version":1,"grid":{"type":"square","cellSize":70,"offset":{"x":3,"y":4},"distancePerCell":10,"unit":"m"},"extensions":{"legacy":true}}')`,
  [legacyRoomId, legacyCampaignId, dm]);
  await db.exec(readFileSync(new URL('../supabase/migrations/202609100002_milestone2_persistence.sql', import.meta.url), 'utf8'));
  backfilledScene = (await db.query('select scene from public.rooms where id = $1', [legacyRoomId])).rows[0]!.scene as Record<string, unknown>;
  await db.query('delete from public.campaigns where id = $1', [legacyCampaignId]);
}, 30_000);
afterAll(async () => { await db.close(); });

describe.sequential('authoritative room commands and access policies', () => {
  it('explicitly backfills SceneV1 into the complete SceneV2 contract', () => {
    expect(backfilledScene).toEqual({
      version: 2,
      coordinateSystem: { origin: 'top-left', axes: 'x-right-y-down', worldUnit: 'map-pixel' },
      map: null,
      grid: {
        type: 'square', visible: true, cellSize: 70, offset: { x: 3, y: 4 },
        distancePerCell: 10, unit: 'm', snap: true,
      },
      permissions: { playerMovement: 'owned' },
      tokens: {},
      walls: {},
      fog: { version: 1, mode: 'shared', operations: [] },
      drawings: {},
      structures: {},
      lights: {},
      effects: {},
      initiative: { version: 1, active: false, round: 0, turnIndex: null, entries: [] },
      extensions: { legacy: true },
    });
  });

  it('rejects anonymous commands and empty names without partial writes', async () => {
    await expect(asUser(null, 'select public.create_room($1, $2, $3)', [createId, 'Room', 'Campaign'])).rejects.toThrow();
    await expect(asUser(dm, 'select public.create_room($1, $2, $3)', [createId, '  ', 'Campaign'])).rejects.toThrow(/1–80/);
    expect((await db.query('select * from public.campaigns')).rows).toHaveLength(0);
  });

  it('creates the campaign, DM membership, invite, empty scene, and event atomically', async () => {
    const result = await asUser(dm, 'select public.create_room($1, $2, $3) as result', [createId, 'The Sunken Keep', 'Salt & Shadow']);
    roomId = (result.rows[0] as { result: { room_id: string } }).result.room_id;
    const members = await asUser(dm, 'select * from public.room_members');
    expect(members.rows).toMatchObject([{ user_id: dm, role: 'dm' }]);
    const invites = await asUser(dm, 'select code from public.room_invites');
    code = (invites.rows[0] as { code: string }).code;
    expect(code).toMatch(/^[a-f0-9]{32}$/);
    const scene = await asUser(dm, 'select scene from public.rooms');
    expect(scene.rows).toMatchObject([{
      scene: {
        version: 2,
        coordinateSystem: { origin: 'top-left', axes: 'x-right-y-down', worldUnit: 'map-pixel' },
        map: null,
        grid: { type: 'square', visible: true, snap: true },
        permissions: { playerMovement: 'owned' },
        tokens: {}, walls: {}, drawings: {}, structures: {}, lights: {}, effects: {},
        fog: { version: 1, operations: [] },
        initiative: { version: 1, entries: [] },
      },
    }]);
    expect((await asService('select public.server_load_room_state($1) as result', [roomId])).rows)
      .toMatchObject([{ result: { scene_revision: 0, scene: { version: 2 } } }]);
  });

  it('retries creation without duplication and rejects command ID collisions', async () => {
    const result = await asUser(dm, 'select public.create_room($1, $2, $3) as result', [createId, 'The Sunken Keep', 'Salt & Shadow']);
    expect(result.rows).toMatchObject([{ result: { room_id: roomId } }]);
    expect((await asUser(dm, 'select * from public.rooms')).rows).toHaveLength(1);
    await expect(asUser(dm, 'select public.create_room($1, $2, $3)', [createId, 'Other', 'Salt & Shadow'])).rejects.toThrow(/different input/);
  });

  it('hides room, scene, roster, campaign, invite, and events from nonmembers', async () => {
    for (const table of ['rooms', 'room_members', 'campaigns', 'room_invites', 'room_events']) {
      expect((await asUser(outsider, `select * from public.${table}`)).rows).toEqual([]);
      await expect(asUser(null, `select * from public.${table}`)).rejects.toThrow();
    }
  });

  it('rejects invalid invites and grants player membership through a valid invite', async () => {
    await expect(asUser(player, 'select public.join_room($1, $2)', [joinId, 'a'.repeat(32)])).rejects.toThrow(/invalid/);
    const result = await asUser(player, 'select public.join_room($1, $2) as result', [joinId, ` ${code.toUpperCase()} `]);
    expect(result.rows).toMatchObject([{ result: { room_id: roomId } }]);
    expect((await asUser(player, 'select * from public.room_members')).rows).toHaveLength(2);
    expect((await asUser(player, 'select * from public.campaigns')).rows).toHaveLength(1);
    expect((await asUser(player, 'select * from public.room_invites')).rows).toHaveLength(0);
    expect((await asUser(player, 'select * from public.room_events')).rows).toHaveLength(2);
  });

  it('does not duplicate joins or demote a DM redeeming their own code', async () => {
    await asUser(player, 'select public.join_room($1, $2)', [joinId, code]);
    await asUser(player, 'select public.join_room(gen_random_uuid(), $1)', [code]);
    await asUser(dm, 'select public.join_room(gen_random_uuid(), $1)', [code]);
    expect((await asUser(dm, 'select * from public.room_members where role = $1', ['dm'])).rows).toHaveLength(1);
    expect((await asUser(dm, 'select * from public.room_events')).rows).toHaveLength(2);
    expect((await asUser(dm, 'select revision from public.rooms')).rows).toMatchObject([{ revision: 1 }]);
  });

  it('prevents role escalation, direct state writes, event forgery, and receipt access', async () => {
    for (const actor of [player, dm]) {
      await expect(asUser(actor, `update public.room_members set role = 'dm' where user_id = $1`, [player])).rejects.toThrow();
      await expect(asUser(actor, `update public.rooms set scene = '{}'`)).rejects.toThrow();
      await expect(asUser(actor, `delete from public.room_events`)).rejects.toThrow();
      await expect(asUser(actor, `select * from private.command_receipts`)).rejects.toThrow();
      await expect(asUser(actor, `select private.previous_command($1, 'room.create', '{}')`, [createId])).rejects.toThrow();
      await expect(asUser(actor, `insert into public.room_assets(room_id, command_id, kind, created_by)
        values ($1, gen_random_uuid(), 'token', $2)`, [roomId, actor])).rejects.toThrow();
      await expect(asUser(actor, `insert into public.room_snapshots(room_id, scene_revision, scene)
        select id, scene_revision + 1, scene from public.rooms where id = $1`, [roomId])).rejects.toThrow();
      await expect(asUser(actor, `select public.server_reserve_room_asset(
        gen_random_uuid(), $1, $2, 'token', '{}')`, [roomId, actor])).rejects.toThrow();
    }
  });

  it('commits a snapshot and event atomically and returns the same result on retry', async () => {
    const commandId = '30000000-0000-4000-8000-000000000001';
    const current = (await asUser(dm, 'select scene, scene_revision from public.rooms where id = $1', [roomId])).rows[0] as {
      scene: Record<string, unknown>; scene_revision: bigint;
    };
    const nextScene = { ...current.scene, tokens: { token1: { id: 'token1', revision: 1 } } };
    const sql = `select public.server_commit_room_state($1, $2, $3, $4, $5, 'token.created', $6) as result`;
    const params = [commandId, roomId, dm, current.scene_revision, nextScene, { tokenId: 'token1' }];
    const first = await asService(sql, params);
    const retry = await asService(sql, params);
    expect(retry.rows).toEqual(first.rows);
    expect(first.rows).toMatchObject([{ result: { room_id: roomId, scene_revision: 1 } }]);
    expect((await db.query('select scene_revision from public.room_snapshots where room_id = $1 order by scene_revision', [roomId])).rows)
      .toEqual([{ scene_revision: 0 }, { scene_revision: 1 }]);
    expect((await asUser(player, `select type, scene_revision from public.room_events where command_id = $1`, [commandId])).rows)
      .toEqual([{ type: 'token.created', scene_revision: 1 }]);
    await expect(asService(sql, [...params.slice(0, 5), { tokenId: 'different' }])).rejects.toThrow(/different input/);
    await expect(asUser(dm, sql, params)).rejects.toThrow();
  });

  it('isolates asset metadata and permits only valid service-side processing', async () => {
    const commandId = '30000000-0000-4000-8000-000000000002';
    const reservation = await asService(
      `select public.server_reserve_room_asset($1, $2, $3, 'token', $4) as result`,
      [commandId, roomId, player, { filename: 'hero.png', contentType: 'image/png', bytes: 1234 }],
    );
    const asset = (reservation.rows[0] as { result: { id: string; source_object_key: string; output_object_prefix: string } }).result;
    expect(asset.source_object_key).toBe(`rooms/${roomId}/assets/${asset.id}/source`);
    expect(asset.output_object_prefix).toBe(`rooms/${roomId}/assets/${asset.id}/output/`);
    expect((await asUser(player, 'select id, status, source_metadata from public.room_assets')).rows)
      .toMatchObject([{ id: asset.id, status: 'reserved', source_metadata: { filename: 'hero.png' } }]);
    expect((await asUser(outsider, 'select * from public.room_assets')).rows).toEqual([]);

    await asService(`select public.server_set_room_asset_status($1, 'uploading')`, [asset.id]);
    expect((await asUser(player, 'select * from public.room_assets')).rows).toEqual([]);
    await expect(asService(`select public.server_set_room_asset_status($1, 'ready', 64, 64)`, [asset.id]))
      .rejects.toThrow(/transition/);
    await asService(`select public.server_set_room_asset_status($1, 'processing')`, [asset.id]);
    await asService(`select public.server_set_room_asset_status($1, 'ready', 64, 64)`, [asset.id]);
    expect((await asUser(dm, 'select id, status, width, height from public.room_assets')).rows)
      .toEqual([{ id: asset.id, status: 'ready', width: 64, height: 64 }]);
    expect((await asUser(outsider, 'select * from public.room_assets')).rows).toEqual([]);

    const retry = await asService(
      `select public.server_reserve_room_asset($1, $2, $3, 'token', $4) as result`,
      [commandId, roomId, player, { filename: 'hero.png', contentType: 'image/png', bytes: 1234 }],
    );
    expect((retry.rows[0] as { result: { id: string } }).result.id).toBe(asset.id);
  });

  it('authorizes presence only for members and disallows broadcast access', async () => {
    await db.query(`select set_config('realtime.topic', $1, false)`, [`room:${roomId}`]);
    await asUser(player, `insert into realtime.messages(topic, extension) values ($1, 'presence')`, [`room:${roomId}`]);
    expect((await asUser(dm, 'select * from realtime.messages')).rows).toHaveLength(1);
    expect((await asUser(outsider, 'select * from realtime.messages')).rows).toHaveLength(0);
    await expect(asUser(outsider, `insert into realtime.messages(extension) values ('presence')`)).rejects.toThrow();
    await expect(asUser(player, `insert into realtime.messages(extension) values ('broadcast')`)).rejects.toThrow();
  });

  it('retains room membership and state when a user returns in a new session', async () => {
    await asUser(null, 'select 1');
    expect((await asUser(player, 'select id, name from public.rooms')).rows)
      .toEqual([{ id: roomId, name: 'The Sunken Keep' }]);
    expect((await asUser(outsider, 'select * from public.profiles')).rows).toMatchObject([{ id: outsider, display_name: 'Adventurer' }]);
  });

  it('keeps separate campaigns and rooms isolated even when both users are DMs', async () => {
    await asUser(outsider, 'select public.create_room(gen_random_uuid(), $1, $2)', ['Private room', 'Private campaign']);
    const ownRooms = await asUser(outsider, 'select name from public.rooms');
    expect(ownRooms.rows).toEqual([{ name: 'Private room' }]);
    expect((await asUser(dm, 'select name from public.rooms')).rows).toEqual([{ name: 'The Sunken Keep' }]);
    expect((await asUser(outsider, 'select name from public.campaigns')).rows).toEqual([{ name: 'Private campaign' }]);
    expect((await asUser(outsider, 'select user_id from public.room_members')).rows).toEqual([{ user_id: outsider }]);
    expect((await asUser(player, 'select id from public.rooms')).rows).toEqual([{ id: roomId }]);
  });
});

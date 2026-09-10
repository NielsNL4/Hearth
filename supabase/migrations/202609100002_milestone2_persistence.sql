-- Milestone 2. Colyseus and the asset worker are the only durable writers.

alter table public.rooms add column scene_revision bigint not null default 0
  check (scene_revision >= 0);

-- SceneV1 -> SceneV2 is deliberately materialized. This keeps old records
-- readable without requiring application code to infer fields by version.
update public.rooms
set scene = jsonb_build_object(
  'version', 2,
  'coordinateSystem', jsonb_build_object(
    'origin', 'top-left', 'axes', 'x-right-y-down', 'worldUnit', 'map-pixel'
  ),
  'map', null,
  'grid', jsonb_build_object(
    'type', coalesce(scene #>> '{grid,type}', 'square'),
    'visible', true,
    'cellSize', coalesce(scene #> '{grid,cellSize}', '1'::jsonb),
    'offset', coalesce(scene #> '{grid,offset}', '{"x":0,"y":0}'::jsonb),
    'distancePerCell', coalesce(scene #> '{grid,distancePerCell}', '5'::jsonb),
    'unit', coalesce(scene #>> '{grid,unit}', 'ft'),
    'snap', true
  ),
  'permissions', jsonb_build_object('playerMovement', 'owned'),
  'tokens', '{}'::jsonb,
  'walls', '{}'::jsonb,
  'fog', jsonb_build_object('version', 1, 'mode', 'shared', 'operations', '[]'::jsonb),
  'drawings', '{}'::jsonb,
  'structures', '{}'::jsonb,
  'lights', '{}'::jsonb,
  'effects', '{}'::jsonb,
  'initiative', jsonb_build_object(
    'version', 1, 'active', false, 'round', 0, 'turnIndex', null, 'entries', '[]'::jsonb
  ),
  'extensions', coalesce(scene -> 'extensions', '{}'::jsonb)
)
where scene ->> 'version' = '1';

alter table public.rooms alter column scene set default
  '{"version":2,"coordinateSystem":{"origin":"top-left","axes":"x-right-y-down","worldUnit":"map-pixel"},"map":null,"grid":{"type":"square","visible":true,"cellSize":1,"offset":{"x":0,"y":0},"distancePerCell":5,"unit":"ft","snap":true},"permissions":{"playerMovement":"owned"},"tokens":{},"walls":{},"fog":{"version":1,"mode":"shared","operations":[]},"drawings":{},"structures":{},"lights":{},"effects":{},"initiative":{"version":1,"active":false,"round":0,"turnIndex":null,"entries":[]},"extensions":{}}'::jsonb;
alter table public.rooms add constraint rooms_scene_v2_check
  check (scene ->> 'version' = '2');

alter table public.room_events add column scene_revision bigint
  check (scene_revision is null or scene_revision >= 0);

create table public.room_snapshots (
  room_id uuid not null references public.rooms(id) on delete cascade,
  scene_revision bigint not null check (scene_revision >= 0),
  scene jsonb not null check (scene ->> 'version' = '2'),
  created_at timestamptz not null default now(),
  primary key (room_id, scene_revision)
);
create index room_snapshots_latest_idx
  on public.room_snapshots(room_id, scene_revision desc);

insert into public.room_snapshots(room_id, scene_revision, scene)
select id, scene_revision, scene from public.rooms;

create function private.capture_room_snapshot() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.room_snapshots(room_id, scene_revision, scene)
  values (new.id, new.scene_revision, new.scene)
  on conflict (room_id, scene_revision) do update
    set scene = excluded.scene, created_at = now();
  return new;
end;
$$;
create trigger capture_room_snapshot
  after insert or update of scene, scene_revision on public.rooms
  for each row execute function private.capture_room_snapshot();

create table public.room_assets (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  command_id uuid not null,
  kind text not null check (kind in ('map', 'token')),
  status text not null default 'reserved'
    check (status in ('reserved', 'uploading', 'processing', 'ready', 'failed')),
  source_object_key text generated always as
    ('rooms/' || room_id::text || '/assets/' || id::text || '/source') stored,
  output_object_prefix text generated always as
    ('rooms/' || room_id::text || '/assets/' || id::text || '/output/') stored,
  source_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_metadata) = 'object'),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  error jsonb check (error is null or jsonb_typeof(error) = 'object'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (room_id, command_id),
  check (status <> 'ready' or (width is not null and height is not null and error is null)),
  check (status <> 'failed' or error is not null)
);
create index room_assets_room_status_idx on public.room_assets(room_id, status);

create table private.room_commit_receipts (
  room_id uuid not null references public.rooms(id) on delete cascade,
  command_id uuid not null,
  input jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (room_id, command_id)
);

alter table public.room_snapshots enable row level security;
alter table public.room_assets enable row level security;
alter table private.room_commit_receipts enable row level security;

create policy assets_read_member on public.room_assets for select to authenticated
  using (status in ('reserved', 'ready') and private.is_room_member(room_id));

-- The multiplayer server persists the resulting canonical SceneV2 and event in
-- one transaction. A retry returns the first result; changed retry input fails.
create function public.server_commit_room_state(
  p_command_id uuid,
  p_room_id uuid,
  p_actor_id uuid,
  p_expected_scene_revision bigint,
  p_scene jsonb,
  p_event_type text,
  p_event_payload jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_input jsonb := jsonb_build_object(
    'actor_id', p_actor_id,
    'expected_scene_revision', p_expected_scene_revision,
    'scene', p_scene,
    'event_type', p_event_type,
    'event_payload', coalesce(p_event_payload, '{}'::jsonb)
  );
  v_receipt private.room_commit_receipts;
  v_revision bigint;
  v_event_id bigint;
  v_result jsonb;
begin
  if p_command_id is null or p_room_id is null or p_actor_id is null then
    raise exception 'Command, room, and actor IDs are required.' using errcode = '22023';
  end if;
  if p_scene is null or p_scene ->> 'version' <> '2' then
    raise exception 'A SceneV2 snapshot is required.' using errcode = '22023';
  end if;
  if p_event_type is null or char_length(btrim(p_event_type)) not between 1 and 80 then
    raise exception 'An event type of 1-80 characters is required.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_room_id::text || ':' || p_command_id::text, 0));
  select * into v_receipt from private.room_commit_receipts
    where room_id = p_room_id and command_id = p_command_id;
  if found then
    if v_receipt.input <> v_input then
      raise exception 'Command ID already used with different input.' using errcode = '22023';
    end if;
    return v_receipt.result;
  end if;

  if not exists (select 1 from public.room_members where room_id = p_room_id and user_id = p_actor_id) then
    raise exception 'Actor is not a room member.' using errcode = '42501';
  end if;

  update public.rooms
    set scene = p_scene, scene_revision = scene_revision + 1
    where id = p_room_id and scene_revision = p_expected_scene_revision
    returning scene_revision into v_revision;
  if v_revision is null then
    raise exception 'Scene revision conflict.' using errcode = '40001';
  end if;

  insert into public.room_events(room_id, actor_id, command_id, type, payload, scene_revision)
    values (p_room_id, p_actor_id, p_command_id, btrim(p_event_type),
      coalesce(p_event_payload, '{}'::jsonb), v_revision)
    returning id into v_event_id;
  v_result := jsonb_build_object('room_id', p_room_id, 'scene_revision', v_revision, 'event_id', v_event_id);
  insert into private.room_commit_receipts(room_id, command_id, input, result)
    values (p_room_id, p_command_id, v_input, v_result);
  return v_result;
end;
$$;

create function public.server_reserve_room_asset(
  p_command_id uuid,
  p_room_id uuid,
  p_creator_id uuid,
  p_kind text,
  p_source_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_asset public.room_assets;
begin
  if p_command_id is null or p_room_id is null or p_creator_id is null then
    raise exception 'Command, room, and creator IDs are required.' using errcode = '22023';
  end if;
  if p_kind not in ('map', 'token') then
    raise exception 'Asset kind must be map or token.' using errcode = '22023';
  end if;
  if p_source_metadata is null or jsonb_typeof(p_source_metadata) <> 'object' then
    raise exception 'Source metadata must be an object.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_room_id::text || ':' || p_command_id::text, 0));
  select * into v_asset from public.room_assets
    where room_id = p_room_id and command_id = p_command_id;
  if found then
    if v_asset.created_by <> p_creator_id or v_asset.kind <> p_kind
      or v_asset.source_metadata <> p_source_metadata then
      raise exception 'Command ID already used with different input.' using errcode = '22023';
    end if;
  else
    if not exists (select 1 from public.room_members
      where room_id = p_room_id and user_id = p_creator_id
        and (p_kind = 'token' or role = 'dm')) then
      raise exception 'Creator may not reserve this asset.' using errcode = '42501';
    end if;
    insert into public.room_assets(room_id, command_id, kind, source_metadata, created_by)
      values (p_room_id, p_command_id, p_kind, p_source_metadata, p_creator_id)
      returning * into v_asset;
  end if;
  return jsonb_build_object(
    'id', v_asset.id,
    'room_id', v_asset.room_id,
    'status', v_asset.status,
    'source_object_key', v_asset.source_object_key,
    'output_object_prefix', v_asset.output_object_prefix
  );
end;
$$;

create function public.server_set_room_asset_status(
  p_asset_id uuid,
  p_status text,
  p_width integer default null,
  p_height integer default null,
  p_error jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_asset public.room_assets;
begin
  select * into v_asset from public.room_assets where id = p_asset_id for update;
  if not found then raise exception 'Asset not found.' using errcode = 'P0002'; end if;
  if not ((v_asset.status = 'reserved' and p_status in ('uploading', 'failed'))
    or (v_asset.status = 'uploading' and p_status in ('processing', 'failed'))
    or (v_asset.status = 'processing' and p_status in ('ready', 'failed'))
    or v_asset.status = p_status) then
    raise exception 'Invalid asset status transition.' using errcode = '22023';
  end if;
  if p_status = 'ready' and (p_width is null or p_width <= 0 or p_height is null or p_height <= 0 or p_error is not null) then
    raise exception 'Ready assets require positive dimensions and no error.' using errcode = '22023';
  end if;
  if p_status = 'failed' and (p_error is null or jsonb_typeof(p_error) <> 'object') then
    raise exception 'Failed assets require an error object.' using errcode = '22023';
  end if;

  update public.room_assets set
    status = p_status,
    width = case when p_status = 'ready' then p_width else width end,
    height = case when p_status = 'ready' then p_height else height end,
    error = case when p_status = 'failed' then p_error else null end,
    updated_at = now()
  where id = p_asset_id returning * into v_asset;
  return jsonb_build_object('id', v_asset.id, 'status', v_asset.status,
    'width', v_asset.width, 'height', v_asset.height, 'error', v_asset.error);
end;
$$;

create function public.server_load_room_state(p_room_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'room_id', r.id,
    'scene_revision', r.scene_revision,
    'scene', s.scene
  )
  from public.rooms r
  join public.room_snapshots s
    on s.room_id = r.id and s.scene_revision = r.scene_revision
  where r.id = p_room_id;
$$;

revoke all on public.room_assets, public.room_snapshots from anon, authenticated;
grant select on public.room_assets to authenticated;
revoke all on private.room_commit_receipts from public, anon, authenticated;
revoke all on function private.capture_room_snapshot() from public, anon, authenticated;

revoke all on function public.server_commit_room_state(uuid, uuid, uuid, bigint, jsonb, text, jsonb),
  public.server_reserve_room_asset(uuid, uuid, uuid, text, jsonb),
  public.server_set_room_asset_status(uuid, text, integer, integer, jsonb),
  public.server_load_room_state(uuid)
  from public, anon, authenticated;
grant execute on function public.server_commit_room_state(uuid, uuid, uuid, bigint, jsonb, text, jsonb),
  public.server_reserve_room_asset(uuid, uuid, uuid, text, jsonb),
  public.server_set_room_asset_status(uuid, text, integer, integer, jsonb),
  public.server_load_room_state(uuid)
  to service_role;

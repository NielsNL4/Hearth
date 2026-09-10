-- Milestone 1. All durable writes go through authenticated, transactional commands.
create schema if not exists private;
revoke all on schema private from public;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at timestamptz not null default now()
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  created_at timestamptz not null default now()
);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  revision integer not null default 0 check (revision >= 0),
  scene jsonb not null default '{"version":1,"grid":{"type":"square","cellSize":1,"offset":{"x":0,"y":0},"distancePerCell":5,"unit":"ft"},"extensions":{}}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('dm', 'player')),
  display_name text not null check (char_length(display_name) between 1 and 40),
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index room_members_user_idx on public.room_members(user_id);
create index rooms_campaign_idx on public.rooms(campaign_id);
create index campaigns_owner_idx on public.campaigns(owner_id);

create table public.room_invites (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  code text not null unique default replace(gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now()
);

create table public.room_events (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  actor_id uuid not null references auth.users(id),
  command_id uuid not null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index room_events_room_idx on public.room_events(room_id, id desc);

create table private.command_receipts (
  actor_id uuid not null references auth.users(id) on delete cascade,
  command_id uuid not null,
  command_type text not null,
  input jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_id, command_id)
);

create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, display_name)
  values (new.id, coalesce(nullif(left(btrim(new.raw_user_meta_data ->> 'display_name'), 40), ''), 'Adventurer'));
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- Also supports projects which already contain accounts.
insert into public.profiles(id, display_name)
select id, coalesce(nullif(left(btrim(raw_user_meta_data ->> 'display_name'), 40), ''), 'Adventurer')
from auth.users on conflict (id) do nothing;

-- Definer helpers avoid recursive membership policies. Caller identity always
-- comes from the JWT, never a user-supplied actor_id.
create function private.is_room_member(p_room_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.room_members
    where room_id = p_room_id and user_id = (select auth.uid()));
$$;

create function private.is_room_dm(p_room_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.room_members
    where room_id = p_room_id and user_id = (select auth.uid()) and role = 'dm');
$$;

create function private.can_read_campaign(p_campaign_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.campaigns where id = p_campaign_id and owner_id = (select auth.uid()))
    or exists (select 1 from public.rooms r join public.room_members m on m.room_id = r.id
      where r.campaign_id = p_campaign_id and m.user_id = (select auth.uid()));
$$;

create function private.can_join_presence(p_topic text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.room_members
    where 'room:' || room_id::text = p_topic and user_id = (select auth.uid()));
$$;

alter table public.profiles enable row level security;
alter table public.campaigns enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.room_invites enable row level security;
alter table public.room_events enable row level security;
alter table private.command_receipts enable row level security;

create policy profiles_read_self on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy campaigns_read_member on public.campaigns for select to authenticated
  using (private.can_read_campaign(id));
create policy rooms_read_member on public.rooms for select to authenticated
  using (private.is_room_member(id));
create policy members_read_member on public.room_members for select to authenticated
  using (private.is_room_member(room_id));
create policy invites_read_dm on public.room_invites for select to authenticated
  using (private.is_room_dm(room_id));
create policy events_read_member on public.room_events for select to authenticated
  using (private.is_room_member(room_id));

-- An idempotent command is serialized by (actor, command ID). Reusing an ID
-- with different arguments is an error, rather than silently doing other work.
create function private.previous_command(p_id uuid, p_type text, p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_receipt private.command_receipts;
begin
  if auth.uid() is null then raise exception 'Sign in to continue.' using errcode = '42501'; end if;
  if p_id is null then raise exception 'A command ID is required.' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || p_id::text, 0));
  select * into v_receipt from private.command_receipts where actor_id = auth.uid() and command_id = p_id;
  if found then
    if v_receipt.command_type <> p_type or v_receipt.input <> p_input then
      raise exception 'Command ID already used with different input.' using errcode = '22023';
    end if;
    return v_receipt.result;
  end if;
  return null;
end;
$$;

create function public.create_room(p_command_id uuid, p_name text, p_campaign_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_input jsonb := jsonb_build_object('name', btrim(p_name), 'campaign_name', btrim(p_campaign_name));
  v_result jsonb;
  v_campaign_id uuid;
  v_room_id uuid;
  v_display_name text;
begin
  v_result := private.previous_command(p_command_id, 'room.create', v_input);
  if v_result is not null then return v_result; end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 80
    or p_campaign_name is null or char_length(btrim(p_campaign_name)) not between 1 and 80 then
    raise exception 'Room and campaign names must contain 1–80 characters.' using errcode = '22023';
  end if;
  select display_name into strict v_display_name from public.profiles where id = auth.uid();
  insert into public.campaigns(owner_id, name) values (auth.uid(), btrim(p_campaign_name)) returning id into v_campaign_id;
  insert into public.rooms(campaign_id, created_by, name) values (v_campaign_id, auth.uid(), btrim(p_name)) returning id into v_room_id;
  insert into public.room_members(room_id, user_id, role, display_name) values (v_room_id, auth.uid(), 'dm', v_display_name);
  insert into public.room_invites(room_id) values (v_room_id);
  insert into public.room_events(room_id, actor_id, command_id, type, payload)
    values (v_room_id, auth.uid(), p_command_id, 'room.created', jsonb_build_object('display_name', v_display_name));
  v_result := jsonb_build_object('room_id', v_room_id);
  insert into private.command_receipts(actor_id, command_id, command_type, input, result)
    values (auth.uid(), p_command_id, 'room.create', v_input, v_result);
  return v_result;
end;
$$;

create function public.join_room(p_command_id uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_code text := lower(btrim(p_code));
  v_input jsonb := jsonb_build_object('code', v_code);
  v_result jsonb;
  v_room_id uuid;
  v_display_name text;
  v_count integer;
begin
  v_result := private.previous_command(p_command_id, 'room.join', v_input);
  if v_result is not null then return v_result; end if;
  if v_code is null or v_code !~ '^[a-f0-9]{32}$' then
    raise exception 'That invite code is invalid.' using errcode = '22023';
  end if;
  select room_id into v_room_id from public.room_invites where code = v_code;
  if v_room_id is null then raise exception 'That invite code is invalid.' using errcode = '22023'; end if;
  select display_name into strict v_display_name from public.profiles where id = auth.uid();
  insert into public.room_members(room_id, user_id, role, display_name)
    values (v_room_id, auth.uid(), 'player', v_display_name) on conflict (room_id, user_id) do nothing;
  get diagnostics v_count = row_count;
  if v_count = 1 then
    update public.rooms set revision = revision + 1 where id = v_room_id;
    insert into public.room_events(room_id, actor_id, command_id, type, payload)
      values (v_room_id, auth.uid(), p_command_id, 'member.joined', jsonb_build_object('display_name', v_display_name));
  end if;
  v_result := jsonb_build_object('room_id', v_room_id);
  insert into private.command_receipts(actor_id, command_id, command_type, input, result)
    values (auth.uid(), p_command_id, 'room.join', v_input, v_result);
  return v_result;
end;
$$;

-- Explicit grants override Supabase's permissive defaults for new public tables.
revoke all on public.profiles, public.campaigns, public.rooms, public.room_members,
  public.room_invites, public.room_events from anon, authenticated;
grant select on public.profiles, public.campaigns, public.rooms, public.room_members,
  public.room_invites, public.room_events to authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.is_room_member(uuid), private.is_room_dm(uuid),
  private.can_read_campaign(uuid), private.can_join_presence(text) to authenticated;
revoke all on function public.create_room(uuid, text, text), public.join_room(uuid, text) from public, anon;
grant execute on function public.create_room(uuid, text, text), public.join_room(uuid, text) to authenticated;

-- Realtime authorizes private channels against persisted room membership.
-- Presence payloads are advisory, and must never be used as proof of identity.
create policy room_presence_read on realtime.messages for select to authenticated
  using (extension = 'presence' and private.can_join_presence((select realtime.topic())));
create policy room_presence_write on realtime.messages for insert to authenticated
  with check (extension = 'presence' and private.can_join_presence((select realtime.topic())));

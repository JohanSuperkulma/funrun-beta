-- FunRun multiplayer beta: run this once in Supabase SQL Editor.
-- All writes go through checked RPC functions. Location reads are limited by RLS.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table if not exists public.funrun_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-F0-9]{8}$'),
  host_id uuid not null references auth.users(id) on delete cascade,
  mode text not null default 'tag' check (mode in ('tag', 'catch', 'infection')),
  duration_minutes integer not null default 30 check (duration_minutes between 1 and 120),
  reveal_every_minutes integer not null default 5 check (reveal_every_minutes = 0 or reveal_every_minutes = 1 or (reveal_every_minutes between 5 and 60 and reveal_every_minutes % 5 = 0)),
  reveal_seconds integer not null default 15 check (reveal_seconds between 1 and 120),
  phase text not null default 'lobby' check (phase in ('lobby', 'live', 'finished')),
  started_at timestamptz,
  ends_at timestamptz,
  reveal_until timestamptz,
  next_reveal_at timestamptz,
  winner text,
  created_at timestamptz not null default now()
);

create table if not exists public.funrun_members (
  room_id uuid not null references public.funrun_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 24),
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists public.funrun_roles (
  room_id uuid not null,
  user_id uuid not null,
  role text not null check (role in ('hunter', 'runner', 'out')),
  primary key (room_id, user_id),
  foreign key (room_id, user_id) references public.funrun_members(room_id, user_id) on delete cascade
);

create table if not exists public.funrun_positions (
  room_id uuid not null,
  user_id uuid not null,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  updated_at timestamptz not null default now(),
  primary key (room_id, user_id),
  foreign key (room_id, user_id) references public.funrun_members(room_id, user_id) on delete cascade
);

create table if not exists public.funrun_tag_requests (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null,
  hunter_id uuid not null,
  target_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'handled')),
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  foreign key (room_id, hunter_id) references public.funrun_members(room_id, user_id) on delete cascade,
  foreign key (room_id, target_id) references public.funrun_members(room_id, user_id) on delete cascade,
  check (hunter_id <> target_id)
);

create index if not exists funrun_members_user_idx on public.funrun_members(user_id);
create index if not exists funrun_requests_room_idx on public.funrun_tag_requests(room_id, status, created_at desc);

create or replace function private.is_member(p_room_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1 from public.funrun_members m
    where m.room_id = p_room_id and m.user_id = p_user_id
  );
$$;

create or replace function private.is_hunter(p_room_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1 from public.funrun_roles r
    where r.room_id = p_room_id and r.user_id = p_user_id and r.role = 'hunter'
  );
$$;

create or replace function private.can_read_position(p_room_id uuid, p_user_id uuid, p_updated_at timestamptz)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select p_user_id = auth.uid()
    or (
      p_updated_at > now() - interval '20 seconds'
      and private.is_hunter(p_room_id)
      and exists (
        select 1
        from public.funrun_rooms r
        join public.funrun_roles target_role
          on target_role.room_id = r.id and target_role.user_id = p_user_id
        where r.id = p_room_id
          and r.phase = 'live'
          and (r.reveal_every_minutes = 0 or r.reveal_until > now())
          and target_role.role = 'runner'
      )
    );
$$;

revoke all on function private.is_member(uuid, uuid) from public, anon;
revoke all on function private.is_hunter(uuid, uuid) from public, anon;
revoke all on function private.can_read_position(uuid, uuid, timestamptz) from public, anon;
grant execute on function private.is_member(uuid, uuid) to authenticated;
grant execute on function private.is_hunter(uuid, uuid) to authenticated;
grant execute on function private.can_read_position(uuid, uuid, timestamptz) to authenticated;

alter table public.funrun_rooms enable row level security;
alter table public.funrun_members enable row level security;
alter table public.funrun_roles enable row level security;
alter table public.funrun_positions enable row level security;
alter table public.funrun_tag_requests enable row level security;

drop policy if exists funrun_rooms_member_read on public.funrun_rooms;
create policy funrun_rooms_member_read on public.funrun_rooms
  for select to authenticated using (private.is_member(id));

drop policy if exists funrun_members_member_read on public.funrun_members;
create policy funrun_members_member_read on public.funrun_members
  for select to authenticated using (private.is_member(room_id));

drop policy if exists funrun_roles_private_read on public.funrun_roles;
create policy funrun_roles_private_read on public.funrun_roles
  for select to authenticated using (user_id = auth.uid() or private.is_hunter(room_id));

drop policy if exists funrun_positions_reveal_read on public.funrun_positions;
create policy funrun_positions_reveal_read on public.funrun_positions
  for select to authenticated using (private.can_read_position(room_id, user_id, updated_at));

drop policy if exists funrun_tag_requests_participant_read on public.funrun_tag_requests;
create policy funrun_tag_requests_participant_read on public.funrun_tag_requests
  for select to authenticated using (
    private.is_member(room_id)
    and (
      hunter_id = auth.uid()
      or target_id = auth.uid()
      or exists (select 1 from public.funrun_rooms r where r.id = room_id and r.host_id = auth.uid())
    )
  );

revoke all on public.funrun_rooms, public.funrun_members, public.funrun_roles,
  public.funrun_positions, public.funrun_tag_requests from anon, authenticated;
grant select on public.funrun_rooms, public.funrun_members, public.funrun_roles,
  public.funrun_positions, public.funrun_tag_requests to authenticated;

create or replace function public.funrun_create_room(
  p_display_name text,
  p_mode text default 'tag',
  p_duration_minutes integer default 30,
  p_reveal_every_minutes integer default 5,
  p_reveal_seconds integer default 15
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_name text := btrim(coalesce(p_display_name, ''));
  v_code text;
  v_room_id uuid;
begin
  if v_user is null then raise exception 'Logg inn først.'; end if;
  if char_length(v_name) not between 2 and 24 then raise exception 'Visningsnavnet må være 2–24 tegn.'; end if;
  if p_mode not in ('tag', 'catch', 'infection') then raise exception 'Ugyldig spilltype.'; end if;
  if p_duration_minutes not between 1 and 120 then raise exception 'Runden må vare 1–120 minutter.'; end if;
  if not (p_reveal_every_minutes = 0 or p_reveal_every_minutes = 1 or (p_reveal_every_minutes between 5 and 60 and p_reveal_every_minutes % 5 = 0)) then raise exception 'Ugyldig kartintervall.'; end if;
  if p_reveal_seconds not between 1 and 120 then raise exception 'Kartvisningen må vare 1–120 sekunder.'; end if;
  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    begin
      insert into public.funrun_rooms(code, host_id, mode, duration_minutes, reveal_every_minutes, reveal_seconds)
      values (v_code, v_user, p_mode, p_duration_minutes, p_reveal_every_minutes, p_reveal_seconds)
      returning id into v_room_id;
      exit;
    exception when unique_violation then
      -- Retry in the very unlikely event that a code has already been used.
    end;
  end loop;
  insert into public.funrun_members(room_id, user_id, display_name) values (v_room_id, v_user, v_name);
  return jsonb_build_object('room_id', v_room_id, 'code', v_code);
end;
$$;

create or replace function public.funrun_join_room(p_code text, p_display_name text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_room public.funrun_rooms%rowtype;
  v_name text := btrim(coalesce(p_display_name, ''));
begin
  if v_user is null then raise exception 'Logg inn først.'; end if;
  if char_length(v_name) not between 2 and 24 then raise exception 'Visningsnavnet må være 2–24 tegn.'; end if;
  select * into v_room from public.funrun_rooms r where r.code = upper(btrim(p_code)) and r.phase = 'lobby';
  if not found then raise exception 'Fant ikke en åpen lobby med den koden.'; end if;
  insert into public.funrun_members(room_id, user_id, display_name)
  values (v_room.id, v_user, v_name)
  on conflict (room_id, user_id) do update set display_name = excluded.display_name;
  return jsonb_build_object('room_id', v_room.id, 'code', v_room.code);
end;
$$;

create or replace function public.funrun_save_settings(
  p_room_id uuid, p_mode text, p_duration_minutes integer,
  p_reveal_every_minutes integer, p_reveal_seconds integer
)
returns void
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  update public.funrun_rooms r
  set mode = p_mode, duration_minutes = p_duration_minutes,
      reveal_every_minutes = p_reveal_every_minutes, reveal_seconds = p_reveal_seconds
  where r.id = p_room_id and r.host_id = auth.uid() and r.phase = 'lobby'
    and p_mode in ('tag', 'catch', 'infection')
    and p_duration_minutes between 1 and 120
    and (p_reveal_every_minutes = 0 or p_reveal_every_minutes = 1 or (p_reveal_every_minutes between 5 and 60 and p_reveal_every_minutes % 5 = 0))
    and p_reveal_seconds between 1 and 120;
  if not found then raise exception 'Oppsettet kunne ikke lagres. Sjekk feltene og at du er vert.'; end if;
end;
$$;

create or replace function public.funrun_start_round(p_room_id uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_room public.funrun_rooms%rowtype;
  v_count integer;
  v_hunter uuid;
  v_now timestamptz := now();
begin
  select * into v_room from public.funrun_rooms r where r.id = p_room_id for update;
  if not found or v_room.host_id <> auth.uid() or v_room.phase <> 'lobby' then raise exception 'Bare verten kan starte lobbyen.'; end if;
  select count(*) into v_count from public.funrun_members m where m.room_id = p_room_id;
  if v_count < 2 then raise exception 'Minst to spillere må være med.'; end if;
  select m.user_id into v_hunter from public.funrun_members m where m.room_id = p_room_id order by random() limit 1;
  delete from public.funrun_roles where room_id = p_room_id;
  insert into public.funrun_roles(room_id, user_id, role)
  select m.room_id, m.user_id, case when m.user_id = v_hunter then 'hunter' else 'runner' end
  from public.funrun_members m where m.room_id = p_room_id;
  update public.funrun_rooms r set phase = 'live', started_at = v_now,
    ends_at = v_now + make_interval(mins => r.duration_minutes),
    reveal_until = case when r.reveal_every_minutes = 0 then null else v_now + make_interval(secs => r.reveal_seconds) end,
    next_reveal_at = case when r.reveal_every_minutes = 0 then null else v_now + make_interval(mins => r.reveal_every_minutes) end,
    winner = null
  where r.id = p_room_id;
end;
$$;

create or replace function public.funrun_advance_round(p_room_id uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_room public.funrun_rooms%rowtype;
  v_runners integer;
begin
  select * into v_room from public.funrun_rooms r where r.id = p_room_id for update;
  if not found or v_room.host_id <> auth.uid() or v_room.phase <> 'live' then return; end if;
  delete from public.funrun_positions where room_id = p_room_id and updated_at < now() - interval '20 seconds';
  if v_room.ends_at <= now() then
    select count(*) into v_runners from public.funrun_roles r where r.room_id = p_room_id and r.role = 'runner';
    update public.funrun_rooms set phase = 'finished', winner = case when v_runners = 0 then 'hunter' else 'runners' end where id = p_room_id;
    delete from public.funrun_positions where room_id = p_room_id;
  elsif v_room.reveal_every_minutes > 0 and v_room.next_reveal_at <= now() then
    update public.funrun_rooms set
      reveal_until = now() + make_interval(secs => v_room.reveal_seconds),
      next_reveal_at = now() + make_interval(mins => v_room.reveal_every_minutes)
    where id = p_room_id;
  end if;
end;
$$;

create or replace function public.funrun_request_tag(p_room_id uuid, p_target_id uuid)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not private.is_member(p_room_id) or not private.is_hunter(p_room_id) then raise exception 'Bare jegeren kan melde at noen er tatt.'; end if;
  if not exists (select 1 from public.funrun_rooms r where r.id = p_room_id and r.phase = 'live') then raise exception 'Runden er ikke aktiv.'; end if;
  if not exists (select 1 from public.funrun_roles r where r.room_id = p_room_id and r.user_id = p_target_id and r.role = 'runner') then raise exception 'Spilleren kan ikke velges nå.'; end if;
  insert into public.funrun_tag_requests(room_id, hunter_id, target_id) values (p_room_id, auth.uid(), p_target_id) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.funrun_confirm_tag(p_request_id uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_request public.funrun_tag_requests%rowtype;
  v_mode text;
  v_runner_count integer;
begin
  select * into v_request from public.funrun_tag_requests q where q.id = p_request_id for update;
  if not found or v_request.target_id <> auth.uid() or v_request.status <> 'pending' then raise exception 'Denne bekreftelsen er ikke lenger aktiv.'; end if;
  select r.mode into v_mode from public.funrun_rooms r where r.id = v_request.room_id and r.phase = 'live' for update;
  if not found then raise exception 'Runden er ikke aktiv.'; end if;
  if not exists (select 1 from public.funrun_roles r where r.room_id = v_request.room_id and r.user_id = v_request.hunter_id and r.role = 'hunter') then raise exception 'Jegeren har endret seg. Be om ny bekreftelse.'; end if;
  if not exists (select 1 from public.funrun_roles r where r.room_id = v_request.room_id and r.user_id = v_request.target_id and r.role = 'runner') then raise exception 'Du er ikke lenger på flukt.'; end if;
  if v_mode = 'tag' then
    update public.funrun_roles set role = 'runner' where room_id = v_request.room_id and user_id = v_request.hunter_id;
    update public.funrun_roles set role = 'hunter' where room_id = v_request.room_id and user_id = v_request.target_id;
  elsif v_mode = 'infection' then
    update public.funrun_roles set role = 'hunter' where room_id = v_request.room_id and user_id = v_request.target_id;
    select count(*) into v_runner_count from public.funrun_roles r where r.room_id = v_request.room_id and r.role = 'runner';
    if v_runner_count = 0 then
      update public.funrun_rooms set phase = 'finished', winner = 'hunter' where id = v_request.room_id;
      delete from public.funrun_positions where room_id = v_request.room_id;
    end if;
  else
    update public.funrun_roles set role = 'out' where room_id = v_request.room_id and user_id = v_request.target_id;
    delete from public.funrun_positions where room_id = v_request.room_id and user_id = v_request.target_id;
    select count(*) into v_runner_count from public.funrun_roles r where r.room_id = v_request.room_id and r.role = 'runner';
    if v_runner_count = 0 then
      update public.funrun_rooms set phase = 'finished', winner = 'hunter' where id = v_request.room_id;
      delete from public.funrun_positions where room_id = v_request.room_id;
    end if;
  end if;
  update public.funrun_tag_requests set status = 'handled', handled_at = now() where id = p_request_id;
end;
$$;

create or replace function public.funrun_upsert_position(p_room_id uuid, p_lat double precision, p_lng double precision)
returns void
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_lat not between -90 and 90 or p_lng not between -180 and 180 then raise exception 'Ugyldig posisjon.'; end if;
  if not private.is_member(p_room_id)
    or not exists (select 1 from public.funrun_rooms r where r.id = p_room_id and r.phase = 'live')
    or not exists (select 1 from public.funrun_roles r where r.room_id = p_room_id and r.user_id = auth.uid() and r.role <> 'out') then
    raise exception 'GPS kan bare deles mens du er aktiv i en runde.';
  end if;
  insert into public.funrun_positions(room_id, user_id, lat, lng, updated_at)
  values (p_room_id, auth.uid(), p_lat, p_lng, now())
  on conflict (room_id, user_id) do update set lat = excluded.lat, lng = excluded.lng, updated_at = excluded.updated_at;
end;
$$;

create or replace function public.funrun_delete_position(p_room_id uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  delete from public.funrun_positions where room_id = p_room_id and user_id = auth.uid();
end;
$$;

create or replace function public.funrun_leave_room(p_room_id uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_room public.funrun_rooms%rowtype;
  v_next_host uuid;
begin
  select * into v_room from public.funrun_rooms r where r.id = p_room_id for update;
  if not found or not private.is_member(p_room_id) then return; end if;
  delete from public.funrun_members where room_id = p_room_id and user_id = auth.uid();
  if v_room.host_id = auth.uid() then
    select m.user_id into v_next_host from public.funrun_members m where m.room_id = p_room_id order by m.joined_at limit 1;
    if v_next_host is null then delete from public.funrun_rooms where id = p_room_id;
    else update public.funrun_rooms set host_id = v_next_host where id = p_room_id;
    end if;
  end if;
end;
$$;

revoke all on function public.funrun_create_room(text, text, integer, integer, integer) from public, anon;
revoke all on function public.funrun_join_room(text, text) from public, anon;
revoke all on function public.funrun_save_settings(uuid, text, integer, integer, integer) from public, anon;
revoke all on function public.funrun_start_round(uuid) from public, anon;
revoke all on function public.funrun_advance_round(uuid) from public, anon;
revoke all on function public.funrun_request_tag(uuid, uuid) from public, anon;
revoke all on function public.funrun_confirm_tag(uuid) from public, anon;
revoke all on function public.funrun_upsert_position(uuid, double precision, double precision) from public, anon;
revoke all on function public.funrun_delete_position(uuid) from public, anon;
revoke all on function public.funrun_leave_room(uuid) from public, anon;
grant execute on function public.funrun_create_room(text, text, integer, integer, integer) to authenticated;
grant execute on function public.funrun_join_room(text, text) to authenticated;
grant execute on function public.funrun_save_settings(uuid, text, integer, integer, integer) to authenticated;
grant execute on function public.funrun_start_round(uuid) to authenticated;
grant execute on function public.funrun_advance_round(uuid) to authenticated;
grant execute on function public.funrun_request_tag(uuid, uuid) to authenticated;
grant execute on function public.funrun_confirm_tag(uuid) to authenticated;
grant execute on function public.funrun_upsert_position(uuid, double precision, double precision) to authenticated;
grant execute on function public.funrun_delete_position(uuid) to authenticated;
grant execute on function public.funrun_leave_room(uuid) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.funrun_rooms;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.funrun_members;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.funrun_roles;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.funrun_positions;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.funrun_tag_requests;
exception when duplicate_object then null;
end $$;

-- FunRun multiplayer upgrade for an existing project.
-- Run once in Supabase SQL Editor after the original supabase-schema.sql.
-- Adds shared round setup, boundary rules, packages, checkpoints, and ready checks.

alter table public.funrun_rooms
  add column if not exists game_options jsonb not null default '{}'::jsonb,
  add column if not exists headstart_seconds integer not null default 0;

alter table public.funrun_rooms drop constraint if exists funrun_rooms_mode_check;
alter table public.funrun_rooms add constraint funrun_rooms_mode_check
  check (mode in ('tag', 'catch', 'infection', 'checkpoints'));
alter table public.funrun_rooms drop constraint if exists funrun_rooms_reveal_every_minutes_check;
alter table public.funrun_rooms add constraint funrun_rooms_reveal_every_minutes_check
  check (reveal_every_minutes between 0 and 60);
alter table public.funrun_rooms drop constraint if exists funrun_rooms_headstart_seconds_check;
alter table public.funrun_rooms add constraint funrun_rooms_headstart_seconds_check
  check (headstart_seconds between 0 and 3600);

alter table public.funrun_members
  add column if not exists ready boolean not null default false;

create table if not exists public.funrun_packages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.funrun_rooms(id) on delete cascade,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  claimed_at timestamptz,
  claimed_by uuid references auth.users(id) on delete set null,
  outcome text check (outcome in ('extreme_advantage', 'advantage', 'disadvantage', 'extreme_disadvantage'))
);

create table if not exists public.funrun_checkpoint_visits (
  room_id uuid not null,
  user_id uuid not null,
  checkpoint_index integer not null check (checkpoint_index between 0 and 9),
  visited_at timestamptz not null default now(),
  primary key (room_id, user_id, checkpoint_index),
  foreign key (room_id, user_id) references public.funrun_members(room_id, user_id) on delete cascade
);

alter table public.funrun_packages enable row level security;
alter table public.funrun_checkpoint_visits enable row level security;

drop policy if exists funrun_packages_member_read on public.funrun_packages;
create policy funrun_packages_member_read on public.funrun_packages
  for select to authenticated using (private.is_member(room_id));
drop policy if exists funrun_checkpoint_visits_member_read on public.funrun_checkpoint_visits;
create policy funrun_checkpoint_visits_member_read on public.funrun_checkpoint_visits
  for select to authenticated using (private.is_member(room_id));

revoke all on public.funrun_packages, public.funrun_checkpoint_visits from anon, authenticated;
grant select on public.funrun_packages, public.funrun_checkpoint_visits to authenticated;

create or replace function private.point_inside_zone(p_lat double precision, p_lng double precision, p_zone jsonb)
returns boolean
language plpgsql immutable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_count integer;
  v_i integer;
  v_j integer;
  v_a jsonb;
  v_b jsonb;
  v_inside boolean := false;
begin
  if p_zone is null or jsonb_typeof(p_zone) <> 'array' then return false; end if;
  v_count := jsonb_array_length(p_zone);
  if v_count < 3 then return false; end if;
  v_j := v_count - 1;
  for v_i in 0..v_count-1 loop
    v_a := p_zone->v_i;
    v_b := p_zone->v_j;
    if ((v_a->>'lng')::double precision > p_lng) <> ((v_b->>'lng')::double precision > p_lng)
      and p_lat < (((v_b->>'lat')::double precision-(v_a->>'lat')::double precision)
        *(p_lng-(v_a->>'lng')::double precision)
        / nullif((v_b->>'lng')::double precision-(v_a->>'lng')::double precision,0)
        +(v_a->>'lat')::double precision) then
      v_inside := not v_inside;
    end if;
    v_j := v_i;
  end loop;
  return v_inside;
end;
$$;
revoke all on function private.point_inside_zone(double precision,double precision,jsonb) from public, anon, authenticated;

create or replace function public.funrun_get_area_status(p_room_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_room public.funrun_rooms%rowtype;
  v_total integer;
  v_active integer;
  v_inside integer;
begin
  if not private.is_member(p_room_id) or not private.is_hunter(p_room_id) then
    raise exception 'Bare en jeger i lobbyen kan se soneoversikten.';
  end if;
  select * into v_room from public.funrun_rooms r
    where r.id=p_room_id and r.phase='live' and r.started_at<=now();
  if not found or (v_room.reveal_every_minutes>0 and (v_room.reveal_until is null or v_room.reveal_until<=now()))
    or coalesce(v_room.game_options->>'positionDisplay','names')<>'area' then
    return jsonb_build_object('visible',false);
  end if;
  select count(*), count(p.user_id), count(p.user_id) filter (where private.point_inside_zone(p.lat,p.lng,v_room.game_options->'zone'))
    into v_total,v_active,v_inside
  from public.funrun_roles r
  left join public.funrun_positions p on p.room_id=r.room_id and p.user_id=r.user_id and p.updated_at>now()-interval '20 seconds'
  where r.room_id=p_room_id and r.role='runner';
  return jsonb_build_object('visible',true,'runners',v_total,'sharing',v_active,'inside',v_inside);
end;
$$;

create or replace function public.funrun_upsert_position(p_room_id uuid, p_lat double precision, p_lng double precision)
returns void
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_room public.funrun_rooms%rowtype;
begin
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'Ugyldig GPS-posisjon.';
  end if;
  select * into v_room from public.funrun_rooms r where r.id=p_room_id and r.phase='live';
  if not found or v_room.started_at>now() or not private.is_member(p_room_id)
    or not exists(select 1 from public.funrun_roles r where r.room_id=p_room_id and r.user_id=auth.uid() and r.role in ('hunter','runner')) then
    raise exception 'GPS kan bare deles etter nedtellingen mens du er aktiv i runden.';
  end if;
  insert into public.funrun_positions(room_id,user_id,lat,lng,updated_at)
  values(p_room_id,auth.uid(),p_lat,p_lng,now())
  on conflict(room_id,user_id) do update set lat=excluded.lat,lng=excluded.lng,updated_at=excluded.updated_at;
end;
$$;

create or replace function private.can_read_position(p_room_id uuid, p_user_id uuid, p_updated_at timestamptz)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select p_user_id = auth.uid();
$$;

create or replace function public.funrun_get_visible_positions(p_room_id uuid)
returns table(user_id uuid, lat double precision, lng double precision, updated_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_room public.funrun_rooms%rowtype;
  v_display text;
  v_precision text;
begin
  if not private.is_member(p_room_id) or not private.is_hunter(p_room_id) then
    raise exception 'Bare en jeger i lobbyen kan se posisjonene.';
  end if;
  select * into v_room from public.funrun_rooms r
  where r.id=p_room_id and r.phase='live' and r.started_at<=now();
  if not found then return; end if;
  if v_room.reveal_every_minutes>0 and (v_room.reveal_until is null or v_room.reveal_until<=now()) then return; end if;
  v_display := coalesce(v_room.game_options->>'positionDisplay','names');
  v_precision := coalesce(v_room.game_options->>'positionPrecision','approx');
  if v_display='area' then return; end if;
  return query
    select p.user_id,
      case when v_precision='exact' then p.lat else round(p.lat::numeric,3)::double precision end,
      case when v_precision='exact' then p.lng else round(p.lng::numeric,3)::double precision end,
      p.updated_at
    from public.funrun_positions p
    join public.funrun_roles r on r.room_id=p.room_id and r.user_id=p.user_id and r.role='runner'
    where p.room_id=p_room_id and p.updated_at>now()-interval '20 seconds' and p.user_id<>auth.uid();
end;
$$;

create or replace function public.funrun_save_full_setup(
  p_room_id uuid,
  p_mode text,
  p_duration_minutes integer,
  p_headstart_seconds integer,
  p_reveal_every_minutes integer,
  p_reveal_seconds integer,
  p_game_options jsonb,
  p_packages jsonb
)
returns void
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_options jsonb := coalesce(p_game_options, '{}'::jsonb) - 'pendingPackages';
  v_zone jsonb;
  v_checkpoints jsonb;
  v_package jsonb;
  v_point jsonb;
  v_lat double precision;
  v_lng double precision;
  v_package_count integer;
begin
  if not private.is_member(p_room_id) or not exists (
    select 1 from public.funrun_rooms r
    where r.id = p_room_id and r.host_id = auth.uid() and r.phase = 'lobby'
  ) then raise exception 'Bare verten kan endre oppsettet i en lobby.'; end if;
  if p_mode not in ('tag', 'catch', 'infection', 'checkpoints') then raise exception 'Ugyldig spilltype.'; end if;
  if p_duration_minutes not between 1 and 120 then raise exception 'Runden må vare 1–120 minutter.'; end if;
  if p_headstart_seconds not between 0 and 3600 then raise exception 'Ugyldig nedtelling.'; end if;
  if p_reveal_every_minutes not between 0 and 60 then raise exception 'Kartintervallet må være 0–60 minutter.'; end if;
  if p_reveal_seconds not between 1 and 120 then raise exception 'Kartvisningen må vare 1–120 sekunder.'; end if;
  if jsonb_typeof(v_options) <> 'object' then raise exception 'Ugyldig rundeoppsett.'; end if;

  v_zone := coalesce(v_options->'zone', '[]'::jsonb);
  v_checkpoints := coalesce(v_options->'checkpoints', '[]'::jsonb);
  if jsonb_typeof(v_zone) <> 'array' or jsonb_array_length(v_zone) > 24
    or jsonb_array_length(v_zone) in (1,2) then raise exception 'Et spilleområde må ha minst tre punkter.'; end if;
  if jsonb_typeof(v_checkpoints) <> 'array' or jsonb_array_length(v_checkpoints) > 10 then raise exception 'Ugyldige kontrollpunkter.'; end if;
  if coalesce(jsonb_typeof(p_packages),'null') <> 'array' then raise exception 'Ugyldig pakkeliste.'; end if;
  if coalesce(v_options->>'outsideRule', 'out') not in ('out', 'hunter') then raise exception 'Ugyldig regel for sonegrensen.'; end if;
  if coalesce(v_options->>'positionDisplay', 'names') not in ('names', 'dots', 'area') then raise exception 'Ugyldig kartvisning.'; end if;
  if coalesce(v_options->>'positionPrecision', 'approx') not in ('exact', 'approx') then raise exception 'Ugyldig posisjonsnøyaktighet.'; end if;
  if coalesce(v_options->>'checkpointOrder', 'any') not in ('any', 'ordered') then raise exception 'Ugyldig kontrollpunktrekkefølge.'; end if;
  if jsonb_array_length(p_packages) > 8 then raise exception 'Du kan legge ut maks 8 pakker.'; end if;
  if (jsonb_array_length(v_checkpoints)>0 or jsonb_array_length(p_packages)>0) and jsonb_array_length(v_zone)<3 then
    raise exception 'Tegn spilleområdet før du plasserer pakker og kontrollpunkter.';
  end if;
  for v_point in select value from jsonb_array_elements(v_zone) as points(value)
  loop
    begin
      v_lat := (v_point->>'lat')::double precision;
      v_lng := (v_point->>'lng')::double precision;
    exception when others then raise exception 'Ugyldig punkt i spilleområdet.';
    end;
    if v_lat not between -90 and 90 or v_lng not between -180 and 180 then
      raise exception 'Ugyldig punkt i spilleområdet.';
    end if;
  end loop;
  for v_package in select value from jsonb_array_elements(v_checkpoints) as points(value)
  loop
    begin
      v_lat := (v_package->>'lat')::double precision;
      v_lng := (v_package->>'lng')::double precision;
    exception when others then raise exception 'Ugyldig plassering av kontrollpunkt.';
    end;
    if v_lat not between -90 and 90 or v_lng not between -180 and 180
      or not private.point_inside_zone(v_lat,v_lng,v_zone) then
      raise exception 'Alle kontrollpunktene må ligge i spilleområdet.';
    end if;
  end loop;
  if p_mode = 'checkpoints'
    and jsonb_array_length(v_checkpoints) < least(10, greatest(1, coalesce((v_options->>'checkpointCount')::integer, 3))) then
    raise exception 'Plasser alle kontrollpunktene først.';
  end if;

  update public.funrun_rooms
  set mode = p_mode, duration_minutes = p_duration_minutes, headstart_seconds = p_headstart_seconds,
      reveal_every_minutes = p_reveal_every_minutes, reveal_seconds = p_reveal_seconds, game_options = v_options
  where id = p_room_id and host_id = auth.uid() and phase = 'lobby';

  delete from public.funrun_packages where room_id = p_room_id;
  for v_package in select value from jsonb_array_elements(coalesce(p_packages, '[]'::jsonb)) as items(value)
  loop
    begin
      v_lat := (v_package->>'lat')::double precision;
      v_lng := (v_package->>'lng')::double precision;
    exception when others then
      raise exception 'Ugyldig pakkeplassering.';
    end;
    if v_lat not between -90 and 90 or v_lng not between -180 and 180
      or not private.point_inside_zone(v_lat,v_lng,v_zone) then raise exception 'Pakkene må ligge i spilleområdet.'; end if;
    insert into public.funrun_packages(room_id, lat, lng) values (p_room_id, v_lat, v_lng);
  end loop;
  update public.funrun_members set ready = false where room_id = p_room_id;
end;
$$;

create or replace function public.funrun_set_ready(p_room_id uuid, p_ready boolean)
returns void
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  update public.funrun_members m set ready = p_ready
  where m.room_id = p_room_id and m.user_id = auth.uid()
    and exists (select 1 from public.funrun_rooms r where r.id = p_room_id and r.phase = 'lobby');
  if not found then raise exception 'Du er ikke i en åpen lobby.'; end if;
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
  v_not_ready integer;
  v_hunter uuid;
  v_start timestamptz;
  v_now timestamptz := now();
begin
  select * into v_room from public.funrun_rooms r where r.id = p_room_id for update;
  if not found or v_room.host_id <> auth.uid() or v_room.phase <> 'lobby' then raise exception 'Bare verten kan starte lobbyen.'; end if;
  select count(*) into v_count from public.funrun_members m where m.room_id = p_room_id;
  if v_count < 2 then raise exception 'Minst to spillere må være med.'; end if;
  select count(*) into v_not_ready from public.funrun_members m where m.room_id = p_room_id and not m.ready;
  if v_not_ready > 0 then raise exception 'Alle må lese reglene og trykke klar før start.'; end if;
  if jsonb_array_length(coalesce(v_room.game_options->'zone','[]'::jsonb)) < 3 then raise exception 'Tegn et spilleområde med minst tre punkter først.'; end if;
  if v_room.mode = 'checkpoints'
    and jsonb_array_length(coalesce(v_room.game_options->'checkpoints','[]'::jsonb)) < least(10,greatest(1,coalesce((v_room.game_options->>'checkpointCount')::integer,3))) then
    raise exception 'Plasser alle kontrollpunktene før start.';
  end if;
  select m.user_id into v_hunter from public.funrun_members m where m.room_id = p_room_id order by random() limit 1;
  delete from public.funrun_roles where room_id = p_room_id;
  insert into public.funrun_roles(room_id,user_id,role)
  select m.room_id,m.user_id,case when m.user_id=v_hunter then 'hunter' else 'runner' end
  from public.funrun_members m where m.room_id=p_room_id;
  delete from public.funrun_positions where room_id=p_room_id;
  delete from public.funrun_checkpoint_visits where room_id=p_room_id;
  update public.funrun_packages set claimed_at=null,claimed_by=null,outcome=null where room_id=p_room_id;
  v_start := v_now + make_interval(secs => v_room.headstart_seconds);
  update public.funrun_rooms r set phase='live',started_at=v_start,
    ends_at=v_start+make_interval(mins=>r.duration_minutes),
    reveal_until=case when r.reveal_every_minutes=0 then null else v_start+make_interval(secs=>r.reveal_seconds) end,
    next_reveal_at=case when r.reveal_every_minutes=0 then null else v_start+make_interval(mins=>r.reveal_every_minutes) end,
    winner=null where r.id=p_room_id;
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
  select * into v_room from public.funrun_rooms r where r.id=p_room_id for update;
  if not found or v_room.host_id<>auth.uid() or v_room.phase<>'live' or v_room.started_at>now() then return; end if;
  delete from public.funrun_positions where room_id=p_room_id and updated_at<now()-interval '20 seconds';
  if v_room.ends_at<=now() then
    select count(*) into v_runners from public.funrun_roles r where r.room_id=p_room_id and r.role='runner';
    update public.funrun_rooms set phase='finished',winner=case when v_runners=0 then 'hunter' else 'runners' end where id=p_room_id;
    delete from public.funrun_positions where room_id=p_room_id;
  elsif v_room.reveal_every_minutes>0 and v_room.next_reveal_at<=now() then
    update public.funrun_rooms set reveal_until=now()+make_interval(secs=>v_room.reveal_seconds),
      next_reveal_at=now()+make_interval(mins=>v_room.reveal_every_minutes) where id=p_room_id;
  end if;
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
  select * into v_request from public.funrun_tag_requests q where q.id=p_request_id for update;
  if not found or v_request.target_id<>auth.uid() or v_request.status<>'pending' then raise exception 'Denne bekreftelsen er ikke lenger aktiv.'; end if;
  select r.mode into v_mode from public.funrun_rooms r where r.id=v_request.room_id and r.phase='live' for update;
  if not found then raise exception 'Runden er ikke aktiv.'; end if;
  if not exists(select 1 from public.funrun_roles r where r.room_id=v_request.room_id and r.user_id=v_request.hunter_id and r.role='hunter') then raise exception 'Jegeren har endret seg. Be om ny bekreftelse.'; end if;
  if not exists(select 1 from public.funrun_roles r where r.room_id=v_request.room_id and r.user_id=v_request.target_id and r.role='runner') then raise exception 'Du er ikke lenger på flukt.'; end if;
  if v_mode='tag' then
    update public.funrun_roles set role='runner' where room_id=v_request.room_id and user_id=v_request.hunter_id;
    update public.funrun_roles set role='hunter' where room_id=v_request.room_id and user_id=v_request.target_id;
  elsif v_mode in ('infection','checkpoints') then
    update public.funrun_roles set role='hunter' where room_id=v_request.room_id and user_id=v_request.target_id;
    select count(*) into v_runner_count from public.funrun_roles r where r.room_id=v_request.room_id and r.role='runner';
    if v_runner_count=0 then
      update public.funrun_rooms set phase='finished',winner='hunter' where id=v_request.room_id;
      delete from public.funrun_positions where room_id=v_request.room_id;
    end if;
  else
    update public.funrun_roles set role='out' where room_id=v_request.room_id and user_id=v_request.target_id;
    delete from public.funrun_positions where room_id=v_request.room_id and user_id=v_request.target_id;
    select count(*) into v_runner_count from public.funrun_roles r where r.room_id=v_request.room_id and r.role='runner';
    if v_runner_count=0 then
      update public.funrun_rooms set phase='finished',winner='hunter' where id=v_request.room_id;
      delete from public.funrun_positions where room_id=v_request.room_id;
    end if;
  end if;
  update public.funrun_tag_requests set status='handled',handled_at=now() where id=p_request_id;
end;
$$;

create or replace function public.funrun_apply_zone_penalty(p_room_id uuid)
returns text
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_room public.funrun_rooms%rowtype;
  v_position public.funrun_positions%rowtype;
  v_new_role text;
  v_runners integer;
begin
  select * into v_room from public.funrun_rooms r where r.id=p_room_id for update;
  if not found or v_room.phase<>'live' or v_room.started_at>now()
    or not private.is_member(p_room_id)
    or not exists(select 1 from public.funrun_roles r where r.room_id=p_room_id and r.user_id=auth.uid() and r.role='runner') then
    raise exception 'Regelen for sonegrensen kan ikke brukes nå.';
  end if;
  select * into v_position from public.funrun_positions p
    where p.room_id=p_room_id and p.user_id=auth.uid() and p.updated_at>now()-interval '20 seconds';
  if not found or private.point_inside_zone(v_position.lat,v_position.lng,v_room.game_options->'zone') then
    raise exception 'GPS viser ikke at du er utenfor spilleområdet.';
  end if;
  v_new_role := case when v_room.game_options->>'outsideRule'='hunter' then 'hunter' else 'out' end;
  update public.funrun_roles set role=v_new_role where room_id=p_room_id and user_id=auth.uid();
  if v_new_role='out' then delete from public.funrun_positions where room_id=p_room_id and user_id=auth.uid(); end if;
  select count(*) into v_runners from public.funrun_roles r where r.room_id=p_room_id and r.role='runner';
  if v_runners=0 then
    update public.funrun_rooms set phase='finished',winner='hunter' where id=p_room_id;
    delete from public.funrun_positions where room_id=p_room_id;
  end if;
  return v_new_role;
end;
$$;

create or replace function public.funrun_claim_package(p_room_id uuid,p_package_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_room public.funrun_rooms%rowtype;
  v_package public.funrun_packages%rowtype;
  v_position public.funrun_positions%rowtype;
  v_distance double precision;
  v_roll integer;
  v_level text;
  v_effect text;
  v_outcome text;
begin
  if not private.is_member(p_room_id) then raise exception 'Du er ikke i denne lobbyen.'; end if;
  select * into v_room from public.funrun_rooms r where r.id=p_room_id and r.phase='live' and r.started_at<=now();
  if not found or not coalesce((v_room.game_options->>'packagesEnabled')::boolean,false) then raise exception 'Pakker er ikke aktive i runden.'; end if;
  if not exists(select 1 from public.funrun_roles r where r.room_id=p_room_id and r.user_id=auth.uid() and r.role in ('runner','hunter')) then raise exception 'Du kan ikke åpne pakker nå.'; end if;
  select * into v_package from public.funrun_packages p where p.id=p_package_id and p.room_id=p_room_id for update;
  if not found or v_package.claimed_at is not null then raise exception 'Denne pakken er allerede åpnet.'; end if;
  select * into v_position from public.funrun_positions p where p.room_id=p_room_id and p.user_id=auth.uid() and p.updated_at>now()-interval '30 seconds';
  if not found then raise exception 'GPS-posisjonen din mangler. Start GPS og prøv igjen.'; end if;
  v_distance := 6371000 * 2 * asin(sqrt(
    power(sin(radians(v_position.lat-v_package.lat)/2),2)
    + cos(radians(v_position.lat))*cos(radians(v_package.lat))*power(sin(radians(v_position.lng-v_package.lng)/2),2)
  ));
  if v_distance>55 then raise exception 'Gå nærmere pakken før du åpner den.'; end if;
  v_roll := floor(random()*4)::integer;
  if v_roll=0 then v_outcome:='extreme_advantage';v_level:='Ekstrem fordel';v_effect:='Laget ditt får en ekstra kartvisning. Avtal tidspunktet med de andre.';
  elsif v_roll=1 then v_outcome:='advantage';v_level:='Fordel';v_effect:='Laget ditt får 15 sekunder ekstra på neste kartvisning.';
  elsif v_roll=2 then v_outcome:='disadvantage';v_level:='Ulempe';v_effect:='Motstanderlaget får en ekstra kartvisning.';
  else v_outcome:='extreme_disadvantage';v_level:='Ekstrem ulempe';v_effect:='Motstanderlaget får 30 sekunder ekstra på neste kartvisning.'; end if;
  update public.funrun_packages set claimed_at=now(),claimed_by=auth.uid(),outcome=v_outcome where id=p_package_id;
  return jsonb_build_object('level',v_level,'effect',v_effect,'outcome',v_outcome);
end;
$$;

create or replace function public.funrun_claim_checkpoint(p_room_id uuid,p_checkpoint_index integer)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_room public.funrun_rooms%rowtype;
  v_position public.funrun_positions%rowtype;
  v_point jsonb;
  v_distance double precision;
  v_count integer;
  v_total integer;
begin
  select * into v_room from public.funrun_rooms r where r.id=p_room_id for update;
  if not found or v_room.phase<>'live' or v_room.started_at>now() or v_room.mode<>'checkpoints'
    or not private.is_member(p_room_id)
    or not exists(select 1 from public.funrun_roles r where r.room_id=p_room_id and r.user_id=auth.uid() and r.role='runner') then
    raise exception 'Kontrollpunkter er ikke aktive for deg nå.';
  end if;
  v_total := jsonb_array_length(coalesce(v_room.game_options->'checkpoints','[]'::jsonb));
  if p_checkpoint_index<0 or p_checkpoint_index>=v_total then raise exception 'Kontrollpunktet finnes ikke.'; end if;
  if exists(select 1 from public.funrun_checkpoint_visits v where v.room_id=p_room_id and v.user_id=auth.uid() and v.checkpoint_index=p_checkpoint_index) then
    select count(*) into v_count from public.funrun_checkpoint_visits v where v.room_id=p_room_id and v.user_id=auth.uid();
    return jsonb_build_object('visited',v_count,'total',v_total,'complete',v_count>=v_total);
  end if;
  if v_room.game_options->>'checkpointOrder'='ordered' then
    select count(*) into v_count from public.funrun_checkpoint_visits v where v.room_id=p_room_id and v.user_id=auth.uid();
    if p_checkpoint_index<>v_count then raise exception 'Besøk kontrollpunktene i riktig rekkefølge.'; end if;
  end if;
  v_point := v_room.game_options->'checkpoints'->p_checkpoint_index;
  select * into v_position from public.funrun_positions p where p.room_id=p_room_id and p.user_id=auth.uid() and p.updated_at>now()-interval '30 seconds';
  if not found then raise exception 'GPS-posisjonen din mangler. Start GPS og prøv igjen.'; end if;
  v_distance := 6371000 * 2 * asin(sqrt(
    power(sin(radians(v_position.lat-(v_point->>'lat')::double precision)/2),2)
    + cos(radians(v_position.lat))*cos(radians((v_point->>'lat')::double precision))*power(sin(radians(v_position.lng-(v_point->>'lng')::double precision)/2),2)
  ));
  if v_distance>50 then raise exception 'Gå nærmere kontrollpunktet.'; end if;
  insert into public.funrun_checkpoint_visits(room_id,user_id,checkpoint_index) values (p_room_id,auth.uid(),p_checkpoint_index) on conflict do nothing;
  select count(*) into v_count from public.funrun_checkpoint_visits v where v.room_id=p_room_id and v.user_id=auth.uid();
  if v_count>=v_total then
    update public.funrun_rooms set phase='finished',winner='runners' where id=p_room_id;
    delete from public.funrun_positions where room_id=p_room_id;
  end if;
  return jsonb_build_object('visited',v_count,'total',v_total,'complete',v_count>=v_total);
end;
$$;

revoke all on function public.funrun_save_full_setup(uuid,text,integer,integer,integer,integer,jsonb,jsonb) from public, anon;
revoke all on function public.funrun_get_area_status(uuid) from public, anon;
revoke all on function public.funrun_get_visible_positions(uuid) from public, anon;
revoke all on function public.funrun_set_ready(uuid,boolean) from public, anon;
revoke all on function public.funrun_start_round(uuid) from public, anon;
revoke all on function public.funrun_advance_round(uuid) from public, anon;
revoke all on function public.funrun_confirm_tag(uuid) from public, anon;
revoke all on function public.funrun_apply_zone_penalty(uuid) from public, anon;
revoke all on function public.funrun_claim_package(uuid,uuid) from public, anon;
revoke all on function public.funrun_claim_checkpoint(uuid,integer) from public, anon;
grant execute on function public.funrun_save_full_setup(uuid,text,integer,integer,integer,integer,jsonb,jsonb) to authenticated;
grant execute on function public.funrun_get_area_status(uuid) to authenticated;
grant execute on function public.funrun_get_visible_positions(uuid) to authenticated;
grant execute on function public.funrun_set_ready(uuid,boolean) to authenticated;
grant execute on function public.funrun_start_round(uuid) to authenticated;
grant execute on function public.funrun_advance_round(uuid) to authenticated;
grant execute on function public.funrun_confirm_tag(uuid) to authenticated;
grant execute on function public.funrun_apply_zone_penalty(uuid) to authenticated;
grant execute on function public.funrun_claim_package(uuid,uuid) to authenticated;
grant execute on function public.funrun_claim_checkpoint(uuid,integer) to authenticated;
grant execute on function public.funrun_upsert_position(uuid,double precision,double precision) to authenticated;

do $$
begin
  begin alter publication supabase_realtime add table public.funrun_packages;
  exception when duplicate_object or undefined_object then null; end;
  begin alter publication supabase_realtime add table public.funrun_checkpoint_visits;
  exception when duplicate_object or undefined_object then null; end;
end;
$$;

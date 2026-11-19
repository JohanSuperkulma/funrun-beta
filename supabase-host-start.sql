-- FunRun host-start update for an existing Supabase project.
-- Run once after supabase-upgrade.sql.
-- Only the host must mark ready; the lobby still needs at least two players.

create or replace function public.funrun_start_round(p_room_id uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_room public.funrun_rooms%rowtype;
  v_count integer;
  v_hunter uuid;
  v_start timestamptz;
  v_now timestamptz := now();
begin
  select * into v_room from public.funrun_rooms r where r.id = p_room_id for update;
  if not found or v_room.host_id <> auth.uid() or v_room.phase <> 'lobby' then
    raise exception 'Bare verten kan starte lobbyen.';
  end if;
  select count(*) into v_count from public.funrun_members m where m.room_id = p_room_id;
  if v_count < 2 then raise exception 'Minst to spillere må være med.'; end if;
  if not exists(select 1 from public.funrun_members m where m.room_id=p_room_id and m.user_id=auth.uid() and m.ready) then
    raise exception 'Verten må lese reglene og trykke klar før start.';
  end if;
  if jsonb_array_length(coalesce(v_room.game_options->'zone','[]'::jsonb)) < 3 then
    raise exception 'Tegn et spilleområde med minst tre punkter først.';
  end if;
  if v_room.mode = 'checkpoints'
    and jsonb_array_length(coalesce(v_room.game_options->'checkpoints','[]'::jsonb))
      < least(10,greatest(1,coalesce((v_room.game_options->>'checkpointCount')::integer,3))) then
    raise exception 'Plasser alle kontrollpunktene før start.';
  end if;
  select m.user_id into v_hunter from public.funrun_members m where m.room_id = p_room_id order by random() limit 1;
  delete from public.funrun_roles where room_id = p_room_id;
  insert into public.funrun_roles(room_id,user_id,role)
  select m.room_id,m.user_id,case when m.user_id=v_hunter then 'hunter' else 'runner' end
  from public.funrun_members m where m.room_id=p_room_id;
  delete from public.funrun_positions where room_id = p_room_id;
  delete from public.funrun_checkpoint_visits where room_id = p_room_id;
  update public.funrun_packages set claimed_at=null,claimed_by=null,outcome=null where room_id=p_room_id;
  v_start := v_now + make_interval(secs => v_room.headstart_seconds);
  update public.funrun_rooms r set phase='live',started_at=v_start,
    ends_at=v_start+make_interval(mins=>r.duration_minutes),
    reveal_until=case when r.reveal_every_minutes=0 then null else v_start+make_interval(secs=>r.reveal_seconds) end,
    next_reveal_at=case when r.reveal_every_minutes=0 then null else v_start+make_interval(mins=>r.reveal_every_minutes) end,
    winner=null where r.id=p_room_id;
end;
$$;

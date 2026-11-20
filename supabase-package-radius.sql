-- Enforce the agreed 10 m package-opening radius in the live Supabase app.
-- Run this once in Supabase SQL Editor after supabase-upgrade.sql.
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
  if v_distance>10 then raise exception 'Gå inn i den lysende 10-meterssirkelen rundt pakken før du åpner den.'; end if;
  v_roll := floor(random()*4)::integer;
  if v_roll=0 then v_outcome:='extreme_advantage';v_level:='Ekstrem fordel';v_effect:='Laget ditt får en ekstra kartvisning. Avtal tidspunktet med de andre.';
  elsif v_roll=1 then v_outcome:='advantage';v_level:='Fordel';v_effect:='Laget ditt får 15 sekunder ekstra på neste kartvisning.';
  elsif v_roll=2 then v_outcome:='disadvantage';v_level:='Ulempe';v_effect:='Motstanderlaget får en ekstra kartvisning.';
  else v_outcome:='extreme_disadvantage';v_level:='Ekstrem ulempe';v_effect:='Motstanderlaget får 30 sekunder ekstra på neste kartvisning.'; end if;
  update public.funrun_packages set claimed_at=now(),claimed_by=auth.uid(),outcome=v_outcome where id=p_package_id;
  return jsonb_build_object('level',v_level,'effect',v_effect,'outcome',v_outcome);
end;
$$;

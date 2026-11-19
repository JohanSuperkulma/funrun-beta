import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { supabaseConfig } from "./supabase-config.js";

const $ = selector => document.querySelector(selector);
const authGate = $("#auth-gate");
const appView = $("#app-view");
const statusNode = $("#status");
const setStatus = message => { statusNode.textContent = message || ""; };
const configured = supabaseConfig.url && supabaseConfig.publishableKey && !supabaseConfig.publishableKey.includes("PASTE_");
const DEFAULT_OPTIONS = {
  zone: [], checkpoints: [], checkpointCount: 3, checkpointOrder: "any", pendingPackages: [],
  positionDisplay: "names", positionPrecision: "approx", outsideRule: "out", packagesEnabled: false
};

if (!configured) {
  authGate.hidden = false;
  $("#setup-note").hidden = false;
  $("#auth-form").hidden = true;
} else {
  const supabase = createClient(supabaseConfig.url, supabaseConfig.publishableKey);
  let user = null, roomId = null, room = null, members = [], roles = [], requests = [], packages = [], checkpointVisits = [];
  let pendingPhone = "", pendingPhoneName = "";
  let channel = null, refreshTimer = null, refreshBusy = false, refreshAgain = false, gameTimer = null;
  let gpsWatch = null, gameMap = null, setupMap = null, ownMarker = null, setupLayers = null, gameLayers = null;
  let otherMarkers = new Map(), gameOptions = { ...DEFAULT_OPTIONS }, mapTool = null, searchResults = [];
  let lastSetupZoneKey = "", lastGameZoneKey = "";
  let settingsDirty = false, lastPositionSentAt = 0, lastPositionFetchAt = 0, positionFetchBusy = false;
  let currentPosition = null, lastDistancePoint = null, distanceMeters = 0, gpsWarnings = 0;
  let outsideTimer = null, outside = false, packageClaimBusy = new Set(), checkpointClaimBusy = new Set(), lastAdvanceAt = 0;

  const currentRole = () => roles.find(row => row.user_id === user?.id)?.role || null;
  const currentName = () => String(user?.user_metadata?.display_name || user?.email?.split("@")[0] || "Spiller").slice(0, 24);
  const requestedName = () => ($("#display-name").value.trim() || currentName()).slice(0, 24);
  const normalizePhoneNumber = value => {
    let phone=value.trim().replace(/[\s().-]/g,"");
    if(phone.startsWith("00"))phone="+"+phone.slice(2);
    if(/^\d{8}$/.test(phone))phone="+47"+phone;
    if(!/^\+[1-9]\d{7,14}$/.test(phone))throw new Error("Skriv inn et gyldig telefonnummer med landskode, for eksempel +47 123 45 678.");
    return phone;
  };
  const currentMember = () => members.find(member => member.user_id === user?.id);
  const isHost = () => room?.host_id === user?.id;
  const setView = name => {
    $("#home-view").hidden = name !== "home";
    $("#room-view").hidden = name !== "room";
    $("#game-view").hidden = name !== "game";
  };
  const showError = (error, fallback = "Noe gikk galt. Prøv igjen.") => {
    const message = String(error?.message || "");
    if (/game_options|funrun_save_full_setup|funrun_packages|funrun_checkpoint_visits|funrun_get_area_status|funrun_get_visible_positions|funrun_apply_zone_penalty|funrun_claim_package|funrun_claim_checkpoint/i.test(message)) {
      $("#setup-note").hidden = false;
      setStatus("FunRun-databasen må oppdateres før alle funksjonene kan brukes.");
      return;
    }
    setStatus(message || fallback);
  };
  const callRpc = async (name, args) => {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw error;
    return data;
  };
  const mapTiles = target => window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(target);
  const clearRemoteMarkers = () => {
    otherMarkers.forEach(marker => marker.remove());
    otherMarkers.clear();
  };
  const closeMaps = () => {
    clearRemoteMarkers();
    if (ownMarker) ownMarker.remove();
    ownMarker = null;
    if (gameMap) gameMap.remove();
    if (setupMap) setupMap.remove();
    gameMap = null; setupMap = null; gameLayers = null; setupLayers = null;
  };
  const stopGps = (message = true) => {
    if (gpsWatch !== null && navigator.geolocation) navigator.geolocation.clearWatch(gpsWatch);
    gpsWatch = null;
    if (outsideTimer) clearTimeout(outsideTimer);
    outsideTimer = null; outside = false;
    $("#gps-toggle").textContent = "Start GPS";
    if (roomId && user) callRpc("funrun_delete_position", { p_room_id: roomId }).catch(() => {});
    if (ownMarker) { ownMarker.remove(); ownMarker = null; }
    currentPosition = null;
    lastDistancePoint = null;
    if (message && room?.phase === "live") $("#gps-status").textContent = "GPS er stoppet. Posisjonen er fjernet fra runden.";
  };
  const unsubscribeRoom = () => {
    if (channel) supabase.removeChannel(channel).catch(() => {});
    channel = null;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    if (gameTimer) clearInterval(gameTimer);
    gameTimer = null;
    if (gpsWatch !== null && navigator.geolocation) navigator.geolocation.clearWatch(gpsWatch);
    gpsWatch = null;
    if (outsideTimer) clearTimeout(outsideTimer);
    outsideTimer = null;
    closeMaps();
    roomId = null; room = null; members = []; roles = []; requests = []; packages = []; checkpointVisits = [];
    lastSetupZoneKey = ""; lastGameZoneKey = "";
    settingsDirty = false; currentPosition = null; lastDistancePoint = null; distanceMeters = 0; gpsWarnings = 0;
    setView("home");
  };
  const ensureSetupMap = () => {
    if (setupMap || !window.L) return;
    setupMap = window.L.map("setup-map", { zoomControl: true }).setView([59.197, 9.608], 14);
    mapTiles(setupMap);
    setupLayers = window.L.layerGroup().addTo(setupMap);
    setupMap.on("click", event => {
      if (!isHost() || room?.phase !== "lobby" || !mapTool) return;
      const point = { lat: event.latlng.lat, lng: event.latlng.lng };
      if (mapTool === "zone") {
        if (gameOptions.zone.length >= 24) { setStatus("Et område kan ha maks 24 punkter."); return; }
        gameOptions.zone.push(point);
      } else if (mapTool === "package") {
        if (!gameOptions.packagesEnabled) { setStatus("Slå på pakker i rundeoppsettet først."); return; }
        if (gameOptions.pendingPackages.length >= 8) { setStatus("Du kan legge ut maks 8 pakker."); return; }
        if (gameOptions.zone.length >= 3 && !insideZone(point, gameOptions.zone)) { setStatus("Plasser pakken innenfor spilleområdet."); return; }
        gameOptions.pendingPackages.push(point);
      } else if (mapTool === "checkpoint") {
        const max = Math.min(10, Number($("#checkpoint-count").value) || gameOptions.checkpointCount || 3);
        if (gameOptions.checkpoints.length >= max) { setStatus("Alle kontrollpunktene er plassert."); return; }
        if (gameOptions.zone.length >= 3 && !insideZone(point, gameOptions.zone)) { setStatus("Plasser kontrollpunktet innenfor spilleområdet."); return; }
        gameOptions.checkpoints.push(point);
      }
      settingsDirty = true;
      renderSetupMap();
      renderMapSummary();
    });
    window.requestAnimationFrame(() => setupMap && setupMap.invalidateSize());
  };
  const ensureGameMap = () => {
    if (gameMap || !window.L) return;
    gameMap = window.L.map("game-map", { zoomControl: true }).setView([59.197, 9.608], 15);
    mapTiles(gameMap);
    gameLayers = window.L.layerGroup().addTo(gameMap);
    window.requestAnimationFrame(() => gameMap && gameMap.invalidateSize());
  };
  const renderSetupMap = () => {
    ensureSetupMap();
    if (!setupMap || !setupLayers) return;
    setupLayers.clearLayers();
    if (gameOptions.zone.length >= 2) window.L.polyline(gameOptions.zone.map(p => [p.lat,p.lng]), { color:"#36a56c", weight:4, dashArray:"7 6" }).addTo(setupLayers);
    if (gameOptions.zone.length >= 3) window.L.polygon(gameOptions.zone.map(p => [p.lat,p.lng]), { color:"#36a56c", weight:3, fillColor:"#36a56c", fillOpacity:.08 }).addTo(setupLayers);
    gameOptions.zone.forEach((p,i) => window.L.circleMarker([p.lat,p.lng], { radius:5, color:"#fff", weight:2, fillColor:"#36a56c", fillOpacity:1 }).bindTooltip(String(i+1)).addTo(setupLayers));
    const pending = gameOptions.pendingPackages || packages.filter(p => !p.claimed_at).map(p => ({lat:p.lat,lng:p.lng}));
    pending.forEach(p => {
      window.L.marker([p.lat,p.lng], { icon:window.L.divIcon({ className:"", html:"<span style='font-size:24px'>📦</span>", iconSize:[28,28], iconAnchor:[14,14] }) }).addTo(setupLayers);
    });
    gameOptions.checkpoints.forEach((p,i) => window.L.circleMarker([p.lat,p.lng], { radius:12, color:"#fff", weight:2, fillColor:"#f0a34b", fillOpacity:1 }).bindTooltip(String(i+1), { permanent:true }).addTo(setupLayers));
    const zoneKey = JSON.stringify(gameOptions.zone);
    if (gameOptions.zone.length && zoneKey !== lastSetupZoneKey && mapTool !== "zone") {
      const bounds = window.L.latLngBounds(gameOptions.zone.map(p => [p.lat,p.lng]));
      if (bounds.isValid()) setupMap.fitBounds(bounds.pad(.16), { animate:false });
      lastSetupZoneKey = zoneKey;
    }
    window.requestAnimationFrame(() => setupMap && setupMap.invalidateSize());
  };
  const renderMapSummary = () => {
    const count = gameOptions.zone.length;
    const checkpointText = $("#mode").value === "checkpoints" ? " · " + gameOptions.checkpoints.length + "/" + gameOptions.checkpointCount + " kontrollpunkter" : "";
    const packageText = gameOptions.packagesEnabled ? " · " + (gameOptions.pendingPackages || packages.filter(p => !p.claimed_at).map(p=>({lat:p.lat,lng:p.lng}))).length + " pakker" : "";
    $("#map-summary").textContent = (count >= 3 ? count + " punkter i spilleområdet" : count + "/3 områdepunkter") + checkpointText + packageText;
  };
  const setMapTool = tool => {
    mapTool = mapTool === tool ? null : tool;
    document.querySelectorAll("[data-map-tool]").forEach(button => button.classList.toggle("selected", button.dataset.mapTool === mapTool));
    const help = mapTool === "zone" ? "Trykk på kartet for å tegne spilleområdet. Minst tre punkter." :
      mapTool === "package" ? "Trykk på kartet for å plassere pakker. Maks 8." :
      mapTool === "checkpoint" ? "Trykk på kartet for å plassere kontrollpunkter." :
      "Kartredigeringen er ferdig. Trykk på et verktøy for å tegne eller plassere markører.";
    $("#map-instructions").textContent = help;
  };
  const hydrateSettings = () => {
    if (!room || settingsDirty) return;
    const options = { ...DEFAULT_OPTIONS, ...(room.game_options || {}) };
    options.zone = Array.isArray(options.zone) ? options.zone : [];
    options.checkpoints = Array.isArray(options.checkpoints) ? options.checkpoints : [];
    options.pendingPackages = packages.filter(p => !p.claimed_at).map(p => ({lat:p.lat,lng:p.lng}));
    gameOptions = options;
    $("#mode").value = room.mode || "tag";
    $("#minutes").value = room.duration_minutes || 30;
    $("#headstart-enabled").checked = Number(room.headstart_seconds || 0) > 0;
    $("#headstart-seconds").value = Number(room.headstart_seconds || 60);
    $("#headstart-wrap").hidden = !$("#headstart-enabled").checked;
    const reveal = Number(room.reveal_every_minutes || 0);
    const preset = ["0","1","5","10","15","20","25","30","40","50","60"].includes(String(reveal));
    $("#reveal-every").value = preset ? String(reveal) : "custom";
    $("#custom-interval").value = preset ? 7 : reveal;
    $("#custom-interval-wrap").hidden = preset;
    $("#reveal-seconds").value = room.reveal_seconds || 15;
    $("#position-display").value = options.positionDisplay || "names";
    $("#position-precision").value = options.positionPrecision || "approx";
    $("#outside-rule").value = options.outsideRule || "out";
    $("#packages-enabled").checked = Boolean(options.packagesEnabled);
    $("#checkpoint-count").value = options.checkpointCount || 3;
    $("#checkpoint-order").value = options.checkpointOrder || "any";
    $("#checkpoint-settings").hidden = $("#mode").value !== "checkpoints";
    renderMapSummary();
  };
  const renderPlayers = () => {
    $("#player-list").replaceChildren(...members.map(member => {
      const li = document.createElement("li");
      const label = document.createElement("span"); label.textContent = member.display_name + (member.user_id === room.host_id ? " · vert" : "");
      li.append(label); return li;
    }));
    $("#start-round").textContent = members.length < 2 ? "Venter på minst én spiller til" : "Start runden";
  };
  const renderRoom = () => {
    if (!roomId || !room) return;
    $("#room-code").textContent = room.code;
    renderPlayers();
    $("#host-controls").hidden = !isHost() || room.phase !== "lobby";
    $("#leave-room").hidden = room.phase === "live";
    if (room.phase === "live" || room.phase === "finished") setView("game");
    else setView("room");
    if (room.phase === "lobby") {
      hydrateSettings();
      ensureSetupMap(); renderSetupMap();
    }
    const checkpointCount = Number(gameOptions.checkpointCount || 0);
    $("#checkpoint-settings").hidden = $("#mode").value !== "checkpoints";
    const hasZone = gameOptions.zone?.length >= 3;
    const checkpointsPlaced = $("#mode").value !== "checkpoints" || gameOptions.checkpoints.length >= checkpointCount;
    $("#start-round").disabled = !isHost() || members.length < 2 || !hasZone || !checkpointsPlaced;
  };
  const positionOptions = () => room?.game_options || DEFAULT_OPTIONS;
  const addMarkerForPosition = (point, display) => {
    let lat = Number(point.lat), lng = Number(point.lng);
    const options = positionOptions();
    if (options.positionPrecision !== "exact") {
      const grid = 0.0009;
      lat = Math.round(lat / grid) * grid; lng = Math.round(lng / grid) * grid;
    }
    const name = members.find(member => member.user_id === point.user_id)?.display_name || "Spiller";
    let marker = otherMarkers.get(point.user_id);
    if (!marker) {
      if (!gameMap) return;
      marker = window.L.circleMarker([lat,lng], { radius:10, color:"#fff", weight:2, fillColor:"#47c879", fillOpacity:.95 }).addTo(gameMap);
      otherMarkers.set(point.user_id, marker);
    }
    marker.setLatLng([lat,lng]);
    if (display === "names") marker.bindTooltip(name, { permanent:true, direction:"top" });
    else marker.unbindTooltip();
  };
  const syncPositions = async () => {
    const options = positionOptions();
    const revealing = room?.phase === "live" && room.started_at && Date.parse(room.started_at) <= Date.now() &&
      currentRole() === "hunter" &&
      (Number(room.reveal_every_minutes) === 0 || Date.parse(room.reveal_until || "") > Date.now());
    const areaStatus = $("#area-status");
    if (!revealing || !roomId) {
      areaStatus.hidden = true; clearRemoteMarkers(); return;
    }
    if (options.positionDisplay === "area") {
      clearRemoteMarkers(); areaStatus.hidden = false;
      if (positionFetchBusy || Date.now() - lastPositionFetchAt < 3500) return;
      positionFetchBusy = true; lastPositionFetchAt = Date.now();
      try {
        const { data, error } = await supabase.rpc("funrun_get_area_status", { p_room_id: roomId });
        if (error) throw error;
        areaStatus.textContent = data?.visible
          ? data.inside + " av " + data.sharing + " med GPS er i sonen · " + Math.max(0,data.runners-data.sharing) + " deler ikke GPS nå"
          : "Ingen soneoversikt akkurat nå.";
      } catch (error) { showError(error, "Kunne ikke hente soneoversikten."); }
      finally { positionFetchBusy = false; }
      return;
    }
    areaStatus.hidden = true;
    if (positionFetchBusy || Date.now() - lastPositionFetchAt < 3500) {
      return;
    }
    positionFetchBusy = true; lastPositionFetchAt = Date.now();
    try {
      const { data, error } = await supabase.rpc("funrun_get_visible_positions", { p_room_id: roomId });
      if (error) throw error;
      const active = new Set();
      for (const point of data || []) {
        if (point.user_id === user.id || Date.now() - Date.parse(point.updated_at) > 20000) continue;
        active.add(point.user_id); addMarkerForPosition(point, options.positionDisplay);
      }
      otherMarkers.forEach((marker,id) => { if (!active.has(id)) { marker.remove(); otherMarkers.delete(id); } });
    } catch (error) { showError(error, "Jegeren kunne ikke hente posisjonene."); }
    finally { positionFetchBusy = false; }
  };
  const renderGameMap = () => {
    ensureGameMap();
    if (!gameMap || !gameLayers || !room) return;
    gameLayers.clearLayers();
    const options = { ...DEFAULT_OPTIONS, ...(room.game_options || {}) };
    const zone = Array.isArray(options.zone) ? options.zone : [];
    if (zone.length >= 3) window.L.polygon(zone.map(p => [p.lat,p.lng]), { color:"#28a86a", weight:3, fillColor:"#28a86a", fillOpacity:.08, dashArray:"8 5" }).addTo(gameLayers);
    if (options.packagesEnabled) packages.filter(p => !p.claimed_at).forEach(p => window.L.marker([p.lat,p.lng], {
      icon:window.L.divIcon({ className:"", html:"<span style='font-size:24px'>📦</span>", iconSize:[28,28], iconAnchor:[14,14] })
    }).addTo(gameLayers));
    if (room.mode === "checkpoints") options.checkpoints.forEach((p,i) => window.L.circleMarker([p.lat,p.lng], { radius:13, color:"#fff", weight:2, fillColor:"#efa646", fillOpacity:.95 }).bindTooltip(String(i+1), { permanent:true }).addTo(gameLayers));
    if (currentPosition) {
      if (!ownMarker) ownMarker = window.L.circleMarker([currentPosition.lat,currentPosition.lng], { radius:9, color:"#fff", weight:3, fillColor:"#1685f8", fillOpacity:1 }).bindTooltip("Du", { permanent:true, direction:"top" }).addTo(gameMap);
      else ownMarker.setLatLng([currentPosition.lat,currentPosition.lng]);
      if (!gameMap.getBounds().contains([currentPosition.lat,currentPosition.lng])) gameMap.panTo([currentPosition.lat,currentPosition.lng]);
    } else if (zone.length >= 3) {
      const zoneKey = JSON.stringify(zone);
      if (zoneKey !== lastGameZoneKey) {
        gameMap.fitBounds(window.L.latLngBounds(zone.map(p => [p.lat,p.lng])).pad(.12), { animate:false });
        lastGameZoneKey = zoneKey;
      }
    }
    window.requestAnimationFrame(() => gameMap && gameMap.invalidateSize());
  };
  const secondsText = value => Math.floor(value/60) + ":" + String(value%60).padStart(2,"0");
  const renderGame = () => {
    if (!room || !user) return;
    const role = currentRole(), now = Date.now(), startAt = Date.parse(room.started_at || "");
    if ((role === "out" || room.phase !== "live") && (gpsWatch !== null || currentPosition || ownMarker)) stopGps(false);
    setView("game"); renderGameMap();
    let status = room.phase === "finished"
      ? (room.winner === "hunter" ? "Jegerlaget vant!" : room.winner === "runners" ? "Flukterne vant!" : "Runden er ferdig.")
      : role === "hunter" ? "Du er jeger." : role === "out" ? "Du er ute." : "Du er på flukt.";
    const remaining = room.phase === "live" && room.ends_at ? Math.max(0, Math.ceil((Date.parse(room.ends_at)-now)/1000)) : 0;
    if (room.phase === "live" && startAt > now) { status = "Forsprang — gjem dere!"; $("#timer").textContent = secondsText(Math.ceil((startAt-now)/1000)); }
    else $("#timer").textContent = room.phase === "live" ? secondsText(remaining) : "00:00";
    $("#game-status").textContent = status;
    const targets = roles.filter(r => r.role === "runner" && r.user_id !== user.id).map(r => members.find(m => m.user_id === r.user_id)).filter(Boolean);
    $("#tag-target").replaceChildren(...targets.map(member => { const option=document.createElement("option"); option.value=member.user_id; option.textContent=member.display_name; return option; }));
    $("#tag-target-label").hidden = room.phase !== "live" || role !== "hunter";
    $("#request-tag").hidden = room.phase !== "live" || role !== "hunter";
    $("#gps-toggle").disabled = room.phase !== "live" || role === "out" || startAt > now;
    $("#area-status").hidden = room.phase !== "live" || role !== "hunter" || room.game_options?.positionDisplay !== "area";
    if (!$("#area-status").hidden) $("#area-status").textContent = "Soneoversikt vises i kartperiodene.";
    $("#open-package").hidden = room.phase !== "live" || !currentPosition || !room.game_options?.packagesEnabled || !packages.some(p => !p.claimed_at && haversine(currentPosition,{lat:p.lat,lng:p.lng}) <= 45);
    const incoming = requests.find(request => request.target_id === user.id && request.status === "pending");
    $("#tag-confirm").hidden = !incoming;
    if (incoming) {
      const hunterName = members.find(member => member.user_id === incoming.hunter_id)?.display_name || "Jegeren";
      $("#tag-confirm-text").textContent = hunterName + " sier at dere tok på hverandre. Stopp og bekreft bare hvis det stemmer.";
    }
    if (room.phase === "finished") {
      $("#gps-status").textContent = "Runden er ferdig · Du gikk/løp ca. " + (distanceMeters/1000).toFixed(2) + " km · " + gpsWarnings + " GPS-varsler.";
      $("#gps-toggle").hidden = true; $("#request-tag").hidden = true; $("#tag-target-label").hidden = true;
    } else {
      $("#gps-toggle").hidden = false;
      if (startAt > now) $("#gps-status").textContent = "GPS-knappen blir tilgjengelig når nedtellingen er ferdig.";
      else if (gpsWatch === null) $("#gps-status").textContent = "GPS er av. Trykk Start GPS for å dele posisjonen din med spillet.";
    }
    const visits = checkpointVisits.filter(v => v.user_id === user.id).length;
    $("#checkpoint-progress").hidden = room.mode !== "checkpoints" || role !== "runner";
    $("#checkpoint-progress").textContent = visits + "/" + (room.game_options?.checkpointCount || 0) + " kontrollpunkter nådd";
    if (room.phase === "live" && !gameTimer) gameTimer = setInterval(gameTick,1000);
    if (room.phase !== "live" && gameTimer) { clearInterval(gameTimer); gameTimer=null; stopGps(false); }
    syncPositions();
  };
  const queueRefresh = () => {
    if(refreshTimer)clearTimeout(refreshTimer);
    refreshTimer=setTimeout(()=>{refreshTimer=null;refreshRoom();},150);
  };
  const refreshRoom = async () => {
    if(!roomId||refreshBusy){refreshAgain=true;return;}
    refreshBusy=true;
    try{
      const results=await Promise.all([
        supabase.from("funrun_rooms").select("*").eq("id",roomId).maybeSingle(),
        supabase.from("funrun_members").select("user_id,display_name,joined_at").eq("room_id",roomId).order("joined_at"),
        supabase.from("funrun_roles").select("user_id,role").eq("room_id",roomId),
        supabase.from("funrun_tag_requests").select("id,room_id,hunter_id,target_id,status,created_at").eq("room_id",roomId).order("created_at",{ascending:false}),
        supabase.from("funrun_packages").select("id,room_id,lat,lng,claimed_at,claimed_by,outcome").eq("room_id",roomId),
        supabase.from("funrun_checkpoint_visits").select("room_id,user_id,checkpoint_index,visited_at").eq("room_id",roomId)
      ]);
      for(const result of results)if(result.error)throw result.error;
      if(!results[0].data){unsubscribeRoom();setStatus("Lobbyen finnes ikke lenger.");return;}
      room=results[0].data;members=results[1].data||[];roles=results[2].data||[];requests=results[3].data||[];
      packages=results[4].data||[];checkpointVisits=results[5].data||[];
      renderRoom();
      if(room.phase==="live"||room.phase==="finished")renderGame();
      setStatus("");
    }catch(error){showError(error,"Kunne ikke hente lobbyen. Sjekk internett og prøv igjen.");}
    finally{refreshBusy=false;if(refreshAgain){refreshAgain=false;queueRefresh();}}
  };
  const subscribeRoom = async id => {
    unsubscribeRoom();roomId=id;
    channel=supabase.channel("funrun-room-"+id)
      .on("postgres_changes",{event:"*",schema:"public",table:"funrun_rooms",filter:"id=eq."+id},queueRefresh)
      .on("postgres_changes",{event:"*",schema:"public",table:"funrun_members",filter:"room_id=eq."+id},queueRefresh)
      .on("postgres_changes",{event:"*",schema:"public",table:"funrun_roles",filter:"room_id=eq."+id},queueRefresh)
      .on("postgres_changes",{event:"*",schema:"public",table:"funrun_tag_requests",filter:"room_id=eq."+id},queueRefresh)
      .on("postgres_changes",{event:"*",schema:"public",table:"funrun_positions",filter:"room_id=eq."+id},syncPositions)
      .on("postgres_changes",{event:"*",schema:"public",table:"funrun_packages",filter:"room_id=eq."+id},queueRefresh)
      .on("postgres_changes",{event:"*",schema:"public",table:"funrun_checkpoint_visits",filter:"room_id=eq."+id},queueRefresh)
      .subscribe(state=>{if(state==="CHANNEL_ERROR"||state==="TIMED_OUT")setStatus("Live-oppdateringen mistet nett. Sjekk forbindelsen.");});
    setView("room");setStatus("Kobler til lobbyen …");await refreshRoom();
  };
  const createRoom = async () => {
    setStatus("Lager lobby …");
    try{const data=await callRpc("funrun_create_room",{p_display_name:requestedName(),p_mode:"tag",p_duration_minutes:30,p_reveal_every_minutes:5,p_reveal_seconds:15});await subscribeRoom(data.room_id);}
    catch(error){showError(error,"Kunne ikke lage lobbyen.");}
  };
  const joinRoom = async () => {
    const code=$("#join-code").value.trim().toUpperCase();
    if(!/^[A-F0-9]{8}$/.test(code)){setStatus("Lobbykoden skal være 8 bokstaver eller tall.");return;}
    setStatus("Blir med i lobbyen …");
    try{const data=await callRpc("funrun_join_room",{p_code:code,p_display_name:requestedName()});await subscribeRoom(data.room_id);}
    catch(error){showError(error,"Fant ikke en åpen lobby med den koden.");}
  };
  const collectSettings = () => {
    const selected=$("#reveal-every").value;
    const revealEvery=selected==="custom"?Number($("#custom-interval").value):Number(selected);
    const minutes=Number($("#minutes").value), revealSeconds=Number($("#reveal-seconds").value);
    const headstart=$("#headstart-enabled").checked?Number($("#headstart-seconds").value):0;
    const checkpointCount=Math.min(10,Math.max(1,Number($("#checkpoint-count").value)||1));
    if(!Number.isInteger(minutes)||minutes<1||minutes>120)throw new Error("Runden må vare 1–120 hele minutter.");
    if(!Number.isInteger(revealEvery)||revealEvery<0||revealEvery>60)throw new Error("Kartintervallet må være 0–60 hele minutter.");
    if(!Number.isInteger(revealSeconds)||revealSeconds<1||revealSeconds>120)throw new Error("Posisjoner kan vises i 1–120 hele sekunder.");
    if($("#headstart-enabled").checked&&(!Number.isInteger(headstart)||headstart<1||headstart>3600))throw new Error("Nedtellingen må være 1–3600 hele sekunder.");
    gameOptions={...gameOptions,checkpointCount,checkpointOrder:$("#checkpoint-order").value,
      positionDisplay:$("#position-display").value,positionPrecision:$("#position-precision").value,
      outsideRule:$("#outside-rule").value,packagesEnabled:$("#packages-enabled").checked,
      pendingPackages:gameOptions.pendingPackages||packages.filter(p=>!p.claimed_at).map(p=>({lat:p.lat,lng:p.lng}))};
    gameOptions.checkpoints=gameOptions.checkpoints.slice(0,checkpointCount);
    return {mode:$("#mode").value,minutes,revealEvery,revealSeconds,headstart,options:gameOptions};
  };
  const persistSettings = async () => {
    const settings=collectSettings();
    if(settings.mode==="checkpoints"&&settings.options.checkpoints.length<settings.options.checkpointCount)throw new Error("Plasser " + settings.options.checkpointCount + " kontrollpunkter på kartet først.");
    if(!settings.options.packagesEnabled)settings.options.pendingPackages=[];
    const {error}=await supabase.rpc("funrun_save_full_setup",{p_room_id:roomId,p_mode:settings.mode,p_duration_minutes:settings.minutes,p_headstart_seconds:settings.headstart,p_reveal_every_minutes:settings.revealEvery,p_reveal_seconds:settings.revealSeconds,p_game_options:settings.options,p_packages:settings.options.pendingPackages});
    if(error)throw error;
    settingsDirty=false;gameOptions.pendingPackages=[];
    await refreshRoom();
  };
  const saveSettings = async () => {
    if(!roomId||!isHost())return;
    try{await persistSettings();setStatus("Oppsettet er lagret.");}
    catch(error){showError(error,"Kunne ikke lagre oppsettet.");}
  };
  const startRound = async () => {
    if(!roomId||!isHost())return;
    const button=$("#start-round");
    button.disabled=true;
    try{
      setStatus("Lagrer rundeoppsettet og starter …");
      await persistSettings();
      button.disabled=true;
      await callRpc("funrun_start_round",{p_room_id:roomId});
      await refreshRoom();
      setStatus("Runden har startet! Trykk Start GPS for å dele posisjonen din.");
    }catch(error){
      if(/Verten må lese reglene/i.test(error?.message||"")) setStatus("Kjør den oppdaterte SQL-filen i Supabase før du starter.");
      else showError(error,"Kunne ikke starte runden.");
    }finally{
      if(room?.phase==="lobby")renderRoom();
    }
  };
  const haversine = (a,b) => {
    const rad=n=>n*Math.PI/180,R=6371000,dLat=rad(b.lat-a.lat),dLng=rad(b.lng-a.lng);
    const value=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLng/2)**2;
    return R*2*Math.atan2(Math.sqrt(value),Math.sqrt(1-value));
  };
  const insideZone = (point,polygon) => {
    if(!polygon||polygon.length<3)return true;
    let inside=false;
    for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
      const a=polygon[i],b=polygon[j];
      const intersects=((a.lng>point.lng)!==(b.lng>point.lng))&&(point.lat<(b.lat-a.lat)*(point.lng-a.lng)/(b.lng-a.lng||1e-12)+a.lat);
      if(intersects)inside=!inside;
    }
    return inside;
  };
  const distanceToBoundary = (point,polygon) => {
    if(!polygon||polygon.length<2)return Infinity;
    const mLat=111320,mLng=111320*Math.cos(point.lat*Math.PI/180);let best=Infinity;
    for(let i=0;i<polygon.length;i++){
      const a=polygon[i],b=polygon[(i+1)%polygon.length],ax=(a.lng-point.lng)*mLng,ay=(a.lat-point.lat)*mLat,bx=(b.lng-point.lng)*mLng,by=(b.lat-point.lat)*mLat;
      const dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy||1)));
      best=Math.min(best,Math.hypot(ax+t*dx,ay+t*dy));
    }
    return best;
  };
  const checkZone = point => {
    const polygon=room?.game_options?.zone||[];
    if(polygon.length<3)return;
    if(point.accuracy>100){
      if(outsideTimer){clearTimeout(outsideTimer);outsideTimer=null;}
      outside=false;$("#gps-status").classList.remove("alert");$("#gps-status").textContent="GPS-signalet er unøyaktig akkurat nå. Vent litt på bedre signal.";return;
    }
    const isInside=insideZone(point,polygon),near=!isInside||distanceToBoundary(point,polygon)<35;
    $("#gps-status").classList.toggle("alert",near);
    if(isInside){
      if(outsideTimer){clearTimeout(outsideTimer);outsideTimer=null;}
      outside=false;
      $("#gps-status").textContent=near?"Du nærmer deg grensen. Hold deg innenfor sonen.":"GPS aktiv. Du er innenfor spilleområdet.";
      return;
    }
    if(!outside)gpsWarnings++;
    $("#gps-status").textContent="Du er utenfor sonen. Gå inn igjen innen 10 sekunder.";
    if(!outsideTimer){
      outside=true;
      if(currentRole()!=="runner")return;
      outsideTimer=setTimeout(async()=>{
        outsideTimer=null;
        if(!outside||!currentPosition||insideZone(currentPosition,room?.game_options?.zone||[]))return;
        try{await callRpc("funrun_apply_zone_penalty",{p_room_id:roomId});$("#gps-status").textContent="Du var utenfor sonen i 10 sekunder. Regelen er brukt.";await refreshRoom();}
        catch(error){showError(error,"Kunne ikke bruke regelen for sonegrensen.");}
      },10000);
    }
  };
  const checkNearbyItems = async point => {
    if(!room||room.phase!=="live")return;
    if(point.accuracy>60)return;
    if(room.game_options?.packagesEnabled){
      const pkg=packages.find(p=>!p.claimed_at&&haversine(point,{lat:p.lat,lng:p.lng})<=45);
      if(pkg&&!packageClaimBusy.has(pkg.id)){
        packageClaimBusy.add(pkg.id);
        try{const result=await callRpc("funrun_claim_package",{p_room_id:roomId,p_package_id:pkg.id});$("#package-result").hidden=false;$("#package-result").textContent=result.level+": "+result.effect;await refreshRoom();}
        catch(error){if(!/ikke nær nok|not near/i.test(error.message||""))showError(error,"Kunne ikke åpne pakken.");}
        finally{packageClaimBusy.delete(pkg.id);}
      }
    }
    if(room.mode==="checkpoints"&&currentRole()==="runner"){
      const points=room.game_options?.checkpoints||[];
      for(let i=0;i<points.length;i++){
        if(checkpointVisits.some(v=>v.user_id===user.id&&Number(v.checkpoint_index)===i)||checkpointClaimBusy.has(i))continue;
        if(haversine(point,points[i])<=40){
          checkpointClaimBusy.add(i);
          try{await callRpc("funrun_claim_checkpoint",{p_room_id:roomId,p_checkpoint_index:i});await refreshRoom();}
          catch(error){if(!/ikke nær nok|not near|wrong checkpoint/i.test(error.message||""))showError(error,"Kunne ikke registrere kontrollpunktet.");}
          finally{checkpointClaimBusy.delete(i);}
        }
      }
    }
  };
  const gpsError = error => {
    if(gpsWatch!==null&&navigator.geolocation)navigator.geolocation.clearWatch(gpsWatch);
    gpsWatch=null;$("#gps-toggle").textContent="Start GPS";
    if(error?.code===1)$("#gps-status").textContent="Posisjonstilgang ble avslått. Tillat posisjon for denne nettsiden i nettleseren, og prøv igjen.";
    else if(error?.code===2)$("#gps-status").textContent="Telefonen finner ikke posisjonen nå. Slå på posisjonstjenester og gå ut med fri sikt.";
    else if(error?.code===3)$("#gps-status").textContent="GPS brukte for lang tid. Prøv igjen utendørs.";
    else $("#gps-status").textContent="GPS kunne ikke startes. Sjekk posisjonstilgangen i nettleseren.";
  };
  const startGps = () => {
    if(!navigator.geolocation){$("#gps-status").textContent="Nettleseren støtter ikke GPS.";return;}
    if(!window.isSecureContext){$("#gps-status").textContent="GPS krever en sikker HTTPS-nettside.";return;}
    if(!roomId||room?.phase!=="live"||currentRole()==="out")return;
    if(Date.parse(room.started_at||"")>Date.now()){$("#gps-status").textContent="GPS blir tilgjengelig når nedtellingen er ferdig.";return;}
    $("#gps-status").textContent="Venter på GPS-tillatelse. Trykk Tillat når nettleseren spør.";
    $("#gps-toggle").textContent="Starter GPS …";
    try{gpsWatch=navigator.geolocation.watchPosition(async position=>{
      if(!roomId||room?.phase!=="live"||currentRole()==="out"){stopGps(false);return;}
      const point={lat:position.coords.latitude,lng:position.coords.longitude,accuracy:position.coords.accuracy};
      if(lastDistancePoint&&position.coords.accuracy<=100) {
        const moved=haversine(lastDistancePoint,point);
        if(moved<120)distanceMeters+=moved;
      }
      if(position.coords.accuracy<=100)lastDistancePoint=point;
      currentPosition=point;ensureGameMap();
      if(gameMap){
        if(!ownMarker)ownMarker=window.L.circleMarker([point.lat,point.lng],{radius:9,color:"#fff",weight:3,fillColor:"#1685f8",fillOpacity:1}).bindTooltip("Du",{permanent:true,direction:"top"}).addTo(gameMap);
        else ownMarker.setLatLng([point.lat,point.lng]);
        if(!gameMap.getBounds().contains([point.lat,point.lng]))gameMap.setView([point.lat,point.lng],Math.max(gameMap.getZoom(),16));
      }
      $("#gps-toggle").textContent="Stopp GPS";checkZone(point);
      const now=Date.now();
      if(now-lastPositionSentAt>=5000){
        lastPositionSentAt=now;
        try{await callRpc("funrun_upsert_position",{p_room_id:roomId,p_lat:point.lat,p_lng:point.lng});if(point.accuracy<=60)await checkNearbyItems(point);}
        catch(error){showError(error,"GPS ble ikke delt. Kontroller at du er i den aktive lobbyen.");}
      }
    },gpsError,{enableHighAccuracy:true,maximumAge:1500,timeout:25000});}
    catch(error){gpsWatch=null;$("#gps-toggle").textContent="Start GPS";showError(error,"GPS kunne ikke startes i denne nettleseren.");}
  };
  const gameTick = () => {
    if(!room||room.phase!=="live")return;
    const now=Date.now(),startAt=Date.parse(room.started_at||"");
    if(startAt>now){$("#timer").textContent=secondsText(Math.ceil((startAt-now)/1000));$("#game-status").textContent="Forsprang — gjem dere!";return;}
    const remaining=Math.max(0,Math.ceil((Date.parse(room.ends_at||"")-now)/1000));
    $("#timer").textContent=secondsText(remaining);
    $("#gps-toggle").disabled=currentRole()==="out"||startAt>now;
    if(currentRole()==="hunter")$("#game-status").textContent="Du er jeger.";
    else if(currentRole()==="out")$("#game-status").textContent="Du er ute.";
    else $("#game-status").textContent="Du er på flukt.";
    const shouldAdvance=isHost()&&(remaining<=0||(Number(room.reveal_every_minutes)>0&&Date.parse(room.next_reveal_at||"")<=now));
    if(shouldAdvance&&now-lastAdvanceAt>1400){lastAdvanceAt=now;callRpc("funrun_advance_round",{p_room_id:roomId}).then(refreshRoom).catch(error=>showError(error));}
    syncPositions();
  };
  const searchPlaces = async () => {
    const query=$("#place-search").value.trim();
    if(query.length<2){$("#place-status").textContent="Skriv minst to bokstaver.";return;}
    $("#place-status").textContent="Søker i Norge …";
    try{
      const url="https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=no&limit=5&accept-language=no&q="+encodeURIComponent(query);
      const response=await fetch(url,{headers:{"Accept":"application/json"}});
      if(!response.ok)throw new Error("Stedssøket svarte ikke. Prøv igjen.");
      searchResults=await response.json();const holder=$("#place-results");holder.replaceChildren();
      searchResults.forEach((place,index)=>{
        const button=document.createElement("button");button.type="button";button.textContent=place.display_name;button.dataset.index=String(index);
        button.addEventListener("click",()=>{
          const selected=searchResults[index],center=[Number(selected.lat),Number(selected.lon)];
          ensureSetupMap();setupMap.setView(center,16);$("#place-search").value=selected.name||selected.display_name.split(",")[0];holder.replaceChildren();$("#place-status").textContent="Kartet er flyttet til "+$("#place-search").value+".";
        });
        holder.append(button);
      });
      $("#place-status").textContent=searchResults.length?"Velg stedet du mente.":"Fant ingen steder i Norge med det navnet.";
    }catch(error){$("#place-status").textContent=error.message||"Stedssøket feilet.";}
  };

  $("#guest-form").addEventListener("submit",async event=>{
    event.preventDefault();const name=$("#guest-display-name").value.trim();
    if(name.length<2){setStatus("Skriv inn et navn på minst to tegn.");return;}
    const button=$("#guest-submit");button.disabled=true;setStatus("Lager gjestekonto …");
    try{const {error}=await supabase.auth.signInAnonymously({options:{data:{display_name:name.slice(0,24)}}});if(error)throw error;setStatus("");}
    catch(error){if(error?.status===429)setStatus("Mange prøver samtidig. Vent litt og prøv igjen.");else showError(error,"Kunne ikke starte som gjest.");}
    finally{button.disabled=false;}
  });
  $("#auth-form").addEventListener("submit",async event=>{
    event.preventDefault();setStatus("Logger inn …");const email=$("#email").value.trim(),password=$("#password").value;
    try{
      if($("#auth-mode").value==="create"){
        const name=$("#display-name").value.trim();if(name.length<2)throw new Error("Skriv inn et visningsnavn på minst to tegn.");
        const {data,error}=await supabase.auth.signUp({email,password,options:{data:{display_name:name.slice(0,24)},emailRedirectTo:location.origin+location.pathname}});
        if(error)throw error;if(!data.session)setStatus("Sjekk e-posten din og trykk på bekreftelseslenken før du logger inn.");else setStatus("");
      }else{const {error}=await supabase.auth.signInWithPassword({email,password});if(error)throw error;setStatus("");}
    }catch(error){showError(error,"Kunne ikke logge inn. Sjekk e-post og passord.");}
  });
  $("#toggle-auth").addEventListener("click",()=>{
    const create=$("#auth-mode").value!=="create";$("#auth-mode").value=create?"create":"login";
    $("#display-name-field").hidden=!create;$("#auth-submit").textContent=create?"Lag bruker":"Logg inn";
    $("#toggle-auth").textContent=create?"Jeg har allerede en bruker":"Lag en ny bruker";
    $("#password").autocomplete=create?"new-password":"current-password";
  });
  const selectAuthMethod = method => {
    const emailSelected=method==="email";
    $("#auth-form").hidden=!emailSelected;$("#phone-auth-panel").hidden=emailSelected;
    $("#email-auth-tab").classList.toggle("active",emailSelected);$("#email-auth-tab").setAttribute("aria-selected",String(emailSelected));
    $("#phone-auth-tab").classList.toggle("active",!emailSelected);$("#phone-auth-tab").setAttribute("aria-selected",String(!emailSelected));
    setStatus("");
  };
  $("#email-auth-tab").addEventListener("click",()=>selectAuthMethod("email"));
  $("#phone-auth-tab").addEventListener("click",()=>selectAuthMethod("phone"));
  $("#phone-form").addEventListener("submit",async event=>{
    event.preventDefault();
    const name=$("#phone-display-name").value.trim();
    if(name.length<2){setStatus("Skriv inn et visningsnavn på minst to tegn.");return;}
    try{
      pendingPhone=normalizePhoneNumber($("#phone-number").value);pendingPhoneName=name.slice(0,24);setStatus("Sender SMS-kode …");
      const {error}=await supabase.auth.signInWithOtp({phone:pendingPhone,options:{shouldCreateUser:true,data:{display_name:pendingPhoneName}}});
      if(error)throw error;
      $("#phone-sent-to").textContent="Skriv inn koden vi sendte til "+pendingPhone+".";
      $("#phone-form").hidden=true;$("#phone-verify-form").hidden=false;$("#phone-otp").value="";$("#phone-otp").focus();setStatus("SMS-koden er sendt.");
    }catch(error){
      if(/phone.*provider|sms.*provider|sms.*not configured|phone.*disabled/i.test(error?.message||""))setStatus("Telefoninnlogging er ikke aktivert ennå. Supabase må kobles til en SMS-tjeneste.");
      else showError(error,"Kunne ikke sende SMS-koden. Sjekk nummeret og prøv igjen.");
    }
  });
  $("#phone-verify-form").addEventListener("submit",async event=>{
    event.preventDefault();const token=$("#phone-otp").value.trim();
    if(!/^\d{6}$/.test(token)){setStatus("Koden skal være på 6 sifre.");return;}
    setStatus("Sjekker koden …");
    try{
      const {error}=await supabase.auth.verifyOtp({phone:pendingPhone,token,type:"sms"});if(error)throw error;
      const {data,error:nameError}=await supabase.auth.updateUser({data:{display_name:pendingPhoneName}});
      if(data?.user)user=data.user;pendingPhone="";pendingPhoneName="";
      if(nameError)setStatus("Du er logget inn, men visningsnavnet kunne ikke lagres.");else setStatus("");
    }catch(error){showError(error,"Koden stemmer ikke eller har gått ut. Be om en ny kode.");}
  });
  $("#change-phone").addEventListener("click",()=>{pendingPhone="";pendingPhoneName="";$("#phone-verify-form").hidden=true;$("#phone-form").hidden=false;$("#phone-number").focus();setStatus("");});
  $("#sign-out").addEventListener("click",async()=>{if(roomId){try{await callRpc("funrun_leave_room",{p_room_id:roomId});}catch(_){}}unsubscribeRoom();await supabase.auth.signOut();});
  $("#create-room").addEventListener("click",createRoom);
  $("#join-room").addEventListener("click",joinRoom);
  $("#copy-code").addEventListener("click",async()=>{try{await navigator.clipboard.writeText(room?.code||"");setStatus("Lobbykoden er kopiert.");}catch(_){setStatus("Del lobbykoden: "+(room?.code||""));}});
  $("#save-settings").addEventListener("click",saveSettings);
  $("#start-round").addEventListener("click",startRound);
  $("#leave-room").addEventListener("click",async()=>{if(roomId){try{await callRpc("funrun_leave_room",{p_room_id:roomId});}catch(error){showError(error);}}unsubscribeRoom();setStatus("");});
  $("#headstart-enabled").addEventListener("change",()=>{$("#headstart-wrap").hidden=!$("#headstart-enabled").checked;settingsDirty=true;});
  $("#reveal-every").addEventListener("change",()=>{$("#custom-interval-wrap").hidden=$("#reveal-every").value!=="custom";settingsDirty=true;});
  $("#mode").addEventListener("change",()=>{$("#checkpoint-settings").hidden=$("#mode").value!=="checkpoints";settingsDirty=true;renderMapSummary();});
  $("#packages-enabled").addEventListener("change",()=>{gameOptions.packagesEnabled=$("#packages-enabled").checked;settingsDirty=true;renderMapSummary();renderSetupMap();});
  ["minutes","headstart-seconds","custom-interval","reveal-seconds","position-display","position-precision","outside-rule","checkpoint-count","checkpoint-order"].forEach(id=>{
    $("#"+id).addEventListener("input",()=>{settingsDirty=true;if(id==="checkpoint-count")gameOptions.checkpointCount=Math.min(10,Number($("#checkpoint-count").value)||1);renderMapSummary();});
    $("#"+id).addEventListener("change",()=>{settingsDirty=true;if(id==="checkpoint-count")gameOptions.checkpointCount=Math.min(10,Number($("#checkpoint-count").value)||1);renderMapSummary();});
  });
  document.querySelectorAll("[data-map-tool]").forEach(button=>button.addEventListener("click",()=>{
    if(button.dataset.mapTool==="package"&&!$("#packages-enabled").checked){setStatus("Slå på pakker i rundeoppsettet først.");return;}
    if(button.dataset.mapTool==="checkpoint"&&$("#mode").value!=="checkpoints"){setStatus("Velg Kontrollpunkter som spilltype først.");return;}
    setMapTool(button.dataset.mapTool);
  }));
  $("#undo-map-point").addEventListener("click",()=>{if(mapTool==="zone")gameOptions.zone.pop();else if(mapTool==="package")gameOptions.pendingPackages.pop();else if(mapTool==="checkpoint")gameOptions.checkpoints.pop();settingsDirty=true;renderSetupMap();renderMapSummary();});
  $("#clear-map-points").addEventListener("click",()=>{if(mapTool==="zone")gameOptions.zone=[];else if(mapTool==="package")gameOptions.pendingPackages=[];else if(mapTool==="checkpoint")gameOptions.checkpoints=[];else setStatus("Velg først område, pakker eller kontrollpunkter.");settingsDirty=true;renderSetupMap();renderMapSummary();});
  $("#finish-map-edit").addEventListener("click",()=>{mapTool=null;document.querySelectorAll("[data-map-tool]").forEach(button=>button.classList.remove("selected"));$("#map-instructions").textContent="Kartredigeringen er ferdig. Trykk på et verktøy for å tegne eller plassere markører.";renderSetupMap();renderMapSummary();});
  $("#search-place").addEventListener("click",searchPlaces);
  $("#place-search").addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();searchPlaces();}});
  $("#gps-toggle").addEventListener("click",()=>gpsWatch===null?startGps():stopGps());
  $("#back-to-lobby").addEventListener("click",()=>{if(room?.phase==="live"){setStatus("Runden pågår. Bruk Forlat lobby bare hvis du vil slutte.");return;}setView("room");});
  $("#request-tag").addEventListener("click",async()=>{
    const targetId=$("#tag-target").value;if(!targetId||currentRole()!=="hunter")return;
    $("#request-tag").disabled=true;
    try{await callRpc("funrun_request_tag",{p_room_id:roomId,p_target_id:targetId});$("#game-toast").hidden=false;$("#game-toast").textContent="Begge må stoppe. Venter på bekreftelse fra spilleren.";await refreshRoom();}
    catch(error){showError(error,"Kunne ikke sende beskjed.");}
    finally{$("#request-tag").disabled=false;}
  });
  $("#tag-confirm-button").addEventListener("click",async()=>{
    const incoming=requests.find(request=>request.target_id===user?.id&&request.status==="pending");if(!incoming)return;
    $("#tag-confirm-button").disabled=true;
    try{await callRpc("funrun_confirm_tag",{p_request_id:incoming.id});setStatus("Du bekreftet at du ble tatt.");await refreshRoom();}
    catch(error){showError(error,"Kunne ikke bekrefte.");}
    finally{$("#tag-confirm-button").disabled=false;}
  });
  $("#open-package").addEventListener("click",async()=>{if(currentPosition)await checkNearbyItems(currentPosition);});
  window.addEventListener("beforeunload",()=>{if(gpsWatch!==null&&navigator.geolocation)navigator.geolocation.clearWatch(gpsWatch);});
  supabase.auth.onAuthStateChange((_event,session)=>{
    user=session?.user||null;
    if(user){authGate.hidden=true;appView.hidden=false;$("#signed-in-as").textContent=currentName();setView("home");setStatus("");}
    else{unsubscribeRoom();authGate.hidden=false;appView.hidden=true;}
  });
  supabase.auth.getSession().then(({data,error})=>{
    if(error)setStatus("Kunne ikke hente innloggingen. Last inn siden på nytt.");
    if(data?.session?.user){user=data.session.user;authGate.hidden=true;appView.hidden=false;$("#signed-in-as").textContent=currentName();setView("home");}
  });
}

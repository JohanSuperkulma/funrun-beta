import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { supabaseConfig } from "./supabase-config.js";

const $ = selector => document.querySelector(selector);
const authGate = $("#auth-gate");
const appView = $("#app-view");
const statusNode = $("#status");
const setStatus = message => { statusNode.textContent = message || ""; };
const configured = supabaseConfig.url && supabaseConfig.publishableKey && !supabaseConfig.publishableKey.includes("PASTE_");

if (!configured) {
  authGate.hidden = false;
  $("#setup-note").hidden = false;
  $("#auth-form").hidden = true;
} else {
  const supabase = createClient(supabaseConfig.url, supabaseConfig.publishableKey);
  const codePattern = /^[A-F0-9]{8}$/;
  let user = null;
  let roomId = null;
  let room = null;
  let members = [];
  let roles = [];
  let requests = [];
  let channel = null;
  let refreshTimer = null;
  let roomRefreshBusy = false;
  let roomRefreshAgain = false;
  let gameTimer = null;
  let gpsWatch = null;
  let ownMarker = null;
  let map = null;
  let otherMarkers = new Map();
  let lastPositionSentAt = 0;
  let positionFetchBusy = false;
  let lastPositionFetchAt = 0;
  let lastAdvanceAt = 0;

  const currentRole = () => roles.find(row => row.user_id === user?.id)?.role || null;
  const currentName = () => {
    const saved = user?.user_metadata?.display_name;
    const emailName = user?.email?.split("@")[0];
    return String(saved || emailName || "Spiller").slice(0, 24);
  };
  const requestedName = () => {
    const typed = $("#display-name").value.trim();
    return (typed || currentName()).slice(0, 24);
  };
  const setView = name => {
    $("#home-view").hidden = name !== "home";
    $("#room-view").hidden = name !== "room";
    $("#game-view").hidden = name !== "game";
  };
  const showError = (error, fallback = "Noe gikk galt. Prøv igjen.") => {
    setStatus(error?.message || fallback);
  };
  const clearRemoteMarkers = () => {
    otherMarkers.forEach(marker => marker.remove());
    otherMarkers.clear();
  };
  const removeMap = () => {
    clearRemoteMarkers();
    if (ownMarker) ownMarker.remove();
    ownMarker = null;
    if (map) map.remove();
    map = null;
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
    removeMap();
    roomId = null;
    room = null;
    members = [];
    roles = [];
    requests = [];
  };
  const callRpc = async (name, args) => {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw error;
    return data;
  };
  const ensureMap = () => {
    if (map || !window.L) return;
    map = window.L.map("map").setView([59.197, 9.608], 15);
    window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    window.requestAnimationFrame(() => map && map.invalidateSize());
  };
  const showOwnPosition = (lat, lng) => {
    ensureMap();
    if (!map) return;
    if (!ownMarker) ownMarker = window.L.marker([lat, lng]).addTo(map).bindTooltip("Du", { permanent: true, direction: "top" });
    else ownMarker.setLatLng([lat, lng]);
    if (!map.getBounds().contains([lat, lng])) map.panTo([lat, lng]);
  };
  const syncPositions = async () => {
    const role = currentRole();
    const revealing = room?.phase === "live" && role === "hunter" &&
      (Number(room.reveal_every_minutes) === 0 || Date.parse(room.reveal_until || "") > Date.now());
    if (!revealing || positionFetchBusy || !roomId || Date.now() - lastPositionFetchAt < 4000) {
      if (!revealing) clearRemoteMarkers();
      return;
    }
    positionFetchBusy = true;
    lastPositionFetchAt = Date.now();
    try {
      const { data, error } = await supabase.from("funrun_positions")
        .select("user_id,lat,lng,updated_at").eq("room_id", roomId);
      if (error) throw error;
      const active = new Set();
      for (const point of data || []) {
        if (point.user_id === user.id || Date.now() - Date.parse(point.updated_at) > 20000) continue;
        active.add(point.user_id);
        const name = members.find(member => member.user_id === point.user_id)?.display_name || "Spiller";
        let marker = otherMarkers.get(point.user_id);
        if (!marker) {
          ensureMap();
          if (!map) continue;
          marker = window.L.marker([point.lat, point.lng]).addTo(map);
          otherMarkers.set(point.user_id, marker);
        }
        marker.setLatLng([point.lat, point.lng]).bindTooltip(name, { permanent: true, direction: "top" });
      }
      otherMarkers.forEach((marker, id) => {
        if (!active.has(id)) { marker.remove(); otherMarkers.delete(id); }
      });
    } catch (error) {
      showError(error, "Kunne ikke hente kartposisjonene.");
    } finally {
      positionFetchBusy = false;
    }
  };
  const displayWinner = winner => winner === "hunter" ? "Jegeren vant." : winner === "runners" ? "Flukterne vant." : "";
  const renderRoom = () => {
    if (!roomId || !room) return;
    $("#room-code").textContent = room.code;
    $("#player-list").replaceChildren(...members.map(member => {
      const li = document.createElement("li");
      li.textContent = member.display_name + (member.user_id === room.host_id ? " · vert" : "");
      return li;
    }));
    const isHost = room.host_id === user.id;
    $("#host-controls").hidden = !isHost || room.phase !== "lobby";
    $("#start-round").disabled = !isHost || members.length < 2 || room.phase !== "lobby";
    if (room.phase === "live" || room.phase === "finished") setView("game");
    else setView("room");
    if (room.phase === "lobby") {
      $("#mode").value = room.mode;
      $("#minutes").value = room.duration_minutes;
      $("#reveal-every").value = String(room.reveal_every_minutes);
      $("#reveal-seconds").value = room.reveal_seconds;
    }
  };
  const currentIncomingRequest = () => requests.find(request => request.target_id === user?.id && request.status === "pending");
  const renderGame = () => {
    if (!room || !user) return;
    ensureMap();
    const role = currentRole();
    const active = room.phase === "live";
    const winner = displayWinner(room.winner);
    $("#game-status").textContent = room.phase === "finished" ? `Runden er ferdig. ${winner}` :
      role === "hunter" ? "Du er jeger." : role === "out" ? "Du er ute." : "Du er på flukt.";
    const remaining = active && room.ends_at ? Math.max(0, Math.ceil((Date.parse(room.ends_at) - Date.now()) / 1000)) : 0;
    $("#timer").textContent = active ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` : "00:00";
    const targets = roles.filter(row => row.role === "runner" && row.user_id !== user.id)
      .map(row => members.find(member => member.user_id === row.user_id)).filter(Boolean);
    $("#tag-target").replaceChildren(...targets.map(member => {
      const option = document.createElement("option"); option.value = member.user_id; option.textContent = member.display_name; return option;
    }));
    $("#tag-target-label").hidden = role !== "hunter" || !active;
    $("#request-tag").hidden = role !== "hunter" || !active;
    $("#gps-toggle").disabled = !active || role === "out";
    if (role === "out" || !active) stopGps(false);
    const incoming = currentIncomingRequest();
    $("#tag-confirm").hidden = !incoming;
    if (incoming) {
      const hunterName = members.find(member => member.user_id === incoming.hunter_id)?.display_name || "Jegeren";
      $("#tag-confirm-text").textContent = `${hunterName} sier at du ble tatt. Stopp og bekreft bare hvis dere faktisk tok på hverandre.`;
      $("#tag-confirm-button").onclick = async () => {
        $("#tag-confirm-button").disabled = true;
        try {
          await callRpc("funrun_confirm_tag", { p_request_id: incoming.id });
          setStatus("Du har bekreftet. Rollene er oppdatert.");
          await refreshRoom();
        } catch (error) { showError(error); }
        finally { $("#tag-confirm-button").disabled = false; }
      };
    }
    if (active && !gameTimer) gameTimer = setInterval(gameTick, 1000);
    if (!active && gameTimer) { clearInterval(gameTimer); gameTimer = null; }
    syncPositions();
  };
  const refreshRoom = async () => {
    if (!roomId || roomRefreshBusy) { roomRefreshAgain = true; return; }
    roomRefreshBusy = true;
    try {
      const [roomResult, membersResult, rolesResult, requestsResult] = await Promise.all([
        supabase.from("funrun_rooms").select("*").eq("id", roomId).maybeSingle(),
        supabase.from("funrun_members").select("user_id,display_name,joined_at").eq("room_id", roomId).order("joined_at"),
        supabase.from("funrun_roles").select("user_id,role").eq("room_id", roomId),
        supabase.from("funrun_tag_requests").select("id,room_id,hunter_id,target_id,status,created_at").eq("room_id", roomId).order("created_at", { ascending: false })
      ]);
      for (const result of [roomResult, membersResult, rolesResult, requestsResult]) if (result.error) throw result.error;
      if (!roomResult.data) {
        unsubscribeRoom(); setView("home"); setStatus("Lobbyen finnes ikke lenger."); return;
      }
      room = roomResult.data;
      members = membersResult.data || [];
      roles = rolesResult.data || [];
      requests = requestsResult.data || [];
      renderRoom();
      if (room.phase === "live" || room.phase === "finished") renderGame();
      else clearRemoteMarkers();
    } catch (error) {
      showError(error, "Kunne ikke hente lobbyen. Sjekk tilkoblingen og prøv igjen.");
    } finally {
      roomRefreshBusy = false;
      if (roomRefreshAgain) { roomRefreshAgain = false; queueRoomRefresh(); }
    }
  };
  const queueRoomRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refreshTimer = null; refreshRoom(); }, 120);
  };
  const subscribeRoom = async id => {
    unsubscribeRoom();
    roomId = id;
    channel = supabase.channel(`funrun-room-${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "funrun_rooms", filter: `id=eq.${id}` }, queueRoomRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "funrun_members", filter: `room_id=eq.${id}` }, queueRoomRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "funrun_roles", filter: `room_id=eq.${id}` }, queueRoomRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "funrun_tag_requests", filter: `room_id=eq.${id}` }, queueRoomRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "funrun_positions", filter: `room_id=eq.${id}` }, syncPositions)
      .subscribe(state => {
        if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") setStatus("Live-oppdatering mistet. Kontroller internettforbindelsen.");
      });
    setView("room");
    setStatus("Kobler til lobbyen …");
    await refreshRoom();
    setStatus("");
  };
  const createRoom = async () => {
    setStatus("Lager lobby …");
    try {
      const data = await callRpc("funrun_create_room", {
        p_display_name: requestedName(), p_mode: "tag", p_duration_minutes: 30,
        p_reveal_every_minutes: 5, p_reveal_seconds: 15
      });
      await subscribeRoom(data.room_id);
    } catch (error) { showError(error, "Kunne ikke lage lobbyen."); }
  };
  const joinRoom = async () => {
    const code = $("#join-code").value.trim().toUpperCase();
    if (!codePattern.test(code)) { setStatus("Lobbykoden skal være 8 tegn. Sjekk koden og prøv igjen."); return; }
    setStatus("Blir med i lobbyen …");
    try {
      const data = await callRpc("funrun_join_room", { p_code: code, p_display_name: requestedName() });
      await subscribeRoom(data.room_id);
    } catch (error) { showError(error, "Fant ikke en åpen lobby med den koden."); }
  };
  const saveSettings = async () => {
    if (!roomId || room?.host_id !== user.id) return;
    const minutes = Number($("#minutes").value);
    const revealEvery = Number($("#reveal-every").value);
    const revealSeconds = Number($("#reveal-seconds").value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) { setStatus("Rundelengden må være et helt antall minutter fra 1 til 120."); return; }
    if (!Number.isInteger(revealSeconds) || revealSeconds < 1 || revealSeconds > 120) { setStatus("Kartvisningen må være et helt antall sekunder fra 1 til 120."); return; }
    try {
      await callRpc("funrun_save_settings", {
        p_room_id: roomId, p_mode: $("#mode").value, p_duration_minutes: minutes,
        p_reveal_every_minutes: revealEvery, p_reveal_seconds: revealSeconds
      });
      setStatus("Rundeoppsettet er lagret.");
      await refreshRoom();
    } catch (error) { showError(error, "Kunne ikke lagre oppsettet."); }
  };
  const startRound = async () => {
    if (!roomId || room?.host_id !== user.id || members.length < 2) return;
    try {
      await callRpc("funrun_start_round", { p_room_id: roomId });
      await refreshRoom();
      setStatus("Runden har startet!");
    } catch (error) { showError(error, "Kunne ikke starte runden."); }
  };
  const stopGps = (message = true) => {
    if (gpsWatch !== null && navigator.geolocation) navigator.geolocation.clearWatch(gpsWatch);
    gpsWatch = null;
    $("#gps-toggle").textContent = "Start GPS";
    if (roomId && user) callRpc("funrun_delete_position", { p_room_id: roomId }).catch(() => {});
    if (ownMarker) { ownMarker.remove(); ownMarker = null; }
    if (message && room?.phase === "live") setStatus("GPS er stoppet og posisjonen er fjernet.");
  };
  const startGps = () => {
    if (!navigator.geolocation) { setStatus("Denne nettleseren støtter ikke GPS."); return; }
    if (!roomId || room?.phase !== "live" || currentRole() === "out") return;
    setStatus("Venter på GPS-tillatelse. Du kan stoppe delingen når som helst.");
    gpsWatch = navigator.geolocation.watchPosition(async position => {
      if (!roomId || room?.phase !== "live" || currentRole() === "out") { stopGps(false); return; }
      const { latitude: lat, longitude: lng } = position.coords;
      showOwnPosition(lat, lng);
      $("#gps-toggle").textContent = "Stopp GPS";
      const now = Date.now();
      if (now - lastPositionSentAt >= 5000) {
        lastPositionSentAt = now;
        try { await callRpc("funrun_upsert_position", { p_room_id: roomId, p_lat: lat, p_lng: lng }); }
        catch (error) { showError(error, "Kunne ikke dele GPS. Kontroller lobbyen og prøv igjen."); }
      }
    }, () => setStatus("GPS ble ikke startet. Tillat posisjon i nettleseren og prøv igjen."), {
      enableHighAccuracy: true, maximumAge: 3000, timeout: 20000
    });
  };
  const gameTick = () => {
    if (!room || room.phase !== "live") return;
    const remaining = Math.max(0, Math.ceil((Date.parse(room.ends_at) - Date.now()) / 1000));
    $("#timer").textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
    const shouldAdvance = room.host_id === user.id &&
      (remaining <= 0 || (room.reveal_every_minutes > 0 && Date.parse(room.next_reveal_at || "") <= Date.now()));
    if (shouldAdvance && Date.now() - lastAdvanceAt > 1200) {
      lastAdvanceAt = Date.now();
      callRpc("funrun_advance_round", { p_room_id: roomId }).then(refreshRoom).catch(error => showError(error));
    }
    syncPositions();
  };

  $("#auth-form").addEventListener("submit", async event => {
    event.preventDefault();
    setStatus("Logger inn …");
    const email = $("#email").value.trim();
    const password = $("#password").value;
    try {
      if ($("#auth-mode").value === "create") {
        const name = $("#display-name").value.trim();
        if (name.length < 2) throw new Error("Skriv inn et visningsnavn på minst to tegn.");
        const { data, error } = await supabase.auth.signUp({
          email, password,
          options: {
            data: { display_name: name.slice(0, 24) },
            emailRedirectTo: `${location.origin}${location.pathname}`
          }
        });
        if (error) throw error;
        if (!data.session) setStatus("Sjekk e-posten din og trykk på bekreftelseslenken før du logger inn.");
        else setStatus("");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        setStatus("");
      }
    } catch (error) { showError(error, "Kunne ikke logge inn. Sjekk e-post og passord."); }
  });
  $("#toggle-auth").addEventListener("click", () => {
    const create = $("#auth-mode").value !== "create";
    $("#auth-mode").value = create ? "create" : "login";
    $("#display-name-field").hidden = !create;
    $("#auth-submit").textContent = create ? "Lag bruker" : "Logg inn";
    $("#toggle-auth").textContent = create ? "Jeg har allerede en bruker" : "Lag en ny bruker";
    $("#password").autocomplete = create ? "new-password" : "current-password";
  });
  $("#sign-out").addEventListener("click", async () => {
    if (roomId) { try { await callRpc("funrun_leave_room", { p_room_id: roomId }); } catch (_) {} }
    unsubscribeRoom();
    await supabase.auth.signOut();
    setView("home");
  });
  $("#create-room").addEventListener("click", createRoom);
  $("#join-room").addEventListener("click", joinRoom);
  $("#copy-code").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(room?.code || ""); setStatus("Lobbykoden er kopiert."); }
    catch (_) { setStatus(`Del lobbykoden: ${room?.code || ""}`); }
  });
  $("#save-settings").addEventListener("click", saveSettings);
  $("#start-round").addEventListener("click", startRound);
  $("#leave-room").addEventListener("click", async () => {
    if (roomId) { try { await callRpc("funrun_leave_room", { p_room_id: roomId }); } catch (error) { showError(error); } }
    unsubscribeRoom(); setView("home"); setStatus("");
  });
  $("#gps-toggle").addEventListener("click", () => gpsWatch === null ? startGps() : stopGps());
  $("#request-tag").addEventListener("click", async () => {
    const targetId = $("#tag-target").value;
    if (!targetId || currentRole() !== "hunter") return;
    try {
      await callRpc("funrun_request_tag", { p_room_id: roomId, p_target_id: targetId });
      setStatus("Begge må stoppe. Venter på at spilleren bekrefter at dere tok på hverandre.");
      await refreshRoom();
    } catch (error) { showError(error, "Kunne ikke sende bekreftelsen."); }
  });
  $("#back-home").addEventListener("click", async () => {
    if (roomId) { try { await callRpc("funrun_leave_room", { p_room_id: roomId }); } catch (_) {} }
    unsubscribeRoom(); setView("home"); setStatus("");
  });

  supabase.auth.onAuthStateChange((_event, session) => {
    user = session?.user || null;
    if (user) {
      authGate.hidden = true; appView.hidden = false;
      $("#signed-in-as").textContent = currentName();
      setView("home");
      setStatus("");
    } else {
      unsubscribeRoom();
      authGate.hidden = false; appView.hidden = true;
    }
  });
  supabase.auth.getSession().then(({ data, error }) => {
    if (error) setStatus("Kunne ikke hente innloggingen. Last inn siden på nytt.");
    const session = data?.session;
    if (session?.user) {
      user = session.user; authGate.hidden = true; appView.hidden = false;
      $("#signed-in-as").textContent = currentName(); setView("home");
    }
  });
}

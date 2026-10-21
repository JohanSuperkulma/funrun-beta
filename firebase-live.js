import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, updateProfile, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getDatabase, ref, set, get, update, remove, push, onValue, onDisconnect
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = selector => document.querySelector(selector);
const authGate = $("#auth-gate");
const appView = $("#app-view");
const statusNode = $("#status");
const setStatus = message => { statusNode.textContent = message || ""; };
const configured = firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.databaseURL && firebaseConfig.projectId && firebaseConfig.appId;

if (!configured) {
  authGate.hidden = false;
  $("#setup-note").hidden = false;
  $("#auth-form").hidden = true;
} else {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getDatabase(app);
  let user = null;
  let roomCode = null;
  let room = {};
  let unsubscribers = [];
  let gpsWatch = null;
  let ownMarker = null;
  let otherMarkers = new Map();
  let map = null;
  let positionUnsubscribe = null;
  let gameTimer = null;
  let requestUnsubscribe = null;
  let processedRequests = new Set();
  let lastPositionSentAt = 0;

  const roomRef = path => ref(db, "rooms/" + roomCode + "/" + path);
  const cleanup = () => {
    const oldCode = roomCode;
    if (oldCode && user) remove(ref(db, "rooms/" + oldCode + "/positions/" + user.uid)).catch(() => {});
    unsubscribers.forEach(stop => stop());
    unsubscribers = [];
    if (positionUnsubscribe) positionUnsubscribe();
    positionUnsubscribe = null;
    if (requestUnsubscribe) requestUnsubscribe();
    requestUnsubscribe = null;
    if (gpsWatch !== null) navigator.geolocation.clearWatch(gpsWatch);
    gpsWatch = null;
    if (gameTimer) clearInterval(gameTimer);
    gameTimer = null;
    roomCode = null;
    room = {};
    otherMarkers.clear();
    ownMarker = null;
    if (map) { map.remove(); map = null; }
  };
  const codeCharacters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const newCode = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, byte => codeCharacters[byte % codeCharacters.length]).join("");
  };
  const friendlyError = error => {
    const messages = {
      "auth/email-already-in-use": "E-postadressen har allerede en bruker.",
      "auth/invalid-email": "Sjekk e-postadressen.",
      "auth/weak-password": "Passordet må være minst 6 tegn.",
      "auth/invalid-credential": "E-post eller passord stemmer ikke.",
      "auth/network-request-failed": "Ingen forbindelse akkurat nå. Prøv igjen."
    };
    return messages[error.code] || "Noe gikk galt. Sjekk at Firebase er satt opp, og prøv igjen.";
  };
  const setView = name => {
    $("#home-view").hidden = name !== "home";
    $("#room-view").hidden = name !== "room";
    $("#game-view").hidden = name !== "game";
  };
  const currentName = () => (user.displayName || user.email.split("@")[0] || "Spiller").slice(0, 24);

  $("#auth-form").addEventListener("submit", async event => {
    event.preventDefault();
    setStatus("Logger inn …");
    const email = $("#email").value.trim();
    const password = $("#password").value;
    try {
      if ($("#auth-mode").value === "create") {
        const name = $("#display-name").value.trim();
        if (name.length < 2) throw new Error("Skriv inn et visningsnavn på minst to bokstaver.");
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(credential.user, { displayName: name.slice(0, 24) });
        user = credential.user;
      } else {
        const credential = await signInWithEmailAndPassword(auth, email, password);
        user = credential.user;
      }
      authGate.hidden = true;
      appView.hidden = false;
      $("#signed-in-as").textContent = currentName();
      setView("home");
      setStatus("");
    } catch (error) { setStatus(error.message && !error.code ? error.message : friendlyError(error)); }
  });
  $("#toggle-auth").addEventListener("click", () => {
    const create = $("#auth-mode").value !== "create";
    $("#auth-mode").value = create ? "create" : "login";
    $("#display-name-field").hidden = !create;
    $("#auth-submit").textContent = create ? "Lag bruker" : "Logg inn";
    $("#toggle-auth").textContent = create ? "Jeg har allerede en bruker" : "Lag en ny bruker";
  });
  $("#sign-out").addEventListener("click", async () => { if (roomCode) await remove(roomRef("players/" + user.uid)).catch(() => {}); cleanup(); await signOut(auth); user = null; appView.hidden = true; authGate.hidden = false; });

  const subscribeRoom = async code => {
    cleanup();
    roomCode = code;
    const memberRef = roomRef("players/" + user.uid);
    try {
      await onDisconnect(memberRef).remove();
      const paths = ["meta", "settings", "players", "roles", "game"];
      const stops = paths.map(path => onValue(roomRef(path), snapshot => {
        room[path] = snapshot.val() || (path === "players" || path === "roles" ? {} : {});
        renderRoom();
        if (path === "game" || path === "roles") syncGame();
        if (path === "roles" || path === "game") syncPositionReader();
      }));
      unsubscribers.push(...stops);
      requestUnsubscribe = onValue(roomRef("tagRequests"), snapshot => onTagRequests(snapshot.val() || {}));
      setView("room");
      setStatus("");
    } catch (error) { setStatus(friendlyError(error)); }
  };
  const createRoom = async () => {
    const code = newCode();
    const defaults = { mode: "tag", minutes: 30, revealEvery: 5, revealSeconds: 15 };
    try {
      await set(ref(db, "rooms/" + code + "/meta"), { hostUid: user.uid, createdAt: Date.now() });
      await set(ref(db, "rooms/" + code + "/settings"), defaults);
      await set(ref(db, "rooms/" + code + "/players/" + user.uid), { uid: user.uid, name: currentName(), joinedAt: Date.now() });
      await set(ref(db, "rooms/" + code + "/roles"), {});
      await set(ref(db, "rooms/" + code + "/game"), { phase: "lobby", revealUntil: 0 });
      await subscribeRoom(code);
    } catch (error) { setStatus(friendlyError(error)); }
  };
  const joinRoom = async () => {
    const code = $("#join-code").value.trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) { setStatus("Lobbykoden skal være 8 bokstaver eller tall."); return; }
    try {
      const memberRef = ref(db, "rooms/" + code + "/players/" + user.uid);
      await set(memberRef, { uid: user.uid, name: currentName(), joinedAt: Date.now() });
      const metaSnapshot = await get(ref(db, "rooms/" + code + "/meta"));
      if (!metaSnapshot.exists()) throw new Error("Fant ikke lobbyen. Sjekk koden.");
      await subscribeRoom(code);
    } catch (error) { setStatus(error.message && !error.code ? error.message : "Fant ikke lobbyen. Sjekk koden og prøv igjen."); }
  };
  $("#create-room").addEventListener("click", createRoom);
  $("#join-room").addEventListener("click", joinRoom);
  $("#copy-code").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(roomCode); setStatus("Koden " + roomCode + " er kopiert."); }
    catch (_) { setStatus("Del koden: " + roomCode); }
  });
  $("#leave-room").addEventListener("click", async () => {
    if (roomCode && user) await remove(roomRef("players/" + user.uid));
    cleanup(); setView("home"); setStatus("");
  });
  $("#save-settings").addEventListener("click", async () => {
    if (!roomCode || room.meta?.hostUid !== user.uid) return;
    const minutes = Math.max(1, Math.min(120, Number($("#minutes").value) || 30));
    const settings = { mode: $("#mode").value, minutes, revealEvery: Number($("#reveal-every").value), revealSeconds: Number($("#reveal-seconds").value) };
    try { await set(roomRef("settings"), settings); setStatus("Rundeoppsettet er lagret."); }
    catch (error) { setStatus(friendlyError(error)); }
  });
  $("#start-round").addEventListener("click", async () => {
    if (!roomCode || room.meta?.hostUid !== user.uid || Object.keys(room.players || {}).length < 2) return;
    const ids = Object.keys(room.players);
    const hunter = ids[crypto.getRandomValues(new Uint32Array(1))[0] % ids.length];
    const roles = Object.fromEntries(ids.map(id => [id, id === hunter ? "hunter" : "runner"]));
    const now = Date.now();
    const every = Number(room.settings?.revealEvery ?? 5);
    const duration = Number(room.settings?.revealSeconds ?? 15);
    const initialReveal = every === 0 ? 4102444800000 : now + duration * 1000;
    try {
      await set(roomRef("roles"), roles);
      await set(roomRef("game"), { phase: "live", startedAt: now, endsAt: now + Number(room.settings.minutes) * 60000, revealUntil: initialReveal, nextRevealAt: every ? now + every * 60000 : 0, pendingTag: null });
    } catch (error) { setStatus(friendlyError(error)); }
  });
  $("#gps-toggle").addEventListener("click", () => {
    if (gpsWatch !== null) { navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; if (roomCode) remove(roomRef("positions/" + user.uid)).catch(() => {}); $("#gps-toggle").textContent = "Start GPS"; return; }
    if (!navigator.geolocation) { setStatus("Denne nettleseren støtter ikke GPS."); return; }
    setStatus("Venter på GPS-tillatelse. Posisjonen deles med jegeren under kartvisning.");
    if (roomCode) onDisconnect(roomRef("positions/" + user.uid)).remove().catch(() => {});
    gpsWatch = navigator.geolocation.watchPosition(position => {
      if (!roomCode || room.game?.phase !== "live") return;
      if (room.roles?.[user.uid] === "out") {
        navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null;
        remove(roomRef("positions/" + user.uid)).catch(() => {});
        $("#gps-toggle").textContent = "GPS stoppet";
        return;
      }
      const { latitude: lat, longitude: lng } = position.coords;
      const now = Date.now();
      if (now - lastPositionSentAt >= 5000) {
        lastPositionSentAt = now;
        set(roomRef("positions/" + user.uid), { lat, lng, updatedAt: now }).catch(() => setStatus("Kunne ikke dele GPS. Kontroller lobbyen og prøv igjen."));
      }
      showOwnPosition(lat, lng);
      $("#gps-toggle").textContent = "Stopp GPS";
      setStatus("GPS er på. Bare du ser posisjonen din; jegeren får se den i kartperiodene.");
    }, () => setStatus("GPS ble ikke startet. Tillat posisjon i nettleseren og prøv igjen."), { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
  });

  const renderRoom = () => {
    if (!roomCode) return;
    $("#room-code").textContent = roomCode;
    const names = Object.values(room.players || {});
    $("#player-list").replaceChildren(...names.map(player => {
      const li = document.createElement("li"); li.textContent = player.name + (player.uid === room.meta?.hostUid ? " · vert" : ""); return li;
    }));
    const host = room.meta?.hostUid === user.uid;
    $("#host-controls").hidden = !host;
    $("#start-round").disabled = !host || names.length < 2;
    if (room.settings) {
      $("#mode").value = room.settings.mode || "tag";
      $("#minutes").value = room.settings.minutes || 30;
      $("#reveal-every").value = String(room.settings.revealEvery ?? 5);
      $("#reveal-seconds").value = String(room.settings.revealSeconds ?? 15);
    }
    if (room.game?.phase === "live" || room.game?.phase === "finished") setView("game");
    else setView("room");
  };
  const ensureMap = () => {
    if (map || !window.L) return;
    map = window.L.map("map").setView([59.197, 9.608], 15);
    window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
    otherMarkers = new Map();
    window.requestAnimationFrame(() => map && map.invalidateSize());
  };
  const showOwnPosition = (lat, lng) => {
    ensureMap(); if (!map) return;
    if (!ownMarker) ownMarker = window.L.marker([lat, lng]).addTo(map).bindTooltip("Du", { permanent: true, direction: "top" });
    else ownMarker.setLatLng([lat, lng]);
    if (!map.getBounds().contains([lat, lng])) map.panTo([lat, lng]);
  };
  const syncPositionReader = () => {
    const canSee = room.roles?.[user.uid] === "hunter" && room.game?.phase === "live" && Date.now() < Number(room.game?.revealUntil || 0);
    if (!canSee || positionUnsubscribe) { if (!canSee && positionUnsubscribe) { positionUnsubscribe(); positionUnsubscribe = null; otherMarkers.forEach(marker => marker.remove()); otherMarkers.clear(); } return; }
    ensureMap();
    positionUnsubscribe = onValue(roomRef("positions"), snapshot => {
      const positions = snapshot.val() || {};
      for (const [uid, position] of Object.entries(positions)) {
        if (uid === user.uid) continue;
        const name = room.players?.[uid]?.name || "Spiller";
        let marker = otherMarkers.get(uid);
        if (!marker) { marker = window.L.marker([position.lat, position.lng]).addTo(map); otherMarkers.set(uid, marker); }
        marker.setLatLng([position.lat, position.lng]).bindTooltip(name, { permanent: true, direction: "top" });
      }
      otherMarkers.forEach((marker, uid) => { if (!positions[uid]) { marker.remove(); otherMarkers.delete(uid); } });
    }, () => { positionUnsubscribe = null; });
  };
  const onTagRequests = requests => {
    const incoming = Object.entries(requests).find(([, request]) => request.targetUid === user.uid && !request.confirmed);
    const panel = $("#tag-confirm");
    panel.hidden = !incoming;
    if (incoming) {
      const [id, request] = incoming;
      $("#tag-confirm-text").textContent = (room.players?.[request.hunterUid]?.name || "Jegeren") + " sier at du ble tatt. Stopp og bekreft bare hvis dere tok på hverandre.";
      $("#tag-confirm-button").onclick = () => update(roomRef("tagRequests/" + id), { confirmed: true, confirmedAt: Date.now() }).catch(error => setStatus(friendlyError(error)));
    }
    if (room.meta?.hostUid === user.uid) {
      Object.entries(requests).forEach(([id, request]) => {
        if (!request.confirmed || request.handled || processedRequests.has(id)) return;
        processedRequests.add(id);
        applyConfirmedTag(id, request);
      });
    }
  };
  const applyConfirmedTag = async (id, request) => {
    const roles = { ...(room.roles || {}) };
    const mode = room.settings?.mode || "tag";
    if (mode === "tag") { roles[request.hunterUid] = "runner"; roles[request.targetUid] = "hunter"; }
    else if (mode === "infection") roles[request.targetUid] = "hunter";
    else roles[request.targetUid] = "out";
    try {
      await set(roomRef("roles"), roles);
      await update(roomRef("tagRequests/" + id), { handled: true });
      const runners = Object.values(roles).filter(role => role === "runner").length;
      if (mode === "catch" && runners === 0) await update(roomRef("game"), { phase: "finished", winner: "hunter" });
    } catch (error) { setStatus(friendlyError(error)); }
  };
  $("#request-tag").addEventListener("click", async () => {
    const targetUid = $("#tag-target").value;
    if (!targetUid || room.roles?.[user.uid] !== "hunter") return;
    try { await push(roomRef("tagRequests"), { hunterUid: user.uid, targetUid, confirmed: false, createdAt: Date.now() }); setStatus("Begge må stoppe. Venter på at spilleren bekrefter."); }
    catch (error) { setStatus(friendlyError(error)); }
  });
  const syncGame = () => {
    if (!room.game) return;
    if (room.game.phase !== "live" && gpsWatch !== null) {
      navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null;
      if (roomCode) remove(roomRef("positions/" + user.uid)).catch(() => {});
      $("#gps-toggle").textContent = "Start GPS";
    }
    if (room.game.phase === "live" || room.game.phase === "finished") {
      setView("game"); ensureMap();
      const target = $("#tag-target");
      const activeRunners = Object.entries(room.roles || {}).filter(([uid, role]) => role === "runner" && uid !== user.uid);
      target.replaceChildren(...activeRunners.map(([uid]) => { const option = document.createElement("option"); option.value = uid; option.textContent = room.players?.[uid]?.name || "Spiller"; return option; }));
      $("#request-tag").hidden = room.roles?.[user.uid] !== "hunter";
      $("#game-status").textContent = room.game.phase === "finished" ? "Runden er ferdig." : room.roles?.[user.uid] === "hunter" ? "Du er jeger." : room.roles?.[user.uid] === "out" ? "Du er ute." : "Du er på flukt.";
      const remaining = Math.max(0, Math.ceil((Number(room.game.endsAt) - Date.now()) / 1000));
      $("#timer").textContent = Math.floor(remaining / 60) + ":" + String(remaining % 60).padStart(2, "0");
      if (room.game.phase === "finished" && gameTimer) { clearInterval(gameTimer); gameTimer = null; }
      if (room.game.phase === "live" && !gameTimer) gameTimer = setInterval(gameTick, 1000);
      syncPositionReader();
    }
  };
  const gameTick = () => {
    if (!room.game || room.game.phase !== "live") return;
    const now = Date.now();
    const remaining = Math.max(0, Math.ceil((Number(room.game.endsAt) - now) / 1000));
    $("#timer").textContent = Math.floor(remaining / 60) + ":" + String(remaining % 60).padStart(2, "0");
    if (room.meta?.hostUid === user.uid) {
      if (remaining <= 0) update(roomRef("game"), { phase: "finished", winner: "runners" }).catch(() => {});
      else if (Number(room.settings?.revealEvery) > 0 && now >= Number(room.game.nextRevealAt)) {
        const seconds = Number(room.settings.revealSeconds || 15);
        update(roomRef("game"), { revealUntil: now + seconds * 1000, nextRevealAt: now + Number(room.settings.revealEvery) * 60000 }).catch(() => {});
      }
    }
    syncPositionReader();
  };
  $("#back-home").addEventListener("click", async () => { if (roomCode) await remove(roomRef("players/" + user.uid)).catch(() => {}); cleanup(); setView("home"); setStatus(""); });
  onAuthStateChanged(auth, signedInUser => {
    user = signedInUser;
    if (user) {
      authGate.hidden = true; appView.hidden = false;
      $("#signed-in-as").textContent = currentName();
      setView("home");
    } else { cleanup(); authGate.hidden = false; appView.hidden = true; }
  });
}

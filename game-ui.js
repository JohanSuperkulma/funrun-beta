(() => {
  const style = document.createElement("style");
  style.textContent = `
    #game-view .game-top{display:none!important}
    #game-info-card{position:fixed;z-index:60;top:calc(env(safe-area-inset-top) + 10px);right:10px;width:min(245px,60vw);padding:12px 14px;border:1px solid #8be1a8;border-radius:17px;background:#111a15ed;color:#f4f7f3;box-shadow:0 4px 18px #0008;font:600 13px/1.4 system-ui,sans-serif;pointer-events:none}
    #game-info-card strong{display:block;color:#8be1a8;font-size:18px}
    #game-info-card .info-row{display:flex;justify-content:space-between;gap:12px;margin-top:5px}
    #game-info-card .info-value{font-variant-numeric:tabular-nums;text-align:right}
    #locate-me{position:fixed;z-index:61;top:calc(env(safe-area-inset-top) + 10px);left:10px;width:auto;min-width:48px;min-height:48px;padding:10px 13px;border:1px solid #fff;border-radius:14px;background:#111a15ed;color:#fff;font-size:22px;box-shadow:0 4px 18px #0008}
    #game-view .live-buttons{display:none!important}
    #game-view #gps-toggle,#game-view #back-to-lobby{display:none!important}
    #game-view .game-bottom{padding-bottom:calc(12px + env(safe-area-inset-bottom))}
    #game-view #open-package{font-size:18px;min-height:54px;border-color:#b3ff4a;background:#b3ff4a;color:#102016;font-weight:850}
    @media(max-width:520px){#game-info-card{width:min(230px,59vw);padding:9px 10px;font-size:12px}#game-info-card strong{font-size:16px}#locate-me{min-width:44px;min-height:44px}}
  `;
  document.head.append(style);

  const data = { room: null, members: [], roles: [] };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    try {
      const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      const url = new URL(requestUrl, location.href);
      if (url.pathname.includes("/rest/v1/funrun_rooms") || url.pathname.includes("/rest/v1/funrun_members") || url.pathname.includes("/rest/v1/funrun_roles")) {
        const body = await response.clone().json();
        if (url.pathname.includes("/funrun_rooms")) data.room = Array.isArray(body) ? body[0] || null : body;
        else if (url.pathname.includes("/funrun_members")) data.members = Array.isArray(body) ? body : [];
        else data.roles = Array.isArray(body) ? body : [];
        renderInfo();
      }
    } catch (_) {}
    return response;
  };

  let card = null;
  let gameMap = null;
  let gpsStartAttempted = false;
  const timeText = seconds => {
    const value = Math.max(0, Math.ceil(Number(seconds) || 0));
    return Math.floor(value / 60) + ":" + String(value % 60).padStart(2, "0");
  };

  const hookLeaflet = () => {
    if (!window.L || window.L.__funrunMapHooked) return;
    window.L.__funrunMapHooked = true;
    const originalMap = window.L.map;
    window.L.map = function(element, ...args) {
      const map = originalMap.call(this, element, ...args);
      const node = typeof element === "string" ? document.getElementById(element) : element;
      if (node?.id === "game-map") gameMap = map;
      return map;
    };
  };

  const ensureControls = () => {
    hookLeaflet();
    const game = document.querySelector("#game-view");
    if (!game) return;
    if (!card) {
      card = document.createElement("aside");
      card.id = "game-info-card";
      card.setAttribute("aria-label", "Rundeinformasjon");
      card.innerHTML = '<div>Rolle<strong id="info-role">Kobler til …</strong></div><div class="info-row"><span>Tid igjen</span><span class="info-value" id="info-time">--:--</span></div><div class="info-row"><span>Neste pip</span><span class="info-value" id="info-pip">—</span></div><div class="info-row"><span>Pip varer</span><span class="info-value" id="info-pip-duration">—</span></div><div class="info-row"><span>Spillere igjen</span><span class="info-value" id="info-players">—</span></div>';
      game.append(card);

      const locate = document.createElement("button");
      locate.id = "locate-me";
      locate.type = "button";
      locate.title = "Vis meg på kartet";
      locate.setAttribute("aria-label", "Finn meg på kartet");
      locate.textContent = "◎";
      locate.addEventListener("click", () => {
        if (!navigator.geolocation) return;
        locate.disabled = true;
        navigator.geolocation.getCurrentPosition(position => {
          const point = [position.coords.latitude, position.coords.longitude];
          if (gameMap) gameMap.setView(point, Math.max(gameMap.getZoom(), 16));
          else document.dispatchEvent(new CustomEvent("funrun:locate", { detail: point }));
          locate.disabled = false;
        }, () => {
          const status = document.querySelector("#gps-status");
          if (status) status.textContent = "Fant ikke posisjonen din. Kontroller posisjonstilgangen.";
          locate.disabled = false;
        }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
      });
      game.append(locate);
    }

    const gps = document.querySelector("#gps-toggle");
    const status = document.querySelector("#gps-status");
    const visible = !game.hidden;
    const statusText = status?.textContent || "";
    const permissionFailed = /avslått|avsl[aå]|ikke startes|finner ikke posisjonen|for lang tid/i.test(statusText);
    if (!visible) gpsStartAttempted = false;
    // Browser permission is still required. Start sharing automatically as soon as the live round permits it.
    if (visible && gps && !gps.disabled && gps.textContent.includes("Start GPS") && !gpsStartAttempted && !permissionFailed) {
      gpsStartAttempted = true;
      gps.click();
    }
  };

  const renderInfo = () => {
    ensureControls();
    if (!card) return;
    const roleText = document.querySelector("#game-status")?.textContent || "Kobler til …";
    const role = /jeger/i.test(roleText) ? "Jeger" : /ute/i.test(roleText) ? "Ute" : /flukt/i.test(roleText) ? "På flukt" : roleText;
    card.querySelector("#info-role").textContent = role;
    card.querySelector("#info-time").textContent = document.querySelector("#timer")?.textContent || "--:--";

    const room = data.room;
    if (room) {
      const now = Date.now();
      const revealEnd = Date.parse(room.reveal_until || "");
      const nextReveal = Date.parse(room.next_reveal_at || "");
      const active = Number.isFinite(revealEnd) && revealEnd > now;
      card.querySelector("#info-pip").textContent = active ? "I gang" : nextReveal > now ? timeText((nextReveal - now) / 1000) : "—";
      card.querySelector("#info-pip-duration").textContent = active
        ? timeText((revealEnd - now) / 1000)
        : room.reveal_seconds ? timeText(room.reveal_seconds) : "—";
    }
    if (data.roles.length) {
      card.querySelector("#info-players").textContent = String(data.roles.filter(item => item.role !== "out").length);
    } else if (data.members.length) {
      card.querySelector("#info-players").textContent = String(data.members.length);
    }
  };

  document.addEventListener("funrun:locate", event => {
    if (gameMap) gameMap.setView(event.detail, Math.max(gameMap.getZoom(), 16));
  });
  const observer = new MutationObserver(() => { ensureControls(); renderInfo(); });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "disabled"] });
  setInterval(() => { hookLeaflet(); ensureControls(); renderInfo(); }, 1000);
})();

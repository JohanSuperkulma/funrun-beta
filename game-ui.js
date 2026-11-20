(() => {
  const style = document.createElement("style");
  style.textContent = `
    #game-view .game-top{display:none!important}
    #game-info-card{position:fixed;z-index:60;top:calc(env(safe-area-inset-top) + 10px);right:10px;width:min(245px,60vw);padding:12px 14px;border:1px solid #8be1a8;border-radius:16px;background:#111a15ed;color:#f4f7f3;box-shadow:0 4px 18px #0008;font:600 13px/1.4 system-ui,sans-serif}
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
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      const copy = response.clone();
      if (/\/rest\/v1\/funrun_rooms(?:\?|$)/.test(url)) {
        const body = await copy.json();
        data.room = Array.isArray(body) ? body[0] : body;
      } else if (/\/rest\/v1\/funrun_members(?:\?|$)/.test(url)) data.members = await copy.json();
      else if (/\/rest\/v1\/funrun_roles(?:\?|$)/.test(url)) data.roles = await copy.json();
      renderInfo();
    } catch (_) {}
    return response;
  };

  let card;
  const ensureControls = () => {
    const game = document.querySelector("#game-view");
    if (!game) return;
    if (!card) {
      card = document.createElement("aside");
      card.id = "game-info-card";
      card.setAttribute("aria-label", "Rundeinformasjon");
      card.innerHTML = '<div>Rolle<strong id="info-role">Kobler til …</strong></div><div class="info-row"><span>Tid igjen</span><span class="info-value" id="info-time">--:--</span></div><div class="info-row"><span>Pip om</span><span class="info-value" id="info-pip">—</span></div><div class="info-row"><span>Pip varer</span><span class="info-value" id="info-pip-duration">—</span></div><div class="info-row"><span>Spillere igjen</span><span class="info-value" id="info-players">—</span></div>';
      game.append(card);
      const locate = document.createElement("button");
      locate.id = "locate-me";
      locate.type = "button";
      locate.title = "Vis meg på kartet";
      locate.setAttribute("aria-label", "Finn meg på kartet");
      locate.textContent = "◎";
      locate.addEventListener("click", () => {
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition(position => {
          const map = document.querySelector("#game-map");
          const leafletId = map?._leaflet_id;
          const instance = leafletId && window.L?._maps?.[leafletId];
          const point = [position.coords.latitude, position.coords.longitude];
          if (instance) instance.setView(point, Math.max(instance.getZoom(), 16));
          else if (window.__funrunCenterMap) window.__funrunCenterMap(point);
          else document.dispatchEvent(new CustomEvent("funrun:locate", { detail: point }));
        }, () => { const status = document.querySelector("#gps-status"); if (status) status.textContent = "Fant ikke posisjonen din. Kontroller posisjonstilgangen."; }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 });
      });
      game.append(locate);
    }
    const gps = document.querySelector("#gps-toggle");
    const status = document.querySelector("#gps-status");
    const gameVisible = game && !game.hidden;
    if (gameVisible && gps && !gps.dataset.autoStartTried && !gps.disabled && /GPS er av|Stopp GPS|GPS kunne/i.test(status?.textContent || "")) {
      gps.dataset.autoStartTried = "true";
      if (/GPS er av/.test(status.textContent)) gps.click();
    }
  };

  const timeText = seconds => Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  const renderInfo = () => {
    ensureControls();
    if (!card) return;
    const roleNode = document.querySelector("#game-status");
    const timerNode = document.querySelector("#timer");
    const roleText = roleNode?.textContent || "Kobler til …";
    const role = /jeger/i.test(roleText) ? "Jeger" : /ute/i.test(roleText) ? "Ute" : /flukt/i.test(roleText) ? "På flukt" : roleText;
    card.querySelector("#info-role").textContent = role;
    card.querySelector("#info-time").textContent = timerNode?.textContent || "--:--";
    const room = data.room;
    if (room) {
      const now = Date.now();
      const active = Date.parse(room.reveal_until || "") > now;
      const next = Date.parse(room.next_reveal_at || "");
      card.querySelector("#info-pip").textContent = active ? "I gang" : next > now ? timeText(Math.ceil((next - now) / 1000)) : "—";
      card.querySelector("#info-pip-duration").textContent = active ? timeText(Math.max(0, Math.ceil((Date.parse(room.reveal_until) - now) / 1000))) : (room.reveal_seconds ? timeText(Number(room.reveal_seconds)) : "—");
    }
    if (Array.isArray(data.roles) && data.roles.length) {
      const alive = data.roles.filter(item => item.role !== "out").length;
      card.querySelector("#info-players").textContent = String(alive);
    }
  };

  document.addEventListener("funrun:locate", event => {
    const map = document.querySelector("#game-map");
    if (map && window.L?.mapInstance) window.L.mapInstance.setView(event.detail, Math.max(window.L.mapInstance.getZoom(), 16));
  });
  const observer = new MutationObserver(() => { ensureControls(); renderInfo(); });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "disabled"] });
  setInterval(renderInfo, 1000);
})();

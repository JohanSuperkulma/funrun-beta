(() => {
  let allowOneClaim = false;
  let claimTimer = null;
  let wheelTimer = null;
  let overlay = null;
  let resultTitle = null;
  let resultEffect = null;
  let userPoint = null;
  const packagePoints = new Map();
  const packageRpc = url => /\/rest\/v1\/rpc\/funrun_claim_package(?:\?|$)/.test(url);

  const ensureOverlay = () => {
    if (overlay) return;
    const style = document.createElement("style");
    style.textContent = `
      .funrun-package-overlay{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;padding:20px;background:#07100eeF;color:#fff;font:600 18px/1.45 system-ui,sans-serif;text-align:center}
      .funrun-package-card{position:relative;width:min(100%,390px);padding:30px 22px;border:1px solid #8be1a8;border-radius:22px;background:#17251c;box-shadow:0 12px 50px #0009;overflow:hidden}
      .funrun-package-burst{height:110px;display:grid;place-items:center;font-size:58px;animation:funrun-burst .85s ease-out both}
      .funrun-package-burst:after{content:'✦  ✧  ✦';position:absolute;top:66px;color:#ffd66b;font-size:25px;letter-spacing:16px;animation:funrun-spark .85s ease-out both}
      .funrun-package-title{margin:8px 0;font-size:clamp(38px,12vw,58px);line-height:1;font-weight:950;letter-spacing:.04em}
      .funrun-package-title.good{color:#69e795}.funrun-package-title.bad{color:#ff7373}
      .funrun-package-overlay button{width:100%;margin-top:18px;padding:12px;border:1px solid #8be1a8;border-radius:12px;background:#8be1a8;color:#102016;font:700 16px system-ui;cursor:pointer}
      .package-radius{stroke:#b3ff4a;stroke-width:3;fill:#b3ff4a;fill-opacity:.12;filter:drop-shadow(0 0 5px #b3ff4a)}
      @keyframes funrun-burst{0%{transform:scale(.15) rotate(-35deg);opacity:0}55%{transform:scale(1.35) rotate(12deg);opacity:1}100%{transform:scale(1);opacity:1}}
      @keyframes funrun-spark{0%{opacity:0;transform:scale(.3)}45%{opacity:1;transform:scale(1.3)}100%{opacity:0;transform:scale(1.7)}}
    `;
    document.head.append(style);
    overlay = document.createElement("div");
    overlay.className = "funrun-package-overlay";
    overlay.hidden = true;
    overlay.innerHTML = '<div class="funrun-package-card"><div class="funrun-package-burst" aria-hidden="true">📦💥</div><h1 class="funrun-package-title">Åpner …</h1><p class="funrun-package-effect"></p><button type="button" hidden>Fortsett</button></div>';
    document.body.append(overlay);
    resultTitle = overlay.querySelector(".funrun-package-title");
    resultEffect = overlay.querySelector(".funrun-package-effect");
    overlay.querySelector("button").addEventListener("click", () => { overlay.hidden = true; });
  };

  const startReveal = () => {
    ensureOverlay();
    overlay.hidden = false;
    resultTitle.textContent = "Pakken åpnes …";
    resultTitle.className = "funrun-package-title";
    resultEffect.textContent = "";
    overlay.querySelector("button").hidden = true;
    clearInterval(wheelTimer);
    clearTimeout(claimTimer);
    claimTimer = setTimeout(() => {
      if (overlay && !overlay.hidden && overlay.querySelector("button").hidden) {
        resultTitle.textContent = "Prøver å åpne pakken";
        resultEffect.textContent = "Stå innenfor den lysende 10-meterssirkelen og prøv igjen.";
        overlay.querySelector("button").hidden = false;
      }
      allowOneClaim = false;
    }, 8000);
  };

  const metersBetween = (a, b) => {
    const rad = n => n * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const value = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
  };
  const refreshOpenButton = () => {
    const button = document.querySelector("#open-package");
    if (!button) return;
    const packages = packagePoints.get("game-map") || [];
    const nearby = userPoint && packages.some(point => metersBetween(userPoint, point) <= 10);
    button.hidden = !nearby;
    if (nearby) button.textContent = "Åpne pakke";
  };

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (packageRpc(url)) {
      if (!allowOneClaim) {
        return new Response(JSON.stringify({ code: "FUNRUN_PACKAGE_MANUAL", message: "Gå nærmere pakken. Du må være innenfor 10 meter." }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }
      allowOneClaim = false;
      const response = await nativeFetch(input, init);
      clearTimeout(claimTimer);
      if (!response.ok) {
        const payload = await response.clone().json().catch(() => ({}));
        if (resultTitle) resultTitle.textContent = payload.message || "Kunne ikke åpne pakken";
        if (resultEffect) resultEffect.textContent = "Gå nærmere pakken, og prøv igjen.";
        if (overlay) overlay.querySelector("button").hidden = false;
        return response;
      }
      const payload = await response.clone().json().catch(() => ({}));
      await new Promise(resolve => setTimeout(resolve, 850));
      const outcome = String(payload.level || payload.outcome || "Fordel");
      const disadvantage = /ulempe|disadvantage/i.test(outcome);
      if (resultTitle) {
        resultTitle.textContent = disadvantage ? "ULEMPE" : "FORDEL";
        resultTitle.className = "funrun-package-title " + (disadvantage ? "bad" : "good");
      }
      if (resultEffect) resultEffect.textContent = payload.effect || "Pakken er åpnet!";
      if (overlay) overlay.querySelector("button").hidden = false;
      return response;
    }
    return nativeFetch(input, init);
  };

  document.addEventListener("click", event => {
    if (!event.target.closest?.("#open-package")) return;
    allowOneClaim = true;
    startReveal();
  }, true);

  const waitForLeaflet = () => {
    if (!window.L) { setTimeout(waitForLeaflet, 30); return; }
    const L = window.L;
    const originalMarker = L.marker;
    L.marker = function(latlng, options) {
      const marker = originalMarker.call(L, latlng, options);
      const html = String(options?.icon?.options?.html || "");
      if (!html.includes("📦")) return marker;
      const point = { lat: Number(latlng.lat ?? latlng[0]), lng: Number(latlng.lng ?? latlng[1]) };
      const originalAddTo = marker.addTo.bind(marker);
      marker.addTo = target => {
        originalAddTo(target);
        const mapId = target?._map?._container?.id;
        if (mapId) {
          if (!packagePoints.has(mapId)) packagePoints.set(mapId, []);
          const list = packagePoints.get(mapId);
          if (!list.some(item => item.lat === point.lat && item.lng === point.lng)) list.push(point);
          if (mapId === "game-map" && target._map) L.circle([point.lat, point.lng], {
            radius: 10, interactive: false, className: "package-radius", color: "#b3ff4a", fillColor: "#b3ff4a", fillOpacity: .12, weight: 3
          }).addTo(target);
          refreshOpenButton();
        }
        return marker;
      };
      return marker;
    };

    const originalLayerGroup = L.layerGroup;
    L.layerGroup = function(...args) {
      const group = originalLayerGroup.apply(L, args);
      const clear = group.clearLayers.bind(group);
      group.clearLayers = () => {
        const mapId = group._map?._container?.id;
        if (mapId) packagePoints.set(mapId, []);
        const result = clear();
        refreshOpenButton();
        return result;
      };
      return group;
    };

    const originalCircleMarker = L.circleMarker;
    L.circleMarker = function(latlng, options) {
      const marker = originalCircleMarker.call(L, latlng, options);
      const originalTooltip = marker.bindTooltip.bind(marker);
      marker.bindTooltip = (content, tooltipOptions) => {
        if (content === "Du") {
          const point = value => ({ lat: Number(value.lat ?? value[0]), lng: Number(value.lng ?? value[1]) });
          userPoint = point(marker.getLatLng());
          const originalSetLatLng = marker.setLatLng.bind(marker);
          marker.setLatLng = value => { const result = originalSetLatLng(value); userPoint = point(value); refreshOpenButton(); return result; };
          refreshOpenButton();
        }
        return originalTooltip(content, tooltipOptions);
      };
      return marker;
    };
    new MutationObserver(refreshOpenButton).observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ["hidden"] });
  };
  waitForLeaflet();
})();

(() => {
  let allowOneClaim = false;
  let claimTimer = null;
  let wheelTimer = null;
  let wheelOverlay = null;
  let wheelText = null;
  let userPoint = null;
  const packagePoints = new Map();
  const outcomes = ["Fordel", "Ulempe", "Ekstrem fordel", "Ekstrem ulempe"];
  const packageRpc = url => /\/rest\/v1\/rpc\/funrun_claim_package(?:\?|$)/.test(url);

  const ensureOverlay = () => {
    if (wheelOverlay) return;
    const style = document.createElement("style");
    style.textContent = `
      .funrun-wheel-overlay{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;padding:22px;background:#08100eeF;color:#fff;font:600 18px/1.45 system-ui,sans-serif;text-align:center}
      .funrun-wheel-card{width:min(100%,390px);padding:26px 20px;border:1px solid #8be1a8;border-radius:22px;background:#17251c;box-shadow:0 12px 50px #0009}
      .funrun-wheel{width:190px;height:190px;margin:12px auto 20px;border:8px solid #8be1a8;border-radius:50%;display:grid;place-items:center;background:conic-gradient(#4cbf7c 0 25%,#f0a34b 25% 50%,#8be1a8 50% 75%,#c76565 75%);box-shadow:0 0 25px #8be1a866;animation:funrun-spin .55s linear infinite}
      .funrun-wheel span{display:grid;place-items:center;width:92px;height:92px;border-radius:50%;background:#17251c;font-size:17px;font-weight:800}
      @keyframes funrun-spin{to{transform:rotate(360deg)}}
      .funrun-wheel-overlay button{width:100%;margin-top:14px;padding:12px;border:1px solid #8be1a8;border-radius:12px;background:#8be1a8;color:#102016;font:700 16px system-ui;cursor:pointer}
      .package-radius{stroke:#b3ff4a;stroke-width:3;fill:#b3ff4a;fill-opacity:.12;filter:drop-shadow(0 0 5px #b3ff4a)}
    `;
    document.head.append(style);
    wheelOverlay = document.createElement("div");
    wheelOverlay.className = "funrun-wheel-overlay";
    wheelOverlay.hidden = true;
    wheelOverlay.innerHTML = '<div class="funrun-wheel-card"><h1 style="margin:0">Pakkehjulet</h1><div class="funrun-wheel"><span>📦</span></div><p class="funrun-wheel-text">Snurrer …</p><button type="button" hidden>Lukk</button></div>';
    document.body.append(wheelOverlay);
    wheelText = wheelOverlay.querySelector(".funrun-wheel-text");
    wheelOverlay.querySelector("button").addEventListener("click", () => { wheelOverlay.hidden = true; });
  };

  const startWheel = () => {
    ensureOverlay();
    wheelOverlay.hidden = false;
    wheelText.textContent = "Snurrer …";
    wheelOverlay.querySelector("button").hidden = true;
    let index = 0;
    clearInterval(wheelTimer);
    wheelTimer = setInterval(() => { wheelText.textContent = outcomes[index++ % outcomes.length] + " …"; }, 120);
    clearTimeout(claimTimer);
    claimTimer = setTimeout(() => {
      if (wheelOverlay && !wheelOverlay.hidden && wheelOverlay.querySelector("button").hidden) {
        clearInterval(wheelTimer);
        wheelText.textContent = "Stå innenfor den lysende 10-meterssirkelen og prøv igjen.";
        wheelOverlay.querySelector("button").hidden = false;
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
        return new Response(JSON.stringify({ code: "FUNRUN_PACKAGE_MANUAL", message: "ikke nær nok: Trykk «Åpne pakke» når du står ved pakken." }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }
      allowOneClaim = false;
      const response = await nativeFetch(input, init);
      if (!response.ok) {
        clearInterval(wheelTimer);
        clearTimeout(claimTimer);
        const payload = await response.clone().json().catch(() => ({}));
        if (wheelText) wheelText.textContent = payload.message || "Kunne ikke åpne pakken. Prøv igjen nærmere pakken.";
        if (wheelOverlay) wheelOverlay.querySelector("button").hidden = false;
        return response;
      }
      const payload = await response.clone().json().catch(() => ({}));
      await new Promise(resolve => setTimeout(resolve, 3200));
      clearInterval(wheelTimer);
      clearTimeout(claimTimer);
      if (wheelText) wheelText.textContent = (payload.level || "Pakke åpnet") + (payload.effect ? " — " + payload.effect : "!");
      if (wheelOverlay) wheelOverlay.querySelector("button").hidden = false;
      return response;
    }
    return nativeFetch(input, init);
  };

  document.addEventListener("click", event => {
    const button = event.target.closest?.("#open-package");
    if (!button) return;
    allowOneClaim = true;
    startWheel();
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
          const point = latlng => ({ lat: Number(latlng.lat ?? latlng[0]), lng: Number(latlng.lng ?? latlng[1]) });
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

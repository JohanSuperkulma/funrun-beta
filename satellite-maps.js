(() => {
  const waitForLeaflet = () => {
    if (!window.L || typeof window.L.tileLayer !== "function") {
      window.setTimeout(waitForLeaflet, 25);
      return;
    }

    const originalTileLayer = window.L.tileLayer;
    window.L.tileLayer = function(url, options) {
      const layer = originalTileLayer.call(window.L, url, options);
      const originalAddTo = layer.addTo.bind(layer);

      layer.addTo = target => {
        originalAddTo(target);
        if (!target || !target._container || target._funrunBaseSwitchAdded) return layer;
        if (!/tile\.openstreetmap\.org|openstreetmap/i.test(String(url))) return layer;

        target._funrunBaseSwitchAdded = true;
        const satellite = window.L.tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          {
            maxZoom: 19,
            attribution: "Tiles © Esri — Sources: Esri, Maxar, Earthstar Geographics, USGS"
          }
        );
        window.L.control.layers(
          { "Veikart": layer, "Satellitt": satellite },
          null,
          { position: "topright", collapsed: false }
        ).addTo(target);
        return layer;
      };
      return layer;
    };
  };
  waitForLeaflet();
})();

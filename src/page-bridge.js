// Runs in the page's main world (not the isolated content-script world) so it
// can reach RWGPS's MapLibre map and draw the flagged stretches on it.
// Talks to content.js via window.postMessage:
//   in:  {__rts: 'to-page', type: 'highlight', features}  (GeoJSON features)
//        {__rts: 'to-page', type: 'fit', bounds: [[w, s], [e, n]]}
//   out: {__rts: 'to-content', type: 'highlight-result', ok}
//        {__rts: 'to-content', type: 'stretch-click', index}
(function () {
  const SRC = 'rts-unsurfaced';
  const CASING = 'rts-unsurfaced-casing';
  const LINE = 'rts-unsurfaced-line';
  const WIDTH = (base) => ['interpolate', ['linear'], ['zoom'], 8, base, 13, base * 2, 17, base * 3.5];

  let data = { type: 'FeatureCollection', features: [] };
  let map = null;
  const hooked = new WeakSet();

  const post = (msg) => window.postMessage({ __rts: 'to-content', ...msg }, location.origin);

  function isMap(v) {
    return v && typeof v === 'object' && typeof v.addLayer === 'function' &&
      typeof v.getSource === 'function' && typeof v.project === 'function';
  }

  // RWGPS keeps the map instance in a React context ("mapContext.mapInstance");
  // walk up the React fiber tree from the map container to find it. This relies
  // on RWGPS internals, so it fails soft (returns null) if their code changes.
  function findMap() {
    if (map && !map._removed && map.getContainer().isConnected) return map;
    map = null;
    for (const el of document.querySelectorAll('.maplibregl-map')) {
      for (let n = el; n && !map; n = n.parentElement) {
        const fk = Object.keys(n).find((k) => k.startsWith('__reactFiber$'));
        if (!fk) continue;
        for (let f = n[fk], depth = 0; f && depth < 40 && !map; f = f.return, depth++) {
          const props = f.memoizedProps;
          if (!props || typeof props !== 'object') continue;
          for (const v of Object.values(props)) {
            if (isMap(v)) { map = v; break; }
            if (v && typeof v === 'object' && isMap(v.mapInstance)) { map = v.mapInstance; break; }
          }
        }
      }
      if (map) break;
    }
    return map;
  }

  function layerOrder(m) {
    return typeof m.getLayersOrder === 'function' ? m.getLayersOrder() : m.getStyle().layers.map((l) => l.id);
  }

  // Add source/layers if missing (they vanish when the map style changes) and
  // keep them above RWGPS's route line.
  function ensureLayers(m) {
    if (!m.getSource(SRC)) m.addSource(SRC, { type: 'geojson', data });
    if (!m.getLayer(CASING)) {
      m.addLayer({
        id: CASING, type: 'line', source: SRC,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#111827', 'line-width': WIDTH(4), 'line-opacity': 0.9 },
      });
    }
    if (!m.getLayer(LINE)) {
      m.addLayer({
        id: LINE, type: 'line', source: SRC,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#facc15', 'line-width': WIDTH(2.4) },
      });
    }
    const order = layerOrder(m);
    if (order[order.length - 1] !== LINE || order[order.length - 2] !== CASING) {
      m.moveLayer(CASING);
      m.moveLayer(LINE);
    }
  }

  function hook(m) {
    if (hooked.has(m)) return;
    hooked.add(m);
    m.on('styledata', () => { try { if (data.features.length) ensureLayers(m); } catch (e) { /* style mid-load */ } });
    m.on('click', LINE, (e) => {
      const f = e.features && e.features[0];
      if (f) post({ type: 'stretch-click', index: f.properties.index });
    });
    m.on('mouseenter', LINE, () => { m.getCanvas().style.cursor = 'pointer'; });
    m.on('mouseleave', LINE, () => { m.getCanvas().style.cursor = ''; });
  }

  function apply() {
    const m = findMap();
    if (!m) return false;
    hook(m);
    try {
      ensureLayers(m);
      m.getSource(SRC).setData(data);
    } catch (e) {
      // Style still loading; styledata will add the layers once it is ready.
      m.once('load', () => { try { ensureLayers(m); m.getSource(SRC).setData(data); } catch (e2) { /* ignore */ } });
    }
    return true;
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__rts !== 'to-page') return;
    const msg = ev.data;
    if (msg.type === 'highlight') {
      data = { type: 'FeatureCollection', features: msg.features || [] };
      post({ type: 'highlight-result', ok: apply() });
    } else if (msg.type === 'fit') {
      const m = findMap();
      if (m) m.fitBounds(msg.bounds, { padding: 80, maxZoom: 16 });
    }
  });

  // RWGPS may replace its map (e.g. on in-app navigation); re-apply to the new one.
  setInterval(() => {
    if (!data.features.length) return;
    const m = findMap();
    if (m && !m.getSource(SRC)) apply();
  }, 2000);
})();

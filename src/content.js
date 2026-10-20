// Content script: adds a "Surface check" button to RideWithGPS route, trip and
// route planner pages. It loads the route geometry, asks the local Postpass
// server for highway=tertiary ways without a surface tag along the route, and highlights the matching stretches on RWGPS's own map
// (via page-bridge.js) and in a details panel. In the planner it re-checks
// automatically whenever RWGPS autosaves the route.
(function () {
  const HIGHWAY_TYPES = ['tertiary'];
  const SIMPLIFY_TOL_M = 10;     // route simplification before querying
  const AUTOSAVE_DEBOUNCE_MS = 800;

  const QUERY_PAD_M = 30;        // corridor half-width around the simplified route
  // Area the local Postpass has data for (S, W, N, E): Finland.
  const COVERAGE_BBOX = [59.3, 19.0, 70.2, 31.7];

  const PLANNER_RE = /^\/routes\/(?:new|(\d+)\/edit)\/?$/;
  const PAGE_RE = /^\/(routes|trips)\/(\d+)/;
  let btn = null, panel = null, lmap = null, lastPath = null;
  let last = null;               // {key, version, result} of the latest finished check
  let runSeq = 0;                // increments per check; stale results are dropped
  let autosaveVersion = null, autosaveTimer = null;

  // ---- page detection (RWGPS is a single-page app) -------------------------

  function currentTarget() {
    const p = location.pathname.match(PLANNER_RE);
    if (p) return { kind: 'routes', id: p[1] || null, planner: true, key: 'planner' + location.pathname };
    const m = location.pathname.match(PAGE_RE);
    return m ? { kind: m[1], id: m[2], key: m[1] + '/' + m[2] } : null;
  }

  // Identifies the planner's current autosave; changes on every route edit.
  function plannerVersion() {
    try { return localStorage.getItem('jStorage_update'); } catch (e) { return null; }
  }

  function onLocationChange() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    const target = currentTarget();
    if (!target) {
      removeUI();
      highlightOnMap(null);
      return;
    }
    ensureButton();
    // In the planner the bottom-left corner holds RWGPS's Save button.
    btn.classList.toggle('rts-fab--planner', !!target.planner);
    if (panel && panel.dataset.key !== target.key) closePanel();
    if (last && last.key !== target.key) { highlightOnMap(null); setFab(null); }
    autosaveVersion = null; // force a first planner check on this page
  }

  // The `storage` event doesn't fire in the tab that wrote the value, so poll
  // the planner's autosave stamp (a cheap string read) and debounce edits.
  function watchAutosave() {
    const target = currentTarget();
    if (!target || !target.planner) return;
    const v = plannerVersion();
    if (v === autosaveVersion) return;
    autosaveVersion = v;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => runCheck(target, { auto: true }), AUTOSAVE_DEBOUNCE_MS);
  }

  setInterval(() => { onLocationChange(); watchAutosave(); }, 500);
  onLocationChange();

  // ---- data -----------------------------------------------------------------

  // The route planner autosaves the route being edited (including unsaved
  // changes) to localStorage via jStorage; content scripts share the page's
  // localStorage, so read the active route from there.
  function plannerRoute() {
    try {
      const routes = JSON.parse(localStorage.getItem('jStorage') || '{}').locallySavedRoute?.routes || [];
      const r = routes.find((x) => x.active) || routes[0];
      return r && Array.isArray(r.track_points) && r.track_points.length >= 2 ? r : null;
    } catch (e) {
      console.warn('[RWGPS surface check] could not read planner route', e);
      return null;
    }
  }

  async function loadRoute(target) {
    let obj = target.planner ? plannerRoute() : null;
    if (obj) {
      obj = { ...obj, name: obj.name || 'Planner route', fromPlanner: true };
    } else if (target.planner && !target.id) {
      throw new Error('Add at least two points to the route first.');
    } else {
      const res = await fetch(`/${target.kind}/${target.id}.json`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`Could not load ${target.kind.slice(0, -1)} (HTTP ${res.status})`);
      const json = await res.json();
      obj = json.route || json.trip || json;
    }
    const tps = obj.track_points || [];
    if (tps.length < 2) throw new Error('Route has no track points');

    // Some payloads lack "d"; compute cumulative distance if needed.
    const pts = [];
    let d = 0;
    for (let i = 0; i < tps.length; i++) {
      const p = tps[i];
      if (typeof p.x !== 'number' || typeof p.y !== 'number') continue;
      const prev = pts[pts.length - 1];
      if (prev) d += haversine(prev.lat, prev.lon, p.y, p.x);
      pts.push({ lat: p.y, lon: p.x, d: typeof p.d === 'number' ? p.d : d });
    }
    return { name: obj.name || target.key, points: pts, fromPlanner: !!obj.fromPlanner };
  }

  async function analyse(target, onStatus) {
    onStatus('Loading route…');
    const route = await loadRoute(target);

    const proj = RTSGeo.makeProjection(route.points);
    const xy = route.points.map((p) => proj.fwd(p.lat, p.lon));
    const simplified = RTSGeo.simplify(xy, SIMPLIFY_TOL_M).map((i) => route.points[i]);

    const [s, w, n, e] = COVERAGE_BBOX;
    if (!route.points.every((p) => p.lat >= s && p.lon >= w && p.lat <= n && p.lon <= e)) {
      throw new Error('Route leaves the area covered by the local Postpass data (Finland).');
    }

    onStatus(`Querying local Postpass (${simplified.length} route points)…`);
    const ways = await RTSPostpass.fetchUnsurfacedWays(simplified, HIGHWAY_TYPES, QUERY_PAD_M);
    const source = 'local Postpass';

    onStatus(`Matching ${ways.length} candidate ways…`);
    const stretches = RTSMatch.findStretches(route.points, ways);

    const totalM = route.points[route.points.length - 1].d;
    return { route, ways, stretches, totalM, source };
  }

  // Runs a check (or reuses a fresh one) and updates button, map and panel.
  // auto: planner autosave trigger, fails quietly.
  async function runCheck(target, { auto = false, force = false } = {}) {
    const version = target.planner ? plannerVersion() : null;
    if (!force && last && last.key === target.key && last.version === version && last.result) return last.result;

    if (target.planner && !plannerRoute() && !target.id) {
      last = { key: target.key, version, result: null };
      highlightOnMap(null);
      setFab(null);
      return null;
    }

    const seq = ++runSeq;
    setFab('checking');
    const onStatus = (msg) => { if (panel && seq === runSeq) panelStatus(msg); };
    try {
      const result = await analyse(target, onStatus);
      if (seq !== runSeq) return result;
      last = { key: target.key, version, result };
      setFab(result);
      highlightOnMap(result);
      if (panel && panel.dataset.key === target.key) renderPanel(result);
      return result;
    } catch (e) {
      if (seq !== runSeq) return null;
      console[auto ? 'info' : 'error']('[RWGPS surface check]', e);
      setFab({ error: e.message || String(e) });
      if (auto) highlightOnMap(null);
      if (panel && panel.dataset.key === target.key) panelError(e);
      return null;
    }
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
  }

  // ---- RWGPS map (via page-bridge.js in the page's main world) --------------

  let mapOk = null;  // did the bridge manage to draw on RWGPS's map?

  function highlightOnMap(result) {
    const features = result ? result.stretches.map((st, i) => ({
      type: 'Feature',
      properties: { index: i },
      geometry: { type: 'LineString', coordinates: st.latlngs.map(([lat, lon]) => [lon, lat]) },
    })) : [];
    window.postMessage({ __rts: 'to-page', type: 'highlight', features }, location.origin);
  }

  function fitRwgpsMap(latlngs) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [lat, lon] of latlngs) { w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat); }
    window.postMessage({ __rts: 'to-page', type: 'fit', bounds: [[w, s], [e, n]] }, location.origin);
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__rts !== 'to-content') return;
    if (ev.data.type === 'highlight-result') mapOk = ev.data.ok;
    if (ev.data.type === 'stretch-click') showStretch(ev.data.index);
  });

  // ---- UI -------------------------------------------------------------------

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }

  const km = (m) => (m / 1000).toFixed(1);
  const flaggedM = (result) => result.stretches.reduce((s, st) => s + st.lengthM, 0);

  function ensureButton() {
    if (btn && document.body.contains(btn)) return;
    btn = el('button', { class: 'rts-fab', type: 'button', onclick: onFabClick });
    document.body.append(btn);
    setFab(null);
  }

  // state: null (idle) | 'checking' | {error} | result
  function setFab(state) {
    if (!btn) return;
    btn.classList.remove('rts-fab--ok', 'rts-fab--busy');
    let text = 'Surface check', title = 'Find tertiary roads with no surface data';
    if (state === 'checking') {
      text = 'Checking surfaces…';
      btn.classList.add('rts-fab--busy');
    } else if (state && state.error) {
      title = state.error;
    } else if (state && state.stretches) {
      const n = state.stretches.length;
      if (n) {
        text = `⚠ ${n} unsurfaced · ${km(flaggedM(state))} km`;
        title = 'Tertiary roads with no surface data on this route (marked yellow on the map). Click for details.';
      } else {
        text = '✓ No unsurfaced tertiary';
        btn.classList.add('rts-fab--ok');
        title = 'No highway=tertiary without surface data on this route. Click for details.';
      }
    }
    btn.textContent = text;
    btn.title = title;
  }

  function removeUI() {
    closePanel();
    if (btn) btn.remove();
    btn = null;
  }

  async function onFabClick() {
    const target = currentTarget();
    if (!target) return;
    if (panel) { closePanel(); return; }
    openPanel(target);
    const result = await runCheck(target);
    if (result && panel && panel.dataset.key === target.key) renderPanel(result);
  }

  // ---- details panel --------------------------------------------------------

  let panelBody = null, overlay = null, stretchLayers = [], listItems = [];

  function closePanel() {
    if (lmap) { lmap.remove(); lmap = null; }
    if (panel) panel.remove();
    panel = panelBody = overlay = null;
    stretchLayers = [];
    listItems = [];
  }

  function openPanel(target) {
    const mapDiv = el('div', { class: 'rts-map' });
    panelBody = el('div', { class: 'rts-body' }, el('div', { class: 'rts-status' }, 'Starting…'));
    panel = el('div', { class: 'rts-panel' },
      el('div', { class: 'rts-head' },
        el('strong', {}, 'Unsurfaced tertiary roads'),
        el('span', {},
          el('button', { class: 'rts-x', type: 'button', title: 'Re-check', onclick: () => runCheck(target, { force: true }) }, '↻'),
          el('button', { class: 'rts-x', type: 'button', title: 'Close', onclick: closePanel }, '×'))),
      mapDiv, panelBody);
    panel.dataset.key = target.key;
    document.body.append(panel);

    lmap = L.map(mapDiv, { zoomControl: true, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
    }).addTo(lmap);
    lmap.setView([0, 0], 2);
    overlay = L.layerGroup().addTo(lmap);
  }

  function panelStatus(msg) {
    if (!panelBody) return;
    panelBody.replaceChildren(el('div', { class: 'rts-status' }, msg));
  }

  function panelError(e) {
    if (!panelBody) return;
    const target = currentTarget();
    panelBody.replaceChildren(
      el('div', { class: 'rts-status rts-error' }, 'Error: ' + (e.message || e)),
      el('button', { class: 'rts-btn', type: 'button', onclick: () => target && runCheck(target, { force: true }) }, 'Retry'));
  }

  // Panel open from a click on a stretch drawn on RWGPS's map.
  function showStretch(i) {
    const target = currentTarget();
    if (!target || !last || last.key !== target.key || !last.result) return;
    if (!panel) { openPanel(target); renderPanel(last.result); }
    const li = listItems[i];
    if (!li) return;
    for (const x of listItems) x.classList.remove('rts-active');
    li.classList.add('rts-active');
    li.scrollIntoView({ block: 'nearest' });
    lmap.fitBounds(stretchLayers[i].getBounds(), { padding: [30, 30], maxZoom: 17 });
  }

  function renderPanel(result) {
    if (!panel || !lmap) return;
    const { route, stretches, totalM, source } = result;
    overlay.clearLayers();

    const routeLine = L.polyline(route.points.map((p) => [p.lat, p.lon]), { color: '#2563eb', weight: 4, opacity: 0.7 }).addTo(overlay);
    lmap.fitBounds(routeLine.getBounds(), { padding: [10, 10] });

    // Full OSM ways faintly, matched route stretches boldly.
    const shownWays = new Set();
    stretchLayers = stretches.map((st) => {
      for (const w of st.ways) {
        if (shownWays.has(w)) continue;
        shownWays.add(w);
        L.polyline(w.geometry.filter(Boolean).map((p) => [p.lat, p.lon]), { color: '#f97316', weight: 3, opacity: 0.45, dashArray: '4 6' }).addTo(overlay);
      }
      return L.polyline(st.latlngs, { color: '#dc2626', weight: 7, opacity: 0.9 })
        .bindTooltip(`${km(st.startM)}–${km(st.endM)} km · ${wayLabel(st.ways)}`)
        .addTo(overlay);
    });

    const what = route.fromPlanner ? 'the planner route (re-checked on every autosave)' : 'this route';
    const where = mapOk === false ? ' Could not draw on the RWGPS map; see the map above.' : ' Marked yellow on the RWGPS map.';
    const status = el('div', { class: 'rts-status' });
    if (!stretches.length) {
      status.textContent = `No highway=tertiary without surface found along ${what} (${km(totalM)} km, data: ${source}).`;
      panelBody.replaceChildren(status);
      listItems = [];
      return;
    }
    const fm = flaggedM(result);
    status.textContent = `${stretches.length} stretch${stretches.length > 1 ? 'es' : ''}, ` +
      `${km(fm)} km of ${km(totalM)} km (${((100 * fm) / totalM).toFixed(1)} %) of ${what} ` +
      `on tertiary roads with unknown surface (data: ${source}).` + where;

    const list = el('ol', { class: 'rts-list' });
    listItems = stretches.map((st, i) => {
      const osmLinks = el('span', { class: 'rts-links' });
      for (const w of uniqueWays(st.ways)) {
        osmLinks.append(
          el('a', { href: `https://www.openstreetmap.org/way/${w.id}`, target: '_blank', rel: 'noopener', title: 'View on OSM' }, `way ${w.id}`),
          ' ',
          el('a', { href: `https://www.openstreetmap.org/edit?way=${w.id}`, target: '_blank', rel: 'noopener', title: 'Add a surface tag in the OSM editor' }, '✎'),
          ' ');
      }
      const li = el('li', {
        onmouseenter: () => stretchLayers[i].setStyle({ color: '#facc15' }),
        onmouseleave: () => stretchLayers[i].setStyle({ color: '#dc2626' }),
      },
        el('a', { href: '#', class: 'rts-jump', title: 'Zoom both maps to this stretch', onclick: (ev) => {
          ev.preventDefault();
          lmap.fitBounds(stretchLayers[i].getBounds(), { padding: [30, 30], maxZoom: 17 });
          fitRwgpsMap(st.latlngs);
        } }, `${km(st.startM)}–${km(st.endM)} km`),
        ` (${Math.round(st.lengthM)} m) · ${wayLabel(st.ways)}`,
        el('br'), osmLinks);
      list.append(li);
      return li;
    });
    panelBody.replaceChildren(status, list,
      el('button', { class: 'rts-btn', type: 'button', onclick: () => downloadGeoJSON(result) }, 'Download GeoJSON'));
  }

  // A way can appear once per geometry part; keep one entry per OSM id.
  function uniqueWays(ways) {
    return [...new Map(ways.map((w) => [w.id, w])).values()];
  }

  function wayLabel(ways) {
    const names = [...new Set(ways.map((w) => w.tags.name || w.tags.ref).filter(Boolean))];
    return names.length ? names.join(', ') : '(unnamed)';
  }

  function downloadGeoJSON(result) {
    const fc = {
      type: 'FeatureCollection',
      features: result.stretches.map((st) => ({
        type: 'Feature',
        properties: {
          start_km: +km(st.startM), end_km: +km(st.endM), length_m: Math.round(st.lengthM),
          name: wayLabel(st.ways), osm_way_ids: uniqueWays(st.ways).map((w) => w.id),
        },
        geometry: { type: 'LineString', coordinates: st.latlngs.map(([lat, lon]) => [lon, lat]) },
      })),
    };
    const a = el('a', {
      href: URL.createObjectURL(new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' })),
      download: `${result.route.name.replace(/[^\w\-]+/g, '_')}-unsurfaced-tertiary.geojson`,
    });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
})();

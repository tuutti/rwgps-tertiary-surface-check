// Match the route against OSM ways: walk along the route in small steps and
// flag each step that runs along (close to, and roughly parallel with) one of
// the given ways. Consecutive flagged steps become "stretches".
var RTSMatch = (function () {
  const DEFAULTS = {
    stepM: 10,          // sampling step along the route
    maxDistM: 15,       // max distance from route to the OSM way
    maxAngleDeg: 35,    // max heading difference (rejects perpendicular crossings)
    maxGapM: 40,        // bridge short unflagged gaps inside a stretch
    minLengthM: 50,     // drop stretches shorter than this
  };

  // route: [{lat, lon, d}] with d = cumulative distance in metres
  // ways:  [{id, tags, geometry: [{lat, lon}]}]
  function findStretches(route, ways, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    if (route.length < 2 || ways.length === 0) return [];

    const proj = RTSGeo.makeProjection(route);
    const grid = new RTSGeo.SegmentGrid(Math.max(50, o.maxDistM * 2));
    ways.forEach((w, wi) => {
      const g = w.geometry.filter(Boolean).map((p) => proj.fwd(p.lat, p.lon));
      for (let i = 0; i < g.length - 1; i++) {
        grid.add({ ax: g[i].x, ay: g[i].y, bx: g[i + 1].x, by: g[i + 1].y, wi });
      }
    });

    const maxD2 = o.maxDistM * o.maxDistM;
    const xy = route.map((p) => proj.fwd(p.lat, p.lon));
    const samples = []; // {d, lat, lon, wi|-1}

    for (let i = 0; i < xy.length - 1; i++) {
      const a = xy[i], b = xy[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;
      const n = Math.max(1, Math.ceil(len / o.stepM));
      const dStart = route[i].d, dLen = route[i + 1].d - route[i].d;
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const px = a.x + dx * t, py = a.y + dy * t;
        let best = -1, bestD2 = maxD2;
        for (const s of grid.near(px, py)) {
          const d2 = RTSGeo.pointSegDist2(px, py, s.ax, s.ay, s.bx, s.by);
          if (d2 > bestD2) continue;
          if (RTSGeo.lineAngleDiff(dx, dy, s.bx - s.ax, s.by - s.ay) > o.maxAngleDeg) continue;
          best = s.wi;
          bestD2 = d2;
        }
        const ll = proj.inv(px, py);
        samples.push({ d: dStart + dLen * t, lat: ll.lat, lon: ll.lon, wi: best });
      }
    }
    const last = route[route.length - 1];
    samples.push({ d: last.d, lat: last.lat, lon: last.lon, wi: -1 });

    // Group flagged samples into stretches, bridging small gaps.
    const stretches = [];
    let cur = null;
    let lastFlagged = -1;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (s.wi < 0) continue;
      if (cur && s.d - samples[lastFlagged].d <= o.maxGapM) {
        for (let j = lastFlagged + 1; j <= i; j++) cur.points.push(samples[j]);
        cur.wayIdx.add(s.wi);
      } else {
        if (cur) stretches.push(cur);
        cur = { points: [s], wayIdx: new Set([s.wi]) };
      }
      lastFlagged = i;
    }
    if (cur) stretches.push(cur);

    return stretches
      .map((st) => {
        // Extend to the next sample so the drawn line covers the last step.
        const endIdx = samples.indexOf(st.points[st.points.length - 1]);
        const end = samples[Math.min(endIdx + 1, samples.length - 1)];
        const pts = st.points.concat(end === st.points[st.points.length - 1] ? [] : [end]);
        const wayList = [...st.wayIdx].map((wi) => ways[wi]);
        return {
          startM: pts[0].d,
          endM: pts[pts.length - 1].d,
          lengthM: pts[pts.length - 1].d - pts[0].d,
          latlngs: pts.map((p) => [p.lat, p.lon]),
          ways: wayList,
        };
      })
      .filter((st) => st.lengthM >= o.minLengthM);
  }

  return { findStretches, DEFAULTS };
})();

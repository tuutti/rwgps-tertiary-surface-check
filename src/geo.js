// Geometry helpers. Everything is projected to a local equirectangular plane
// (metres) centred on the route, which is accurate enough for ~15 m matching.
var RTSGeo = (function () {
  const EARTH_R = 6371008.8;
  const DEG = Math.PI / 180;

  function makeProjection(points) {
    let lat0 = 0;
    for (const p of points) lat0 += p.lat;
    lat0 /= points.length || 1;
    const kx = Math.cos(lat0 * DEG) * EARTH_R * DEG;
    const ky = EARTH_R * DEG;
    return {
      fwd: (lat, lon) => ({ x: lon * kx, y: lat * ky }),
      inv: (x, y) => ({ lat: y / ky, lon: x / kx }),
    };
  }

  // Squared distance from point p to segment ab, plus the projection parameter t.
  function pointSegDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx - px, cy = ay + t * dy - py;
    return cx * cx + cy * cy;
  }

  // Douglas-Peucker on projected points; returns indices to keep.
  function simplify(xy, tolerance) {
    const n = xy.length;
    if (n <= 2) return xy.map((_, i) => i);
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const tol2 = tolerance * tolerance;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      let maxD = -1, idx = -1;
      for (let i = s + 1; i < e; i++) {
        const d = pointSegDist2(xy[i].x, xy[i].y, xy[s].x, xy[s].y, xy[e].x, xy[e].y);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tol2) {
        keep[idx] = 1;
        stack.push([s, idx], [idx, e]);
      }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
    return out;
  }

  // Uniform grid of line segments for fast "what is near this point" lookups.
  function SegmentGrid(cellSize) {
    this.cell = cellSize;
    this.map = new Map();
    this.segs = [];
  }
  SegmentGrid.prototype.key = function (cx, cy) { return cx + ',' + cy; };
  SegmentGrid.prototype.add = function (seg) {
    const id = this.segs.push(seg) - 1;
    const c = this.cell;
    const x0 = Math.floor(Math.min(seg.ax, seg.bx) / c), x1 = Math.floor(Math.max(seg.ax, seg.bx) / c);
    const y0 = Math.floor(Math.min(seg.ay, seg.by) / c), y1 = Math.floor(Math.max(seg.ay, seg.by) / c);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = this.key(x, y);
        let arr = this.map.get(k);
        if (!arr) this.map.set(k, (arr = []));
        arr.push(id);
      }
    }
  };
  // Candidate segments within one cell of the point (cell must be >= search radius).
  SegmentGrid.prototype.near = function (x, y) {
    const c = this.cell, cx = Math.floor(x / c), cy = Math.floor(y / c);
    const seen = new Set();
    const out = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = this.map.get(this.key(cx + dx, cy + dy));
        if (!arr) continue;
        for (const id of arr) {
          if (!seen.has(id)) { seen.add(id); out.push(this.segs[id]); }
        }
      }
    }
    return out;
  };

  // Smallest angle between two undirected headings, in degrees (0..90).
  function lineAngleDiff(dx1, dy1, dx2, dy2) {
    const a1 = Math.atan2(dy1, dx1), a2 = Math.atan2(dy2, dx2);
    let d = Math.abs(a1 - a2) % Math.PI;
    if (d > Math.PI / 2) d = Math.PI - d;
    return d / DEG;
  }

  return { makeProjection, simplify, pointSegDist2, SegmentGrid, lineAngleDiff };
})();

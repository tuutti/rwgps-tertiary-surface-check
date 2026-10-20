// Postpass (PostGIS) access: fetch OSM ways of the given highway types that
// have no surface tag and intersect a buffer around the route. Returns
// [{id, tags, geometry: [{lat, lon}]}], one entry per line part.
var RTSPostpass = (function () {
  function buildSql(latlngs, highwayTypes, padM) {
    for (const t of highwayTypes) {
      if (!/^[a-z_]+$/.test(t)) throw new Error('Bad highway type: ' + t);
    }
    const line = latlngs.map((p) => p.lon.toFixed(6) + ' ' + p.lat.toFixed(6)).join(',');
    const types = highwayTypes.map((t) => `'${t}'`).join(',');
    // Subdividing the buffer keeps the index lookups tight for long/looping routes.
    return `WITH route AS (
  SELECT ST_Subdivide(ST_Buffer(ST_GeomFromText('LINESTRING(${line})', 4326)::geography, ${Number(padM)})::geometry, 64) AS g
)
SELECT DISTINCT ON (l.osm_id) l.osm_id, l.tags, l.geom
FROM postpass_line l
JOIN route r ON ST_Intersects(l.geom, r.g)
WHERE l.osm_type = 'W'
  AND l.tags->>'highway' IN (${types})
  AND NOT (l.tags ? 'surface')
ORDER BY l.osm_id`;
  }

  async function fetchUnsurfacedWays(latlngs, highwayTypes, padM) {
    const res = await chrome.runtime.sendMessage({ type: 'postpass', sql: buildSql(latlngs, highwayTypes, padM) });
    if (!res || !res.ok) {
      throw new Error(`Postpass: ${res ? (res.status ? 'HTTP ' + res.status + ' ' : '') + res.text.slice(0, 200) : 'no response'}`);
    }
    const fc = JSON.parse(res.text);
    const ways = [];
    for (const f of fc.features || []) {
      const g = f.geometry;
      if (!g) continue;
      const parts = g.type === 'MultiLineString' ? g.coordinates : g.type === 'LineString' ? [g.coordinates] : [];
      for (const part of parts) {
        ways.push({
          id: f.properties.osm_id,
          tags: f.properties.tags || {},
          geometry: part.map(([lon, lat]) => ({ lat, lon })),
        });
      }
    }
    return ways;
  }

  return { fetchUnsurfacedWays, buildSql };
})();

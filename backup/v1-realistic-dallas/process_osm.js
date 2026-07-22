// Convert downtown Dallas OSM data -> compact game geometry (local meters).
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('/Users/joelcomm/driver/dallas_osm.json', 'utf8'));

// projection center (middle of the queried box)
const lat0 = 32.78225, lon0 = -96.8010;
const MPD_LAT = 110540, MPD_LON = 111320 * Math.cos(lat0 * Math.PI / 180);
const px = (lon) => (lon - lon0) * MPD_LON;
const pz = (lat) => -(lat - lat0) * MPD_LAT;      // north = -z
const r1 = (n) => Math.round(n * 10) / 10;

const driveable = new Set(['motorway','trunk','primary','secondary','tertiary','residential','unclassified',
  'motorway_link','trunk_link','primary_link','secondary_link','tertiary_link','living_street','service']);
const roadWidth = { motorway:15, trunk:14, primary:12, secondary:10, tertiary:9, residential:8,
  unclassified:8, living_street:7, service:6 };

function parseHeight(tags) {
  if (!tags) return null;
  if (tags.height) { const h = parseFloat(tags.height); if (!isNaN(h)) return h; }
  if (tags['building:levels']) { const l = parseFloat(tags['building:levels']); if (!isNaN(l)) return l * 3.5 + 1.5; }
  return null;
}

const buildings = [], roads = [], signals = [], named = [];
let bDropped = 0;

for (const el of raw.elements) {
  if (el.type === 'node' && el.tags && el.tags.highway === 'traffic_signals') {
    signals.push([r1(px(el.lon)), r1(pz(el.lat))]);
    continue;
  }
  if (el.type !== 'way' || !el.geometry) continue;
  const tags = el.tags || {};

  if (tags.building || tags['building:part']) {
    const g = el.geometry;
    if (g.length < 4) continue;
    // footprint polygon (drop the closing duplicate point)
    let pts = g.map(n => [px(n.lon), pz(n.lat)]);
    if (pts.length > 2) {
      const a = pts[0], b = pts[pts.length-1];
      if (Math.hypot(a[0]-b[0], a[1]-b[1]) < 0.5) pts = pts.slice(0, -1);
    }
    // simplify: drop points closer than 1.2m to the previous kept point
    const simp = [pts[0]];
    for (let i = 1; i < pts.length; i++) { const p = simp[simp.length-1], q = pts[i];
      if (Math.hypot(p[0]-q[0], p[1]-q[1]) > 1.2) simp.push(q); }
    if (simp.length < 3) { bDropped++; continue; }
    // area check — skip tiny slivers
    let area = 0; for (let i = 0; i < simp.length; i++) { const a = simp[i], b = simp[(i+1)%simp.length]; area += a[0]*b[1] - b[0]*a[1]; }
    if (Math.abs(area/2) < 25) { bDropped++; continue; }
    const h = parseHeight(tags);
    const rec = { p: simp.map(([x,z]) => [r1(x), r1(z)]), h: h ? r1(Math.max(4, h)) : 0 };
    if (tags.name) rec.n = tags.name;
    buildings.push(rec);
    continue;
  }

  if (tags.highway && driveable.has(tags.highway)) {
    const pts = el.geometry.map(n => [r1(px(n.lon)), r1(pz(n.lat))]);
    if (pts.length < 2) continue;
    roads.push({ p: pts, w: roadWidth[tags.highway] || 8, t: tags.highway, n: tags.name || '' });
  }
}

// align the street grid to the axes (downtown Dallas is rotated ~30°) so building AABBs are tight
const ah = new Array(90).fill(0);
for (const r of roads) { const p=r.p; for (let i=0;i<p.length-1;i++){ const dx=p[i+1][0]-p[i][0], dz=p[i+1][1]-p[i][1], len=Math.hypot(dx,dz); if(len<8)continue; let a=Math.atan2(dz,dx); a=((a%(Math.PI/2))+Math.PI/2)%(Math.PI/2); ah[Math.min(89,Math.floor(a/(Math.PI/2)*90))]+=len; } }
let peak=0; for(let i=0;i<90;i++) if(ah[i]>ah[peak]) peak=i;
const rot = -(peak/90)*(Math.PI/2), C=Math.cos(rot), S=Math.sin(rot);
const rp = ([x,z]) => [r1(x*C - z*S), r1(x*S + z*C)];
for (const b of buildings) b.p = b.p.map(rp);
for (const r of roads) r.p = r.p.map(rp);
for (let i=0;i<signals.length;i++) signals[i]=rp(signals[i]);
console.log('grid rotation applied (deg):', (rot*180/Math.PI).toFixed(1));

// bounds
let minX=1e9,maxX=-1e9,minZ=1e9,maxZ=-1e9;
for (const b of buildings) for (const [x,z] of b.p) { minX=Math.min(minX,x);maxX=Math.max(maxX,x);minZ=Math.min(minZ,z);maxZ=Math.max(maxZ,z); }

const out = { center:[lat0,lon0], bounds:[r1(minX),r1(maxX),r1(minZ),r1(maxZ)], buildings, roads, signals };
fs.writeFileSync('/Users/joelcomm/driver/dallas.data.js', 'window.DALLAS_DATA=' + JSON.stringify(out) + ';');

const named2 = buildings.filter(b => b.n).map(b => b.n);
console.log('buildings:', buildings.length, 'dropped:', bDropped);
console.log('roads:', roads.length, 'signals:', signals.length);
console.log('bounds X:', out.bounds[0], out.bounds[1], ' Z:', out.bounds[2], out.bounds[3]);
console.log('named buildings sample:', [...new Set(named2)].slice(0, 25).join(' | '));
console.log('output KB:', Math.round(fs.statSync('/Users/joelcomm/driver/dallas.data.js').size/1024));

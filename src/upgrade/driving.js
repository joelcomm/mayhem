// Arcade traction is independent of body heading, allowing recoverable lateral slip.
export const HANDLING = {
  convert: { grip: 5.8, turn: 1.08, acceleration: 1 },
  sedan: { grip: 7.2, turn: 1, acceleration: .97 },
  wagon: { grip: 5.2, turn: .9, acceleration: .93 },
  compact: { grip: 9, turn: 1.18, acceleration: 1.08 },
  truck: { grip: 4.5, turn: .78, acceleration: .86 },
};
export function traction(vx, vz, heading, speed, handbrake, grip, dt) {
  const blend = 1 - Math.exp(-(handbrake ? 1.65 : grip) * dt);
  return { x: vx + (Math.sin(heading)*speed-vx)*blend,
    z: vz + (Math.cos(heading)*speed-vz)*blend };
}
export function boostStep(fuel, active, dt) {
  return Math.max(0, Math.min(100, fuel + (active ? -30 : 12)*dt));
}
export function routeThrough(nodes, edges, start, end) {
  if (!nodes[start] || !nodes[end]) return [];
  const dist = nodes.map(() => Infinity), prev = nodes.map(() => -1), done = new Set();
  dist[start] = 0;
  while (done.size < nodes.length) {
    let u = -1;
    for (let i=0;i<nodes.length;i++) if (!done.has(i) && (u<0 || dist[i]<dist[u])) u=i;
    if (u<0 || !Number.isFinite(dist[u]) || u===end) break;
    done.add(u);
    for (const i of nodes[u].e) {
      const e=edges[i], v=e.a===u?e.b:e.a, d=dist[u]+e.len;
      if (d<dist[v]) { dist[v]=d; prev[v]=u; }
    }
  }
  if (!Number.isFinite(dist[end])) return [];
  const path=[];
  for(let u=end;u!==-1;u=prev[u]) path.unshift(u);
  return path;
}

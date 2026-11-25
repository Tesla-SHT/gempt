import { tr } from "../magpie_plugin/ui/i18n.js";
import { activeAt, channelMentions, channelsAt, effectiveChannels, mentionsOf, ROLE_WORKER_RE } from "../core/swarm-channels.mjs";
import { createGifEncoder } from "./swarm-gif.js";

// Native Swarm Board pixel art, graph layout and Canvas renderer.
const HUE = new Map([["coordinator", 46]]);
function hsl2hex(h,s,l){ h=((h%360)+360)%360; s/=100; l/=100; const k=n=>(n+h/30)%12; const a=s*Math.min(l,1-l); const f=n=>l-a*Math.max(-1,Math.min(k(n)-3,Math.min(9-k(n),1))); return '#'+[f(0),f(8),f(4)].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join(''); }
const shiftHue=(h,target,amt)=>{ const d=((target-h+540)%360)-180; return h+d*amt; };
function ramp(n){ const h=hueOf(n); return {
  spec: hsl2hex(shiftHue(h,55,0.28), 96, 90), hi: hsl2hex(shiftHue(h,55,0.18), 90, 74), mid: hsl2hex(h, 78, 60),
  sh: hsl2hex(shiftHue(h,265,0.22), 58, 44), ol: hsl2hex(shiftHue(h,265,0.35), 42, 19),
  skh: hsl2hex(shiftHue(h,265,0.15), 20, 30), sk: hsl2hex(shiftHue(h,265,0.3), 24, 18), skd: hsl2hex(shiftHue(h,265,0.45), 32, 10) }; }
export const memberColor = n => hsl2hex(hueOf(n), 78, 60);
const hueOf = n => HUE.get(n) ?? [12,150,262,330,196,228,96,28,290,175,350,60][hash(String(n))%12];
const hash = s => [...s].reduce((a,c)=>(a*31+c.charCodeAt(0))>>>0, 7);
export function drawBee(cv, name, state = "working", frame = 0){
  const W=22,H=18; cv.width=W; cv.height=H; const c=cv.getContext('2d'); c.imageSmoothingEnabled=false; c.clearRect(0,0,W,H);
  const R=ramp(name), queen=name==='coordinator', asleep=['parked', 'waiting', 'stopped'].includes(state), landed=asleep || state==='landed' || state==='killed';
  if (state === 'killed') c.filter = 'grayscale(1) opacity(65%)';
  const P=(x,y,col)=>{ if(x<0||y<0||x>=W||y>=H) return; c.fillStyle=col; c.fillRect(x,y,1,1); };
  const cx=11, cy=10.5, rx=7.3, ry=4.8;
  const inside=(x,y)=>{ const nx=(x+0.5-cx)/rx, ny=(y+0.5-cy)/ry; return nx*nx+ny*ny<=1; };
  let L=[-0.42,-0.62,0.66]; const Ln=Math.hypot(...L); L=L.map(v=>v/Ln);
  const N4=[[1,0],[-1,0],[0,1],[0,-1]];
  const rows=(spec)=>{ const pts=[]; spec.forEach(([y,x0,x1])=>{ for(let x=x0;x<=x1;x++) pts.push([x,y]); }); return pts; };
  const drawWing=(pts, glint)=>{ const set=new Set(pts.map(p=>p.join(','))); pts.forEach(([x,y])=>{ const edge=N4.some(([dx,dy])=>!set.has((x+dx)+','+(y+dy))); P(x,y, edge?'rgba(140,160,192,0.9)':'rgba(255,255,255,0.72)'); });
    if(glint){ const tl=pts.filter(([x,y])=>!N4.some(([dx,dy])=>!set.has((x+dx)+','+(y+dy)))).sort((a,b)=>(a[1]-b[1])||(a[0]-b[0])); if(tl[0]) P(tl[0][0],tl[0][1],'#FFFFFF'); } };
  let back=null, front;
  if(landed){ front=rows([[5,14,17],[6,13,18]]); }
  else if(frame===0){ back=rows([[1,16,17],[2,16,18],[3,15,18],[4,15,17],[5,15,16]]); front=rows([[0,13,14],[1,12,15],[2,11,15],[3,11,14],[4,11,13],[5,11,12]]); }
  else { back=rows([[3,16,18],[4,15,19],[5,16,18]]); front=rows([[3,13,16],[4,12,17],[5,12,17],[6,13,15]]); }
  if(back) drawWing(back,false);
  const stripe=(x,y)=>{ const ny=(y+0.5-cy)/ry; const u=x+0.5+1.15*ny*ny; return (u>10.6&&u<12.5)||(u>14.3&&u<16.1)||(u>17.9); };
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    if(!inside(x,y)) continue;
    const nx=(x+0.5-cx)/rx, ny=(y+0.5-cy)/ry, rr=Math.min(1,nx*nx+ny*ny), nz=Math.sqrt(1-rr);
    const I=nx*L[0]+ny*L[1]+nz*L[2];
    P(x,y, stripe(x,y) ? (I>0.80?R.skh : I>0.30?R.sk : R.skd) : (I>0.965?R.spec : I>0.78?R.hi : I>0.26?R.mid : R.sh));
  }
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    if(inside(x,y)) continue;
    const nbs=N4.filter(([dx,dy])=>inside(x+dx,y+dy)); if(!nbs.length) continue;
    const nx=(x+0.5-cx)/rx, ny=(y+0.5-cy)/ry, n=Math.hypot(nx,ny); const d=(nx/n)*L[0]+(ny/n)*L[1];
    const nextToStripe=nbs.some(([dx,dy])=>stripe(x+dx,y+dy));
    P(x,y, (d>0.5 && !nextToStripe) ? R.sh : R.ol);
  }
  // stinger
  P(19,10,R.ol); P(20,10,R.ol);
  // face
  if(asleep){ P(6,10,R.ol); P(7,10,R.ol); }
  else { P(6,9,'#FFFFFF'); P(7,9,R.skd); P(6,10,R.skd); P(7,10,R.skd); }
  P(5,11,'rgba(255,128,150,0.55)'); P(4,11,'rgba(255,128,150,0.35)');
  // antennae or crown
  if(queen){ const g1='#F7CE5B', g2='#FFE9A6', g3='#C98A2B'; [[5,5],[6,5],[7,5],[8,5],[9,5]].forEach(([x,y])=>P(x,y,g1)); P(5,4,g2); P(7,4,g2); P(9,4,g2); P(7,3,g2); P(5,5,g3); P(9,5,g3); P(7,5,'#E4566A'); }
  else { [[7,5],[6,4],[5,3]].forEach(([x,y])=>P(x,y,R.ol)); P(4,3,R.sk); [[9,5],[9,4],[9,3]].forEach(([x,y])=>P(x,y,R.ol)); P(8,2,R.sk); }
  drawWing(front,true);
  if(asleep){ const z='#8C90A6'; [[0,0],[1,0],[2,0],[3,0],[2,1],[1,2],[0,3],[1,3],[2,3],[3,3]].forEach(([x,y])=>P(x,y,z)); }
}
// Cache each rendered 22x18 bee frame once in an offscreen canvas and blit via
// drawImage instead of re-running the per-pixel fillRect loops on every render.
const spriteCanvases = new Map();
function beeCanvas(n, st, frame){
  const k = `${n}\0${st||''}\0${frame}`;
  let cv = spriteCanvases.get(k);
  if(!cv){
    if(spriteCanvases.size > 1024) spriteCanvases.clear();
    cv = document.createElement('canvas');
    drawBee(cv, n, st, frame);
    spriteCanvases.set(k, cv);
  }
  return cv;
}

const pillWidth = (id, maxW) => {
  const full = Math.max(72, 54 + Math.ceil(String(id).length * 6.8));
  return id === 'coordinator' ? full : Math.min(maxW, full);
};

function layout(nodes, width) {
  // Up to ~16 nodes: an ellipse with the coordinator at the top, so worker-to-worker
  // edges are chords rather than running through neighbours. Bigger swarms wrap in rows.
  const nodeH = 28;
  if (nodes.length <= 16) {
    const pos = new Map();
    const n = nodes.length;
    const w = Math.min(162, Math.max(116, width / Math.max(4, Math.ceil(n / 2) + 1) - 10));
    const rx = Math.max(60, width / 2 - w / 2 - 14);
    const ry = n <= 2 ? 60 : Math.min(220, Math.max(110, n * 20));
    const cx = width / 2, cy = ry + nodeH / 2 + 20;
    nodes.forEach((node, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
      pos.set(node.id, { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), w: pillWidth(node.id, w), h: nodeH });
    });
    return { pos, height: cy + ry + nodeH / 2 + 20 };
  }
  // Coordinator row on top, workers below (wrapping), outsiders last.
  const rows = new Map();
  for (const n of nodes) {
    if (!rows.has(n.row)) rows.set(n.row, []);
    rows.get(n.row).push(n);
  }
  const pos = new Map();
  const minNodeW = 114, lineH = 64, rowGap = 40;
  const perLine = Math.max(1, Math.floor(width / (minNodeW + 12)));
  let y = 32;
  for (const [, list] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    for (let i = 0; i < list.length; i += perLine) {
      const line = list.slice(i, i + perLine);
      const gap = width / (line.length + 1);
      const w = Math.min(158, Math.max(minNodeW, gap - 12));
      // Stagger alternate nodes on wide lines so edges between neighbours stay visible.
      line.forEach((n, j) => pos.set(n.id, { x: gap * (j + 1), y: y + (line.length > 3 && j % 2 ? 14 : 0), w: pillWidth(n.id, Math.min(w, gap - 8)), h: nodeH }));
      y += lineH;
    }
    y += rowGap;
  }
  return { pos, height: y - rowGap + 14 };
}
function edgeGeom(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len, bend = 24;
  const mx = (a.x + b.x) / 2 + nx * bend, my = (a.y + b.y) / 2 + ny * bend;
  // Trim ends at the box border (plus a small gap) so arrowheads stay visible.
  const trim = (p, q) => {
    const tx = q.x - p.x, ty = q.y - p.y, l = Math.hypot(tx, ty) || 1;
    const ux = tx / l, uy = ty / l;
    const toBorder = Math.min(ux ? p.w / 2 / Math.abs(ux) : Infinity, uy ? p.h / 2 / Math.abs(uy) : Infinity);
    const t = Math.min(0.45 * l, toBorder + 4);
    return { x: p.x + ux * t, y: p.y + uy * t };
  };
  const s1 = trim(a, { x: mx, y: my }), e1 = trim(b, { x: mx, y: my });
  return { d: `M${s1.x},${s1.y} Q${mx},${my} ${e1.x},${e1.y}`, start: s1, mx, my, end: e1 };
}

// Incrementally accumulates graph edges and activity across prefixes of `all`
// messages in O(N) total time. Shared between live SVG rendering and streaming
// GIF export so both stay in sync.
function createGraphAccumulator(s, all, { expandAll, hideInactive, width }) {
  const roster = s.members || [];
  const memberNames = new Set(roster.map((m) => m.name));
  const outsiders = [...new Set(all.map((m) => m.agent))].filter((n) => !memberNames.has(n) && !isRoleWorker(n, roster));
  // Role-worker nodes are left out, which also drops every edge to or from
  // them (edges need both ends placed).
  const allNodes = [
    ...roster.filter((m) => !isRoleWorker(m, roster)).map((m) => ({ id: m.name, row: m.role === 'coordinator' ? 0 : 1, m })),
    ...outsiders.map((n) => ({ id: n, row: 2, m: null })),
  ];
  const isKilled = (n) => Boolean(n.m?.killed || n.m?.status === 'killed');

  // While replaying, members light up the first time they post or are called on.
  const active = new Set(['coordinator']);
  const edges = new Map();        // "from>to" -> {direct, viaAll}
  const unaddressed = new Map();  // poster -> posts calling on nobody
  const broadcasts = new Map();   // poster -> @all posts (badged when not expanded)
  const bump = (k, field) => { const e = edges.get(k) || { direct: 0, viaAll: 0 }; e[field]++; edges.set(k, e); };
  let cursor = 0;

  // Cache layout by visible node key so consecutive steps with the same node
  // set skip recomputing node positions.
  let cachedLayoutKey = null;
  let cachedLayout = null;
  const layoutFor = (nodes) => {
    const key = hideInactive ? nodes.map((n) => n.id).join('\0') : '*';
    if (key !== cachedLayoutKey) {
      cachedLayoutKey = key;
      cachedLayout = layout(nodes, width);
    }
    return cachedLayout;
  };

  const advanceTo = (upto) => {
    const target = Math.max(cursor, Math.min(upto, all.length));
    for (; cursor < target; cursor++) {
      const m = all[cursor];
      if (isRoleWorker(m.agent, roster)) continue;
      active.add(m.agent);
      const { direct, viaAll } = targetsOf(m, expandAll, roster);
      if (m.all) broadcasts.set(m.agent, (broadcasts.get(m.agent) || 0) + 1);
      if (!direct.size && !viaAll.size && !m.all && !m.channel_mentions.length && !(m.mentions || []).some((n) => n !== m.agent))
        unaddressed.set(m.agent, (unaddressed.get(m.agent) || 0) + 1);
      for (const t of direct) {
        active.add(t);
        bump(`${m.agent}>${t}`, 'direct');
      }
      for (const t of viaAll) {
        if (m.viaChannel.includes(t) || !hideInactive) active.add(t);
        bump(`${m.agent}>${t}`, 'viaAll');
      }
    }
  };

  const snapshot = ({ replaying }) => {
    const current = replaying && cursor > 0 ? all[cursor - 1] : null;
    const currentDirect = current && !isRoleWorker(current.agent, roster)
      ? new Set([current.agent, ...targetsOf(current, false, roster).direct])
      : new Set();
    const nodes = hideInactive
      ? allNodes.filter((n) => currentDirect.has(n.id) || (active.has(n.id) && !isKilled(n)))
      : allNodes;
    const { pos, height } = layoutFor(nodes);

    const isActive = (id) => !replaying || active.has(id);
    let curTargets = new Set();
    if (current) {
      const { direct, viaAll } = targetsOf(current, expandAll, roster);
      curTargets = new Set([...direct, ...viaAll]);
    }
    const isCur = (from, to) => !!current && from === current.agent && curTargets.has(to);

    let max = 1;
    for (const [k, e] of edges) {
      const [from, to] = k.split('>');
      if (pos.has(from) && pos.has(to)) {
        const total = e.direct + e.viaAll;
        if (total > max) max = total;
      }
    }

    return {
      nodes, pos, height, edges, unaddressed, broadcasts,
      current, curTargets, max, isActive, isCur, replaying, upto: cursor,
    };
  };

  return { advanceTo, snapshot };
}

function resolveGraphTheme() {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  document.documentElement.appendChild(probe);
  const read = (expr, fallback) => {
    probe.style.color = '';
    probe.style.color = expr;
    return getComputedStyle(probe).color || fallback;
  };
  const fallbackFont = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  probe.style.fontFamily = `var(--font, ${fallbackFont})`;
  const computedFont = getComputedStyle(probe).fontFamily;
  const font = computedFont && !computedFont.includes('var(') ? computedFont : fallbackFont;
  const theme = {
    bg: read('var(--bg, #f7f7f8)', '#f7f7f8'),
    fg: read('var(--fg, #1d1f21)', '#1d1f21'),
    fg2: read('var(--fg, #3d4348)', '#3d4348'),
    muted: read('var(--muted-ink, #5d676f)', '#5d676f'),
    faint: read('var(--muted-ink, #9da5ab)', '#9da5ab'),
    fill: read('var(--surface, rgba(29,31,33,0.06))', 'rgba(29,31,33,0.06)'),
    line: read('var(--line, rgba(29,31,33,0.08))', 'rgba(29,31,33,0.08)'),
    track: read('color-mix(in srgb, var(--fg, #1d1f21) 12%, transparent)', 'rgba(29,31,33,0.12)'),
    success: read('var(--ok, #63984f)', '#63984f'),
    nodeBorder: read('color-mix(in srgb, var(--fg, #1d1f21) 22%, transparent)', 'rgba(29,31,33,0.22)'),
    ringStroke: read('color-mix(in srgb, var(--fg, #1d1f21) 30%, transparent)', 'rgba(29,31,33,0.30)'),
    bcastBorder: read('color-mix(in srgb, var(--fg, #1d1f21) 18%, transparent)', 'rgba(29,31,33,0.18)'),
    arrow: read('color-mix(in srgb, var(--fg, #1d1f21) 45%, transparent)', 'rgba(29,31,33,0.45)'),
    font,
  };
  probe.remove();
  return theme;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function fitCanvasText(ctx, text, maxW) {
  const s = String(text || '');
  if (maxW <= 0) return '';
  if (ctx.measureText(s).width <= maxW) return s;
  const ell = '…';
  const ellW = ctx.measureText(ell).width;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (ctx.measureText(s.slice(0, mid)).width + ellW <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? s.slice(0, lo) + ell : '';
}

function drawGraphFrame(ctx, {
  width, height, headerH, footerH, graphOffsetY, scale,
  theme, title, g, roster, expandAll, totalPosts, memberCount,
  dotT, stepLabel, isOverview,
}) {
  ctx.save();
  ctx.scale(scale, scale);

  // Solid themed background.
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);

  // Header bar: swarm title + step counter.
  const padX = 16;
  ctx.font = `500 11px ${theme.font}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillStyle = theme.muted;
  const stepW = ctx.measureText(stepLabel).width;
  ctx.fillText(stepLabel, width - padX, headerH / 2);

  ctx.font = `600 13px ${theme.font}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = theme.fg;
  const maxTitleW = Math.max(40, width - padX * 2 - stepW - 14);
  ctx.fillText(fitCanvasText(ctx, title, maxTitleW), padX, headerH / 2);

  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, headerH - 0.5);
  ctx.lineTo(width, headerH - 0.5);
  ctx.stroke();

  // Graph area.
  ctx.save();
  ctx.translate(0, graphOffsetY);
  const { nodes, pos, edges, unaddressed, broadcasts, current, curTargets, max, isActive, isCur, replaying } = g;

  // 1. Edges + arrowheads (and collect edge counts & travelling dots).
  const countLabels = [];
  const movingDots = [];
  for (const [k, e] of edges) {
    const [from, to] = k.split('>');
    const a = pos.get(from), b = pos.get(to);
    if (!a || !b) continue;
    const n = e.direct + e.viaAll;
    const geom = edgeGeom(a, b);
    const w = 1 + (3 * n) / max;
    const cur = isCur(from, to);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(geom.start.x, geom.start.y);
    ctx.quadraticCurveTo(geom.mx, geom.my, geom.end.x, geom.end.y);
    ctx.strokeStyle = theme.fg;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    if (!e.direct) ctx.setLineDash([4, 4]);
    ctx.globalAlpha = cur ? 0.85 : (replaying ? 0.12 : (e.direct ? 0.28 : 0.18));
    ctx.stroke();
    ctx.restore();

    // Arrowhead matching <marker id="arrow">.
    const ang = Math.atan2(geom.end.y - geom.my, geom.end.x - geom.mx);
    ctx.save();
    ctx.translate(geom.end.x, geom.end.y);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(-6, -3.04);
    ctx.lineTo(0.4, 0);
    ctx.lineTo(-6, 3.04);
    ctx.quadraticCurveTo(-4.72, 0, -6, -3.04);
    ctx.closePath();
    if (cur) {
      ctx.fillStyle = theme.fg;
      ctx.globalAlpha = 0.85;
    } else {
      ctx.fillStyle = theme.arrow;
      ctx.globalAlpha = replaying ? 0.4 : 1;
    }
    ctx.fill();
    ctx.restore();

    if (n > 1) countLabels.push({ x: geom.mx, y: geom.my, text: String(n) });
    if (cur && dotT !== null) movingDots.push(geom);
  }

  // 2. Nodes.
  for (const n of nodes) {
    const p = pos.get(n.id);
    const status = n.m?.status || '';
    const beeX = p.x - p.w / 2 + 8;
    const dotX = beeX + 22;
    const labelX = beeX + 28;
    const maxChars = Math.max(4, Math.floor((p.x + p.w / 2 - 10 - labelX) / 6.8));
    const label = n.id.length > maxChars ? n.id.slice(0, maxChars - 1) + '…' : n.id;
    const hot = !!current && (n.id === current.agent || curTargets.has(n.id));
    const ring = unaddressed.get(n.id);
    const bcast = expandAll ? 0 : broadcasts.get(n.id) || 0;
    const killed = status === 'killed';
    const outsider = !n.m;

    ctx.save();
    if (!isActive(n.id)) ctx.globalAlpha = 0.2;

    if (ring) {
      ctx.save();
      roundRectPath(ctx, p.x - p.w / 2 - 4, p.y - p.h / 2 - 4, p.w + 8, p.h + 8, p.h / 2 + 4);
      ctx.strokeStyle = theme.ringStroke;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2.5]);
      ctx.stroke();
      ctx.restore();
    }

    roundRectPath(ctx, p.x - p.w / 2, p.y - p.h / 2, p.w, p.h, p.h / 2);
    ctx.fillStyle = theme.bg;
    ctx.fill();
    if (hot) {
      ctx.fillStyle = theme.fill;
      ctx.fill();
    }
    ctx.save();
    ctx.strokeStyle = hot ? theme.fg : theme.nodeBorder;
    ctx.lineWidth = hot ? 1.5 : 1;
    if (outsider) ctx.setLineDash([3, 2]);
    else if (killed) ctx.setLineDash([2, 2]);
    ctx.stroke();
    ctx.restore();

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(beeCanvas(n.id, status, 0), beeX, p.y - 9);
    if (status) {
      ctx.beginPath();
      ctx.arc(dotX, p.y - 7, 3.25, 0, Math.PI * 2);
      if (status === 'working' || status === 'waiting_reply') {
        ctx.fillStyle = theme.success;
        ctx.fill();
      } else if (status === 'waiting' || status === 'stopped') {
        ctx.strokeStyle = theme.faint;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (status === 'killed') {
        ctx.fillStyle = theme.faint;
        ctx.fill();
      }
    }

    ctx.font = `500 12px ${theme.font}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = killed ? theme.muted : theme.fg;
    ctx.fillText(label, labelX, p.y + 0.5);
    if (killed) {
      const tw = ctx.measureText(label).width;
      ctx.strokeStyle = theme.muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(labelX, p.y + 0.5);
      ctx.lineTo(labelX + tw, p.y + 0.5);
      ctx.stroke();
    }

    if (bcast) {
      const bw = 30 + 6 * String(bcast).length;
      const bx = p.x + p.w / 2 - bw + 6;
      const by = p.y - p.h / 2 - 16;
      roundRectPath(ctx, bx, by, bw, 14, 7);
      ctx.fillStyle = theme.bg;
      ctx.fill();
      ctx.strokeStyle = theme.bcastBorder;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.font = `600 9px ${theme.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = theme.muted;
      ctx.fillText(`@all ${bcast}`, bx + bw / 2, by + 7.5);
    }

    ctx.restore();
  }

  // 3. Edge counts with background halo.
  if (countLabels.length) {
    ctx.font = `500 10px ${theme.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = theme.bg;
    ctx.fillStyle = theme.muted;
    for (const c of countLabels) {
      ctx.strokeText(c.text, c.x, c.y + 0.5);
      ctx.fillText(c.text, c.x, c.y + 0.5);
    }
  }

  // 4. Travelling message dots along current edges.
  for (const geom of movingDots) {
    const t = dotT;
    const u = 1 - t;
    const dx = u * u * geom.start.x + 2 * u * t * geom.mx + t * t * geom.end.x;
    const dy = u * u * geom.start.y + 2 * u * t * geom.my + t * t * geom.end.y;
    if (t < 1) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(dx, dy, 7.5, 0, Math.PI * 2);
      ctx.fillStyle = theme.fg;
      ctx.globalAlpha = 0.16;
      ctx.fill();
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(dx, dy, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = theme.fg;
    ctx.fill();
    ctx.strokeStyle = theme.bg;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();

  // Footer bar: progress strip + single-line post caption.
  const footY = height - footerH;
  const pct = totalPosts > 0 ? Math.min(1, g.upto / totalPosts) : (isOverview ? 1 : 0);
  ctx.fillStyle = theme.track;
  ctx.fillRect(0, footY, width, 2);
  if (pct > 0) {
    ctx.fillStyle = theme.fg2;
    ctx.fillRect(0, footY, Math.round(width * pct), 2);
  }

  const capY = footY + 2 + (footerH - 2) / 2;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let x = padX;
  const maxRight = width - padX;
  if (current) {
    const sender = `@${current.agent}`;
    ctx.font = `600 11.5px ${theme.font}`;
    ctx.fillStyle = theme.fg;
    ctx.fillText(sender, x, capY);
    x += ctx.measureText(sender).width;

    const recips = formatGifRecipients(current, roster);
    const snippet = snippetOfPost(current);
    const rest = [recips ? ` → ${recips}` : '', snippet ? ` · ${snippet}` : ''].join('');
    if (rest && x < maxRight - 10) {
      ctx.font = `400 11.5px ${theme.font}`;
      ctx.fillStyle = theme.muted;
      ctx.fillText(fitCanvasText(ctx, rest, maxRight - x), x, capY);
    }
  } else if (isOverview) {
    ctx.font = `400 11.5px ${theme.font}`;
    ctx.fillStyle = theme.muted;
    const summary = tr("{0} 条消息 · {1} 位成员", totalPosts, memberCount);
    ctx.fillText(fitCanvasText(ctx, summary, maxRight - x), x, capY);
  } else {
    ctx.font = `400 11.5px ${theme.font}`;
    ctx.fillStyle = theme.muted;
    ctx.fillText(fitCanvasText(ctx, tr("开始 · {0} 位成员", memberCount), maxRight - x), x, capY);
  }

  ctx.restore();
}

function gifFilename(title) {
  const slug = String(title || 'swarm')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${slug || 'swarm'}-graph.gif`;
}

// Resolve recipients at the post's sequence, including historical subscriptions.
export function graphSnapshot(overview, board) {
  const members = [{ name: "coordinator", role: "coordinator", status: "working" },
    ...(overview.roster || []).filter(w => w.name !== "coordinator").map(w => ({ ...w, status: w.state }))];
  const names = members.map(w => w.name);
  const active = activeAt(overview.channels, board);
  const subscriptions = members.map(w => channelsAt(w.name, w.channels, board));
  const messages = [];
  board.forEach((post, i) => {
    if (post.control) return;
    const direct = mentionsOf(post.text, names);
    const channels = post.channel_mentions || channelMentions(post.text);
    const viaChannel = members.filter((w, j) => {
      const set = effectiveChannels(w.role, subscriptions[j][i], w.name);
      return channels.some(c => c !== "main" && active[i]?.(c) && (set.includes("*") || set.includes(c)));
    }).map(w => w.name);
    messages.push({ ...post, agent: post.from_agent, mentions: direct.mentions, all: direct.all, channel_mentions: channels, viaChannel });
  });
  return { members, messages, title: overview.swarm.title || overview.swarm.id };
}

function isRoleWorker(member, roster) {
  const m = typeof member === "string" ? roster.find(w => w.name === member) : member;
  return ["monitor", "narrator"].includes(m?.role) || ROLE_WORKER_RE.test(m?.name || member);
}

function targetsOf(m, expandAll, roster) {
  const direct = new Set(m.mentions.filter(n => n !== m.agent));
  const viaAll = new Set(m.viaChannel);
  if (expandAll && m.all) for (const w of roster) viaAll.add(w.name);
  viaAll.delete(m.agent);
  for (const name of direct) viaAll.delete(name);
  return { direct, viaAll };
}

function formatGifRecipients(m) {
  return [...m.mentions.map(n => "@" + n), ...m.channel_mentions.map(c => "@#" + c), ...(m.all ? ["@all"] : [])].join(" ");
}
function snippetOfPost(message) {
  const text = String(message.text || "").replace(/\s+/g, " ").trim();
  if (!message.all && !message.mentions.length && !message.channel_mentions.length) return text;
  return text.replace(/^(?:\s*@#?[a-z0-9_-]+[,:]?)+\s*/i, "").trim() || text;
}

const urls = new Map();
export function beeDataUrl(name, state = "landed", frame = 0) {
  const key = JSON.stringify([name, state, frame]);
  if (!urls.has(key)) {
    if (urls.size >= 1024) urls.clear();
    urls.set(key, beeCanvas(name, state, frame).toDataURL());
  }
  return urls.get(key);
}

export function createBeeAvatar(name, state = "working") {
  const tile = document.createElement("span");
  tile.className = "swarm-bee";
  tile.style.setProperty("--bee-color", memberColor(name));
  tile.setAttribute("aria-hidden", "true");
  const frames = ["working", "waiting_reply"].includes(state) ? 2 : 1;
  for (let i = 0; i < frames; i++) {
    const img = document.createElement("img");
    img.src = beeDataUrl(name, state, i);
    img.alt = "";
    tile.append(img);
  }
  return tile;
}

const NS = "http://www.w3.org/2000/svg";
function svgNode(tag, attrs = {}, content) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (content != null) el.textContent = content;
  return el;
}

const graphViews = new WeakMap();
export function renderMentions(svg, snapshot, { step, expandAll, hideInactive }) {
  const width = Math.max(340, svg.clientWidth);
  const upto = step ?? snapshot.messages.length;
  const key = [width, expandAll, hideInactive].join("/");
  let view = graphViews.get(svg);
  if (!view || view.snapshot !== snapshot || view.key !== key || upto < view.upto) {
    view = { snapshot, key, acc: createGraphAccumulator(snapshot, snapshot.messages, { expandAll, hideInactive, width }) };
    graphViews.set(svg, view);
  }
  view.acc.advanceTo(upto);
  view.upto = upto;
  const g = view.acc.snapshot({ replaying: step != null });
  svg.setAttribute("viewBox", `0 0 ${width} ${g.height}`);
  const defs = svgNode("defs");
  const marker = svgNode("marker", { id: "swarm-edge-arrow", viewBox: "0 0 10 10", refX: 8.5, refY: 5, markerUnits: "userSpaceOnUse", markerWidth: 8, markerHeight: 8, orient: "auto" });
  marker.append(svgNode("path", { d: "M1 1.2L9 5 1 8.8Q2.6 5 1 1.2Z", fill: "var(--muted-ink)" }));
  defs.append(marker);
  const layers = Array.from({ length: 4 }, () => svgNode("g"));
  for (const [key, e] of g.edges) {
    const [from, to] = key.split(">");
    if (!g.pos.has(from) || !g.pos.has(to)) continue;
    const p = edgeGeom(g.pos.get(from), g.pos.get(to));
    const count = e.direct + e.viaAll;
    const current = g.isCur(from, to);
    const edge = svgNode("path", { d: p.d, class: "sw-arc" + (current ? " current" : ""), "stroke-width": 1 + 3 * count / g.max,
      "stroke-dasharray": e.direct ? "none" : "4 4", "marker-end": "url(#swarm-edge-arrow)" });
    edge.append(svgNode("title", {}, tr("{0} → {1} · {2} 条消息", from, to, count)));
    layers[0].append(edge);
    if (count > 1) {
      const w = 10 + String(count).length * 7;
      const x = (p.start.x + 2*p.mx + p.end.x)/4, y = (p.start.y + 2*p.my + p.end.y)/4;
      layers[2].append(svgNode("rect", { x: x-w/2, y: y-7, width: w, height: 14, rx: 7, class: "sw-count-box" }), svgNode("text", { x, y: y+3, class: "sw-count" }, count));
    }
    if (current) {
      const dot = svgNode("circle", { r: 4, class: "sw-moving-dot" });
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
        dot.setAttribute("cx", p.end.x); dot.setAttribute("cy", p.end.y);
      } else dot.append(svgNode("animateMotion", { path: p.d, dur: "0.9s", begin: "indefinite", fill: "freeze" }));
      layers[3].append(dot);
    }
  }
  for (const n of g.nodes) {
    const p = g.pos.get(n.id), x = p.x-p.w/2, y = p.y-p.h/2, status = n.m?.status || "landed";
    const group = svgNode("g", { opacity: g.isActive(n.id) ? 1 : .35 });
    group.append(svgNode("title", {}, [n.id, n.m?.model, n.m?.role].filter(Boolean).join(" · ")));
    if (g.unaddressed.has(n.id)) group.append(svgNode("rect", { x:x-4, y:y-4, width:p.w+8, height:p.h+8, rx:18, class:"sw-unaddressed" }));
    group.append(svgNode("rect", { x,y,width:p.w,height:p.h,rx:14,class:"sw-node-box" }),
      svgNode("image", { href:beeDataUrl(n.id,status),x:x+7,y:y+5,width:22,height:18 }),
      svgNode("circle", { cx:x+29,cy:y+7,r:3,class:"sw-status-dot", "data-state":status }));
    const max = Math.max(4, Math.floor((p.w - 43) / 6.8));
    group.append(svgNode("text", {x:x+35,y:p.y+4,class:"sw-name"}, n.id.length > max ? n.id.slice(0,max-1)+"…" : n.id));
    const bcast = !expandAll && g.broadcasts.get(n.id);
    if (bcast) {
      const w = 30 + 6*String(bcast).length;
      group.append(svgNode("rect",{x:x+p.w-w+6,y:y-16,width:w,height:14,rx:7,class:"sw-count-box"}),
        svgNode("text",{x:x+p.w-w/2+6,y:y-6,class:"sw-count"}, "@all "+bcast));
    }
    layers[1].append(group);
  }
  svg.replaceChildren(defs,...layers);
  for (const animation of svg.querySelectorAll("animateMotion")) animation.beginElement?.();
}

export function replayDelay(posts, step, real, speed) {
  const elapsed = Date.parse(posts[step]?.created_at) - Date.parse(posts[step-1]?.created_at);
  return (real && Number.isFinite(elapsed) ? Math.max(250, Math.min(4000, elapsed)) : 900) / speed;
}

export async function exportGraphGif(snap, { width = 640, expandAll = false, hideInactive = false,
  real = false, speed = 1, onProgress } = {}) {
  const roster = snap.members;
  const all = snap.messages.filter(m => !isRoleWorker(m.agent, roster));
  const logicalW = Math.min(720, Math.max(520, width));
  const { title } = snap;
  const filename = gifFilename(title);
  const theme = resolveGraphTheme();
  const graphOpts = { expandAll, hideInactive, width: logicalW };
  // Cap sampled replay steps on huge swarms so the GIF stays watchable and
  // encodes quickly while preserving the full start-to-finish arc.
  const MAX_REPLAY_STEPS = 200;
  const stepKs = [];
  if (all.length <= MAX_REPLAY_STEPS) {
    for (let k = 1; k <= all.length; k++) stepKs.push(k);
  } else {
    for (let i = 0; i < MAX_REPLAY_STEPS; i++) {
      const k = Math.max(1, Math.min(all.length, Math.round(1 + (i * (all.length - 1)) / (MAX_REPLAY_STEPS - 1))));
      if (stepKs[stepKs.length - 1] !== k) stepKs.push(k);
    }
  }

  // Adaptive dot sub-frames keep small replays silky and large swarms fast.
  const dotTs = all.length <= 25 ? [0.08, 0.30, 0.56, 0.80, 1.0] :
                all.length <= 60 ? [0.18, 0.58, 1.0] :
                all.length <= 150 ? [0.45, 1.0] : [1.0];

  // Single O(N) planning pass: find max canvas height across steps (Hide
  // inactive can grow the node count) and build lightweight frame descriptors.
  const planAcc = createGraphAccumulator(snap, all, graphOpts);
  const plan = [];
  let maxGraphH = 0;
  const memberCount = roster.filter((m) => !isRoleWorker(m, roster)).length;

  if (all.length === 0) {
    const overview = planAcc.snapshot({ replaying: false });
    if (overview.nodes.length === 0) {
      throw new Error(tr("暂无可导出的消息"));
    }
    maxGraphH = overview.height;
    plan.push({ k: 0, isOverview: true, dotT: null, stepLabel: tr("总览"), delayMs: 1000 });
  } else {
    const startSnap = planAcc.snapshot({ replaying: true });
    maxGraphH = startSnap.height;
    plan.push({
      k: 0,
      isOverview: false,
      dotT: null,
      stepLabel: `0 / ${all.length}`,
      delayMs: Math.round(Math.min(800, Math.max(220, 600 / speed))),
    });

    for (let idx = 0; idx < stepKs.length; idx++) {
      const k = stepKs[idx];
      planAcc.advanceTo(k);
      const g = planAcc.snapshot({ replaying: true });
      if (g.height > maxGraphH) maxGraphH = g.height;
      const cur = g.current;
      const rawDelay = replayDelay(all, k, real, speed);
      const postMs = Math.round(Math.min(2200, Math.max(240, rawDelay)));
      const stepLabel = `${k} / ${all.length} · #${cur.seq}`;
      let hasCurEdge = false;
      if (dotTs.length > 1) {
        for (const [key] of g.edges) {
          const [from, to] = key.split('>');
          if (g.isCur(from, to) && g.pos.has(from) && g.pos.has(to)) {
            hasCurEdge = true;
            break;
          }
        }
      }
      if (hasCurEdge) {
        const travelTotal = Math.min(Math.round(postMs * 0.58), 520);
        const subDelay = Math.max(60, Math.round(travelTotal / (dotTs.length - 1)));
        for (let i = 0; i < dotTs.length - 1; i++) {
          plan.push({ k, isOverview: false, dotT: dotTs[i], stepLabel, delayMs: subDelay });
        }
        const holdDelay = Math.max(140, postMs - subDelay * (dotTs.length - 1));
        plan.push({ k, isOverview: false, dotT: 1.0, stepLabel, delayMs: holdDelay });
      } else {
        plan.push({ k, isOverview: false, dotT: 1.0, stepLabel, delayMs: postMs });
      }
    }

    planAcc.advanceTo(all.length);
    const overview = planAcc.snapshot({ replaying: false });
    if (overview.height > maxGraphH) maxGraphH = overview.height;
    plan.push({
      k: all.length,
      isOverview: true,
      dotT: null,
      stepLabel: tr("总览"),
      delayMs: Math.round(Math.min(2000, Math.max(900, 1800 / Math.min(speed, 2)))),
    });
  }

  const headerH = 36;
  const footerH = 34;
  const padY = 8;
  const logicalH = Math.ceil(headerH + padY * 2 + maxGraphH + footerH);
  // Cap total canvas height for very large swarms so encoding stays fast.
  const scale = logicalH > 900 ? 900 / logicalH : 1;
  const canvasW = Math.max(1, Math.round(logicalW * scale));
  const canvasH = Math.max(1, Math.round(logicalH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable');



  const renderDescriptor = (f, g) => {
    drawGraphFrame(ctx, {
      width: logicalW,
      height: logicalH,
      headerH,
      footerH,
      graphOffsetY: headerH + padY + (maxGraphH - g.height) / 2,
      scale,
      theme,
      title,
      g,
      roster,
      expandAll,
      totalPosts: all.length,
      memberCount,
      dotT: f.dotT,
      stepLabel: f.stepLabel,
      isOverview: f.isOverview,
    });
    return ctx.getImageData(0, 0, canvasW, canvasH).data;
  };

  // Pass 1: build the global palette from at most 10 evenly spaced sample
  // frames (always including start, an active travelling-dot frame if any,
  // and the final Overview), then drop the sample buffers before streaming.
  const sampleIdxSet = new Set([0, plan.length - 1]);
  const movingIdx = plan.findIndex((f) => f.dotT !== null && f.dotT < 1);
  if (movingIdx >= 0) sampleIdxSet.add(movingIdx);
  const sampleCap = Math.min(plan.length, 10);
  for (let i = 1; i < sampleCap - 1; i++) {
    sampleIdxSet.add(Math.round((i * (plan.length - 1)) / (sampleCap - 1)));
  }
  const sampleIndices = [...sampleIdxSet].sort((a, b) => a - b);
  const sampleAcc = createGraphAccumulator(snap, all, graphOpts);
  const sampleFrames = [];
  for (const idx of sampleIndices) {
    const f = plan[idx];
    sampleAcc.advanceTo(f.k);
    const g = sampleAcc.snapshot({ replaying: !f.isOverview });
    sampleFrames.push(new Uint8Array(renderDescriptor(f, g)));
  }

  const enc = createGifEncoder({
    width: canvasW,
    height: canvasH,
    sampleFrames,
    repeat: 0,
    useDelta: plan.length > 1,
  });

  let bytes;
  if (plan.length === 1) {
    enc.addFrame(sampleFrames[0], plan[0].delayMs);
    sampleFrames.length = 0;
    bytes = enc.finish();
  } else {
    sampleFrames.length = 0;
    // Pass 2: stream render + LZW encode one frame at a time (O(1) RGBA RAM)
    // and yield to the event loop every ~16ms so the UI stays responsive.
    const streamAcc = createGraphAccumulator(snap, all, graphOpts);
    let curK = -1;
    let curOverview = null;
    let curG = null;
    let lastYield = performance.now();

    for (let i = 0; i < plan.length; i++) {
      const f = plan[i];
      if (f.k !== curK || f.isOverview !== curOverview) {
        streamAcc.advanceTo(f.k);
        curG = streamAcc.snapshot({ replaying: !f.isOverview });
        curK = f.k;
        curOverview = f.isOverview;
      }
      const rgba = renderDescriptor(f, curG);
      enc.addFrame(rgba, f.delayMs);

      if (i + 1 < plan.length && performance.now() - lastYield >= 16) {
        onProgress?.(Math.round(((i + 1) / plan.length) * 100));
        await new Promise((r) => setTimeout(r, 0));
        lastYield = performance.now();
      }
    }
    bytes = enc.finish();
  }


  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes], { type: "image/gif" }));
  });
  return { bytes, dataUrl, filename };
}

const HV_RING = [[0,-1],[1,-1],[1,0],[0,1],[-1,1],[-1,0]];
// Which ring-one slots a few cells take, so two or three cells sit balanced around the middle.
const HV_FEW = {1:[0], 2:[5,1], 3:[0,2,4], 4:[5,1,4,2], 5:[5,0,1,4,2]};
function hiveSlots(n) {
  if (n < 1) return [];
  if (n < 6) return HV_FEW[n].map(k => HV_RING[k]);
  const out = [], D = [[1,0],[0,1],[-1,1],[-1,0],[0,-1],[1,-1]];
  for (let k = 1; out.length < n; k++) { let q = 0, r = -k; D.forEach(([dq, dr]) => { for (let j = 0; j < k; j++) { out.push([q, r]); q += dq; r += dr; } }); }
  return out.slice(0, n);
}

const HV_ASK = /\?|could you|can you|please|ping me|waiting on/i;
const HV_BUSY_MS = 45 * 60 * 1000, HV_ASK_MS = 6 * 3600 * 1000;

// Each member's state: {st: working | wait | needs | issue | done | idle | retired | unborn, who}.
function hiveStates(sc, seq, P) {
  const out = Object.create(null), names = Object.keys(sc.members).filter(n => !sc.members[n].system);
  if (seq == null) {
    const owned = n => sc.workstreams.filter(w => w.owners.includes(n));
    names.forEach(n => { const x = sc.members[n]; let st = 'idle', who = null;
      if (x.killed) st = 'retired';
      else if (sc.finished) st = n === 'coordinator' ? 'idle' : 'done';
      else if (x.issue) st = 'issue';
      else if (x.status === 'working') st = 'working';
      else if (x.status === 'waiting_on') { st = 'wait'; who = x.waiting_on; }
      else if (n !== 'coordinator' && owned(n).length && owned(n).every(w => w.state === 'done')) st = 'done';
      out[n] = {st, who}; });
    if (!sc.finished && out.coordinator && out.coordinator.st !== 'retired' && sc.attention.some(a => a.wait === 'you')) out.coordinator = {st: 'needs', who: null};
    const lp = P[P.length - 1];
    return {st: out, done: null, beam: lp && Date.now() - Date.parse(lp.t) < 90 * 1000 ? lp : null};
  }
  let i = -1; while (i + 1 < P.length && P[i + 1].s <= seq) i++;
  const fin = Object.create(null), lastPost = Object.create(null), lastIn = Object.create(null), born = Object.assign(Object.create(null), {coordinator: true}), tms = k => Date.parse(P[k].t);
  P.forEach((p, k) => { fin[p.a] = k; });
  const to = p => p.to.includes('*') ? [] : p.to;
  for (let k = 0; k <= i; k++) { const p = P[k]; born[p.a] = true; lastPost[p.a] = k; to(p).forEach(n => { born[n] = true; lastIn[n] = k; }); }
  const now = i >= 0 ? tms(i) : 0;
  names.forEach(n => { const x = sc.members[n], lp = lastPost[n] ?? -1, li = lastIn[n] ?? -1; let st = 'idle', who = null;
    if (!born[n]) st = 'unborn';
    else if (x.killed && (fin[n] != null ? (i >= fin[n] && (i > fin[n] + 8 || now - tms(fin[n]) > HV_BUSY_MS)) : i > li + 8)) st = 'retired';
    else if (li > lp && now - tms(li) < HV_BUSY_MS) { st = 'working'; who = P[li].a; }
    else if (lp >= 0 && HV_ASK.test(P[lp].x) && to(P[lp]).length && now - tms(lp) < HV_ASK_MS && (lastPost[to(P[lp])[0]] ?? -1) <= lp) { st = 'wait'; who = to(P[lp])[0]; }
    else if (lp >= 0 && fin[n] <= i && n !== 'coordinator') st = 'done';
    else if (lp >= 0 && i - lp < 3 && now - tms(lp) < 4 * 60 * 1000) st = 'working';
    out[n] = {st, who: who === n ? null : who}; });
  return {st: out, done: n => out[n] && (out[n].st === 'retired' || (fin[n] != null && fin[n] <= i)), beam: i >= 0 ? P[i] : null};
}


function hiveModel(snapshot) {
  const posts = snapshot.messages.map(m => {
    const { direct, viaAll } = targetsOf(m, true, snapshot.members);
    return { a:m.agent, s:m.seq, t:m.created_at, x:m.text, to:[...direct, ...viaAll] };
  });
  const lastPosts = new Map(posts.map(p => [p.a,p]));
  const members = Object.fromEntries(snapshot.members.map(w => [w.name, {
    ...w, killed:w.status==="killed", issue:Boolean(w.error || w.quota_paused_seq),
    waiting_on:lastPosts.get(w.name)?.to[0], status:w.status==="waiting_reply" ? "waiting_on" : w.status,
  }]));
  const workstreams = snapshot.members.filter(w => w.name!=="coordinator").map(w => ({
    owners:[w.name], state:/\[done\]/i.test(lastPosts.get(w.name)?.x || "") ? "done" : "open"
  }));
  return { members, posts, workstreams, attention:[], finished:posts.at(-1)?.a==="coordinator" && /\[done\]/i.test(posts.at(-1).x) };
}

export function createHiveView(host) {
  const tools = document.createElement("div"), view = document.createElement("div");
  tools.className = "sw-hive-tools"; view.className = "sw-hive-viewport";
  const svg = svgNode("svg", { class:"sw-hive-map" });
  const card = document.createElement("section");
  card.className = "sw-hive-detail"; card.hidden = true;
  view.append(svg); host.replaceChildren(tools,view,card);
  let snapshot, groups, model, sequence = null, selected = null, zoom = 1, dragged = false;
  const buttons = ["−","+","适应视图"].map((label,i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn-ghost";
    b.onclick = () => {
      const ax = (view.scrollLeft + view.clientWidth/2) / Math.max(1,svg.clientWidth);
      const ay = (view.scrollTop + view.clientHeight/2) / Math.max(1,svg.clientHeight);
      zoom = i === 2 ? 1 : Math.max(1, Math.min(6, zoom * (i ? 1.5 : 1/1.5)));
      draw(); view.scrollLeft = ax*svg.clientWidth - view.clientWidth/2; view.scrollTop = ay*svg.clientHeight - view.clientHeight/2;
    };
    tools.append(b); return b;
  });

  function draw() {
    if (!snapshot || !view.clientWidth) return;
    const { st, done, beam } = hiveStates(model, sequence, model.posts);
    const visible = n => st[n] && st[n].st !== "unborn";
    const settled = n => done ? done(n) : ["retired","done"].includes(st[n]?.st);
    const byState = [
      ["working", tr("运行中"), ["working"]],
      ["waiting", tr("等待回复"), ["wait", "issue"]],
      ["resting", tr("待命"), ["idle"]],
      ["done", tr("已完成"), ["done", "retired"]],
    ];
    const cellsAtStep = groups.length ? groups : byState.map(([id, title, states]) => ({
      id, title, names: Object.keys(st).filter(n => n !== "coordinator" && states.includes(st[n].st)),
    })).filter(c => c.names.length);
    const cells = cellsAtStep.map(group => ({ ...group, bees:group.names.filter(visible), done:group.names.filter(settled).length }));
    const names = snapshot.members.filter(w=>w.name!=="coordinator").map(w=>w.name);
    const coordinator = { id:"hub", title:tr("协调者"), names, bees:["coordinator"], done:names.filter(settled).length };
    const slots = [[0,0], ...hiveSlots(cells.length)];
    const units = slots.map(([q,r]) => [1.5*q, Math.sqrt(3)*(r+q/2)]);
    const xs = units.map(u=>u[0]), ys=units.map(u=>u[1]);
    const minX=Math.min(...xs), maxX=Math.max(...xs), minY=Math.min(...ys), maxY=Math.max(...ys);
    const radius=102, pitch=107, halfH=Math.sqrt(3)*radius/2;
    const w=(maxX-minX)*pitch+2*radius+16, h=(maxY-minY)*pitch+2*halfH+16;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const width = Math.min(view.clientWidth,w) * zoom;
    svg.style.width = width+"px"; svg.style.height = width*h/w+"px";
    // Keep names legible at fit-to-width; very dense maps still offer explicit zoom.
    const px = w / width;
    svg.style.setProperty("--hex-small-text", Math.min(17, Math.max(11, 10 * px)) + "px");
    svg.style.setProperty("--hex-heading", Math.min(20, Math.max(14, 12 * px)) + "px");
    buttons[0].textContent="−"; buttons[1].textContent="+"; buttons[2].textContent=tr("适应视图");
    buttons[0].setAttribute("aria-label",tr("缩小"));buttons[1].setAttribute("aria-label",tr("放大"));
    buttons[0].disabled=buttons[2].disabled=zoom<=1; buttons[1].disabled=zoom>=6;
    const hex = (cx,cy,r) => Array.from({length:6},(_,k)=>{
      const a=(k-2)*Math.PI/3; return [cx+r*Math.cos(a),cy+r*Math.sin(a)].join(",");
    }).join(" ");
    const tiles=svgNode("g"), lines=svgNode("g"), bees=svgNode("g"), positions=new Map();
    [coordinator,...cells].forEach((cell,i)=>{
      const [u,v]=units[i], x=(u-minX)*pitch+radius+8, y=(v-minY)*pitch+halfH+8;
      const group=svgNode("g",{class:"sw-hex"+(selected===cell.id ? " selected" : ""), role:"button",tabindex:0,
        "aria-label":cell.title, "aria-pressed":selected===cell.id, "data-cell":cell.id});
      group.append(svgNode("title",{},cell.title),svgNode("polygon",{points:hex(x,y,radius)}));
      if (cell.done) group.append(svgNode("polygon",{points:hex(x,y,radius-4),class:"sw-hex-progress",pathLength:1,
        "stroke-dasharray":`${cell.done / cell.names.length} 1`}));
      const clip = (s,n)=>s.length>n ? s.slice(0,n-1)+"…" : s;
      group.append(svgNode("text",{x,y:i ? y-53 : y+41,class:"sw-hex-title"},clip(cell.title,18)),
        svgNode("text",{x,y:i ? y-36 : y+60,class:"sw-hex-meta"},tr("完成 {0}/{1}",cell.done,cell.names.length)));
      tiles.append(group);
      const many=cell.bees.length>6, shown=cell.bees.slice(0,many ? 5 : 6);
      const total=shown.length+(many ? 1 : 0);
      for (let j=0;j<total;j++) {
        const row=Math.floor(j/3), col=j%3, ncol=Math.min(3,total-row*3);
        const bx=x+(col-(ncol-1)/2)*48, by=i ? y+(total>3 ? -12 : 7)+row*44 : y-11;
        if (many && j===5) { bees.append(svgNode("text",{x:bx,y:by,class:"sw-hex-meta"},"+"+(cell.bees.length-5)));continue; }
        const name=shown[j], worker=model.members[name], state=sequence==null ? (worker.status==="waiting_on" ? "waiting_reply" : worker.status)
          : ({working:"working", wait:"waiting_reply",retired:"killed",idle:"waiting"}[st[name].st] || "landed");
        if (!positions.has(name)) positions.set(name,{x:bx,y:by,w:32,h:28});
        const size=i ? 39 : 66;
        const avatar=svgNode("g", {class:"sw-hex-avatar"});
        for (let frame=0;frame<(["working","waiting_reply"].includes(state) ? 2 : 1);frame++) {
          avatar.append(svgNode("image",{href:beeDataUrl(name,state,frame),x:bx-size/2,y:by-size*9/22,width:size,height:size*18/22}));
        }
        bees.append(avatar);
        if(i) bees.append(svgNode("text",{x:bx,y:by+22,class:"sw-hex-name"},clip(name,8)));
      }
    });
    function link(from,to,current) {
      const a=positions.get(from), b=positions.get(to);
      if (!a || !b || a===b) return;
      const geom=edgeGeom(a,b);
      lines.append(svgNode("path",{d:geom.d,class:"sw-hive-beam"+(current ? " current" : "")}));
      if (current) {
        const dot=svgNode("circle",{r:3,class:"sw-moving-dot"});
        if (!matchMedia("(prefers-reduced-motion: reduce)").matches) dot.append(svgNode("animateMotion",{path:geom.d,dur:".7s",begin:"indefinite",fill:"freeze"}));
        else {dot.setAttribute("cx",geom.end.x);dot.setAttribute("cy",geom.end.y);}
        lines.append(dot);
      }
    }
    for (const [n,s] of Object.entries(st)) if (s.st==="wait") link(n,s.who,false);
    for (const to of beam?.to || []) link(beam.a,to,true);
    svg.replaceChildren(tiles,lines,bees);
    for (const motion of svg.querySelectorAll("animateMotion")) motion.beginElement?.();
    const cell=[coordinator,...cells].find(c=>c.id===selected);
    card.hidden=!cell;
    if (cell) {
      const heading=document.createElement("strong");heading.textContent=cell.title;
      const info=document.createElement("p");info.textContent=[cell.goal,cell.bees.map(n=>"@"+n).join(" · ")].filter(Boolean).join("\n") || tr("暂无工位");
      card.replaceChildren(heading,info);
    }
  }
  function select(target) {
    if (!target) return;
    selected = selected===target.dataset.cell ? null : target.dataset.cell;
    draw(); [...svg.querySelectorAll("[data-cell]")].find(el=>el.dataset.cell===target.dataset.cell)?.focus({preventScroll:true});
  }
  svg.addEventListener("click",e=>{if (!dragged) select(e.target.closest("[data-cell]"));});
  svg.addEventListener("keydown",e=>{
    if(e.key==="Escape") {selected=null;draw();}
    if(e.key==="Enter" || e.key===" ") {e.preventDefault();select(e.target.closest("[data-cell]"));}
  });
  let pan;
  view.addEventListener("pointerdown",e=>{if(e.button===0 && zoom>1) pan={id:e.pointerId,x:e.clientX,y:e.clientY,left:view.scrollLeft,top:view.scrollTop};});
  view.addEventListener("pointermove",e=>{
    if(pan?.id!==e.pointerId) return;
    const dx=e.clientX-pan.x,dy=e.clientY-pan.y;
    if(!dragged && Math.hypot(dx,dy)<5) return;
    dragged=true;view.setPointerCapture(e.pointerId);view.scrollLeft=pan.left-dx;view.scrollTop=pan.top-dy;
  });
  function endPan() {pan=null;setTimeout(()=>{dragged=false;},0);}
  for(const type of ["pointerup","pointercancel","pointerleave"]) view.addEventListener(type,endPan);
  const observer=new ResizeObserver(draw);observer.observe(view);
  return { update(s,g,seq) {if(snapshot!==s) model=hiveModel(s);snapshot=s;groups=g;sequence=seq;draw();},
    reset(){selected=null;zoom=1;snapshot=null;}, destroy(){observer.disconnect();} };
}

const NODE = 12;
const EDGE = 16;
const VALUE = 8;
const NONE = 0xFFFFFFFF;
const ORDINARY = 100_000;

const canvas = document.getElementById("graph");
const ctx = canvas.getContext("2d");

let total = 0;
let unit = "transactions";
let counts = new Map();
let heatTop = 1;
let meta = null;
let overview = null;
let cam = { x: 0, y: 0, sx: 1, sy: 1 };
let atHome = true;
let anim = 0;
let drag = null;
let hover = null;
let selected = null;
let focusNodes = [];
let blocks = new Map();
let loading = new Map();

function parseState(state) {
  const parts = String(state || "").split("|");
  const out = { version: "", seq: "", lock: "", sighash: "", family: "", lowr: "", rune: "" };
  if (parts.length < 5) {
    out.version = state || "—";
    return out;
  }
  if (["rune", "plain"].includes(parts[parts.length - 1])) out.rune = parts.pop();
  if (["grind", "nogrind", "na"].includes(parts[parts.length - 1])) out.lowr = parts.pop();
  out.version = parts[0];
  out.seq = parts[1];
  out.lock = parts[2];
  out.family = parts[parts.length - 1];
  out.sighash = parts.slice(3, -1).join("|");
  return out;
}

function stateName(id) {
  return meta && meta.states ? meta.states[id] || "other" : "other";
}

function lookup(state) {
  const key = withoutLowr(state);
  return counts.has(key) ? counts.get(key) : null;
}

function samePrint(a, b) {
  const left = withoutLowr(stateName(a));
  const right = withoutLowr(stateName(b));
  return left !== "other" && left === right;
}

function shareText(state) {
  const n = lookup(state);
  if (n == null) return { line: "", ratio: "—" };
  const p = n / total;
  const one = oneInCount(p);
  return {
    line: `${n.toLocaleString()} ${unit} · ${(p * 100).toFixed(2)}%`,
    ratio: one == null ? "—" : `1 out of ${one.toLocaleString()}`,
  };
}

function label(state) {
  if (!state || state === "other") return "—";
  return fingerprintCode(parseState(state));
}

function btc(sats) {
  if (sats == null || sats === NONE) return "";
  return `${(sats / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 })} BTC`;
}

function cut(hexid) {
  return `${hexid.slice(0, 8)}…${hexid.slice(-4)}`;
}

function rarityT(n) {
  if (n == null || n < 1 || !(total > 1)) return 1;
  const span = Math.log(total * 0.16) - Math.log(200);
  if (span <= 1e-9) return n >= 200 ? 0 : 1;
  return 1 - Math.max(0, Math.min(1, (Math.log(Math.max(n, 1)) - Math.log(200)) / span));
}

function habitHue(state) {
  const key = withoutLowr(state);
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

function hslRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r, g, b].map((ch) => Math.floor(ch * 255 + m * 255 + 0.5));
}

function rgbFor(hue, t) {
  const turned = (hue * (1 - 0.28 * t) + 8 * t) % 360;
  return hslRgb(turned, 0.42 + 0.48 * t, 0.36 + 0.26 * t);
}

function markRgb(state) {
  return rgbFor(habitHue(state), rarityT(lookup(state)));
}

function setCounts(rows) {
  counts = new Map(rows.map((fp) => [fp.state, fp.n]));
  heatTop = 1;
  for (const count of counts.values()) if (count > heatTop) heatTop = count;
}

function heatHex(state) {
  const rgb = markRgb(state);
  return `rgb(${rgb.join(",")})`;
}

function toScreen(x, y) {
  return [(x - cam.x) * cam.sx + canvas.clientWidth / 2, (y - cam.y) * cam.sy + canvas.clientHeight / 2];
}

function toWorld(x, y) {
  return [(x - canvas.clientWidth / 2) / cam.sx + cam.x, (y - canvas.clientHeight / 2) / cam.sy + cam.y];
}

function frame(list, pad) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of list) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }
  const bw = Math.max(6, maxX - minX) + pad * 2;
  const bh = Math.max(4, maxY - minY) + pad * 2;
  let sx = canvas.clientWidth / bw;
  let sy = canvas.clientHeight / bh;
  let x = (minX + maxX) / 2;
  let y = (minY + maxY) / 2;
  if (sx < 26 || sy < 14) {
    sx = Math.max(sx, 26);
    sy = Math.max(sy, 14);
    const focus = list.find((node) => node.role === "Tx") || list[0];
    x = focus.x;
    y = focus.y;
  }
  return { x, y, sx, sy };
}

function fitAll(animate) {
  if (!meta) return;
  const next = {
    x: meta.max_x / 2,
    y: meta.max_y / 2,
    sx: canvas.clientWidth / Math.max(1, meta.max_x) * 0.96,
    sy: canvas.clientHeight / Math.max(1, meta.view_y || meta.max_y) * 0.96,
  };
  next.y = (meta.view_y || meta.max_y) / 2;
  atHome = true;
  selected = null;
  hover = null;
  focusNodes = [];
  if (animate) animateTo(next);
  else {
    cam = next;
    draw();
  }
  renderPanel();
}

function animateTo(next) {
  const id = ++anim;
  const from = { ...cam };
  const t0 = performance.now();
  const step = (now) => {
    if (id !== anim) return;
    const t = Math.min(1, (now - t0) / 1200);
    const e = 1 - (1 - t) ** 3;
    cam.x = from.x + (next.x - from.x) * e;
    cam.y = from.y + (next.y - from.y) * e;
    cam.sx = from.sx + (next.sx - from.sx) * e;
    cam.sy = from.sy + (next.sy - from.sy) * e;
    draw();
    if (t < 1) requestAnimationFrame(step);
    else ensureVisible();
  };
  requestAnimationFrame(step);
}

function fitScale() {
  const yMax = (meta && (meta.view_y || meta.max_y)) || 1;
  const xMax = (meta && meta.max_x) || 1;
  return {
    sx: canvas.clientWidth / Math.max(1, xMax) * 0.96,
    sy: canvas.clientHeight / Math.max(1, yMax) * 0.96,
  };
}

function markSize() {
  const pitch = Math.min(Math.abs(cam.sx), Math.abs(cam.sy));
  return Math.max(2, pitch * 0.46);
}

function paintNode(node, x, y, marked) {
  const size = markSize();
  const px = x - size / 2;
  const py = y - size / 2;
  ctx.fillStyle = heatHex(stateName(node.state));
  ctx.fillRect(px, py, size, size);
  if (!marked) return;
  ctx.strokeStyle = "#e4dcc8";
  ctx.lineWidth = 1.25;
  ctx.strokeRect(px - 2, py - 2, size + 4, size + 4);
}

function viewStats() {
  const blocksWide = canvas.clientWidth / Math.max(cam.sx, 1e-6);
  const rows = canvas.clientHeight / Math.max(cam.sy, 1e-6);
  const yMax = (meta && (meta.view_y || meta.max_y)) || 1;
  const per = meta ? meta.count / Math.max(1, meta.blocks) : 0;
  const est = blocksWide * Math.min(1, rows / yMax) * per;
  return { blocksWide, rows, est };
}

function wantVectors() {
  if (!meta || !meta.complete) return false;
  const { est } = viewStats();
  return Math.abs(cam.sy) >= 6 && est < 120000;
}

function clampZoom(factor) {
  const fit = fitScale();
  const zoom = cam.sx / Math.max(fit.sx, 1e-9);
  const next = Math.max(1, Math.min(400, zoom * factor));
  const applied = next / Math.max(zoom, 1e-9);
  cam.sx *= applied;
  cam.sy *= applied;
}

function zoomAt(px, py, factor) {
  const [wx, wy] = toWorld(px, py);
  clampZoom(factor);
  cam.x = wx - (px - canvas.clientWidth / 2) / cam.sx;
  cam.y = wy - (py - canvas.clientHeight / 2) / cam.sy;
  atHome = false;
  anim += 1;
  draw();
  ensureVisible();
}

function visibleHeights() {
  const [x0] = toWorld(0, 0);
  const [x1] = toWorld(canvas.clientWidth, 0);
  const a = Math.max(0, Math.floor(Math.min(x0, x1)) - 1);
  const b = Math.min(meta.max_x, Math.ceil(Math.max(x0, x1)) + 1);
  return [a, b];
}

async function rangeBuf(url, start, length) {
  if (length <= 0) return new ArrayBuffer(0);
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${start + length - 1}` }, cache: "no-store" });
  if (response.status !== 206) throw new Error(String(response.status));
  return response.arrayBuffer();
}

function decodeNodes(buf, startIndex) {
  const view = new DataView(buf);
  const nodes = [];
  for (let off = 0; off + NODE <= buf.byteLength; off += NODE) {
    nodes.push({
      i: startIndex + off / NODE,
      x: view.getUint16(off, true),
      y: view.getUint16(off + 2, true),
      state: view.getUint16(off + 4, true),
      nout: view.getUint8(off + 6),
      flags: view.getUint8(off + 7),
      parent: view.getUint32(off + 8, true),
    });
  }
  return nodes;
}

function decodeEdges(buf) {
  const view = new DataView(buf);
  const edges = [];
  for (let off = 0; off + EDGE <= buf.byteLength; off += EDGE) {
    const pack = view.getUint16(off + 14, true);
    edges.push({
      child: view.getUint32(off, true),
      sats: view.getUint32(off + 4, true),
      x: view.getUint16(off + 8, true),
      y: view.getUint16(off + 10, true),
      state: view.getUint16(off + 12, true),
      same: (pack & 0x8000) !== 0,
      vout: pack & 0x7fff,
    });
  }
  return edges;
}

function loadHeight(h) {
  if (blocks.has(h) || !meta.heights) return Promise.resolve();
  if (loading.has(h)) return loading.get(h);
  const spec = meta.heights[h];
  if (!spec) return Promise.resolve();
  const job = (async () => {
    const [nodeStart, nodeCount, edgeFrom, edgeCount] = spec;
    try {
      const jobs = [
        rangeBuf("graph/nodes.bin", nodeStart * NODE, nodeCount * NODE),
        rangeBuf("graph/edges.bin", edgeFrom * EDGE, edgeCount * EDGE),
        rangeBuf("graph/kcounts.bin", nodeStart * 4, nodeCount * 4),
      ];
      if (meta.values) jobs.push(rangeBuf("graph/values.bin", nodeStart * VALUE, nodeCount * VALUE));
      const bufs = await Promise.all(jobs);
      const [nodeBuf, edgeBuf, countBuf, valueBuf] = bufs;
      const nodes = decodeNodes(nodeBuf, nodeStart);
      const edges = decodeEdges(edgeBuf);
      const counts32 = new Uint32Array(countBuf);
      const values = valueBuf ? new BigUint64Array(valueBuf) : null;
      let at = 0;
      for (let i = 0; i < nodes.length; i += 1) {
        nodes[i].edgeAt = at;
        nodes[i].edgeN = counts32[i] || 0;
        if (values) nodes[i].sats = Number(values[i]);
        at += nodes[i].edgeN;
      }
      blocks.set(h, { nodes, edges });
      draw();
    } catch (err) {
      blocks.delete(h);
    } finally {
      loading.delete(h);
    }
  })();
  loading.set(h, job);
  return job;
}

function ensureVisible() {
  if (!wantVectors()) return;
  const [a, b] = visibleHeights();
  for (let h = a; h <= b; h += 1) loadHeight(h);
  if (blocks.size > 400) {
    for (const key of blocks.keys()) {
      if (key < a - 2 || key > b + 2) blocks.delete(key);
    }
  }
}

function nodesInView() {
  const out = [];
  if (!wantVectors()) return out;
  const [x0, y0] = toWorld(-20, -20);
  const [x1, y1] = toWorld(canvas.clientWidth + 20, canvas.clientHeight + 20);
  const loX = Math.min(x0, x1);
  const hiX = Math.max(x0, x1);
  const loY = Math.min(y0, y1);
  const hiY = Math.max(y0, y1);
  for (const [h, block] of blocks) {
    if (h < loX - 1 || h > hiX + 1) continue;
    for (const node of block.nodes) {
      if (node.y >= loY && node.y <= hiY) out.push(node);
    }
  }
  return out;
}

function edgesOf(node) {
  const block = blocks.get(node.x);
  if (!block || node.edgeAt == null) return [];
  return block.edges.slice(node.edgeAt, node.edgeAt + node.edgeN);
}

async function fetchNode(index) {
  const buf = await rangeBuf("graph/nodes.bin", index * NODE, NODE);
  return decodeNodes(buf, index)[0];
}

async function fetchSats(index) {
  const buf = await rangeBuf("graph/values.bin", index * VALUE, VALUE);
  return Number(new BigUint64Array(buf)[0]);
}

async function fetchTxid(index) {
  const buf = await rangeBuf("graph/txids.bin", index * 32, 32);
  const bytes = new Uint8Array(buf);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function nearest(nodes, px, py, reach) {
  let best = null;
  let bestD = Infinity;
  for (const node of nodes) {
    const [sx, sy] = toScreen(node.x, node.y);
    const limit = Math.max(reach, markSize(node) / 2 + 3);
    const d = (sx - px) ** 2 + (sy - py) ** 2;
    if (d <= limit * limit && d < bestD) {
      best = node;
      bestD = d;
    }
  }
  return best;
}

function hit(px, py) {
  const reach = Math.max(8, Math.abs(cam.sy) * 0.45);
  const focusHit = nearest(focusNodes, px, py, Math.max(reach, Math.abs(cam.sy) * 0.5));
  if (focusHit) return focusHit;
  if (!wantVectors()) return null;
  return nearest(nodesInView(), px, py, reach);
}

async function pickNearest(px, py) {
  if (!meta || !meta.complete || !meta.heights) return null;
  const [wx] = toWorld(px, py);
  const h = Math.max(0, Math.min(meta.max_x, Math.round(wx)));
  const jobs = [];
  for (let i = h - 1; i <= h + 1; i += 1) {
    if (i >= 0 && i <= meta.max_x) jobs.push(loadHeight(i));
  }
  await Promise.all(jobs);
  const pool = [];
  for (let i = h - 1; i <= h + 1; i += 1) {
    const block = blocks.get(i);
    if (block) pool.push(...block.nodes);
  }
  return nearest(pool, px, py, Math.max(canvas.clientWidth, canvas.clientHeight));
}

function drawOverview() {
  if (!overview || !meta) return;
  const yMax = meta.view_y || meta.max_y;
  const [x0, y0] = toScreen(0, 0);
  const [x1, y1] = toScreen(meta.max_x, yMax);
  const srcW = overview.naturalWidth || overview.width || 2000;
  const mag = Math.abs(x1 - x0) / srcW;
  ctx.imageSmoothingEnabled = mag < 1.35;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(overview, x0, y0, x1 - x0, y1 - y0);
}

function drawVectors() {
  const linked = new Set(focusNodes.map((node) => node.i));
  if (selected) linked.add(selected.i);
  if (hover) linked.add(hover.i);
  const view = nodesInView();
  const drawn = new Set(view.map((node) => node.i));
  if (linked.size) {
    const seen = new Set();
    for (const node of view) {
      if (!linked.has(node.i)) continue;
      for (const edge of edgesOf(node)) {
        if (seen.has(`${node.i}:${edge.child}`)) continue;
        seen.add(`${node.i}:${edge.child}`);
        const [x0, y0] = toScreen(node.x, node.y);
        const [x1, y1] = toScreen(edge.x, edge.y);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        const shared = samePrint(node.state, edge.state);
        ctx.strokeStyle = shared ? "#e4dcc8" : "rgba(92,89,80,0.95)";
        ctx.lineWidth = shared ? 2 : 1;
        ctx.stroke();
        if (drawn.has(edge.child)) continue;
        const child = { i: edge.child, state: edge.state };
        const marked = (selected && child.i === selected.i) || (hover && child.i === hover.i && (!selected || selected.i !== child.i));
        paintNode(child, x1, y1, marked);
      }
    }
  }
  view.sort((a, b) => (b.sats || 0) - (a.sats || 0));
  for (const node of view) {
    const [sx, sy] = toScreen(node.x, node.y);
    const marked = (selected && node.i === selected.i) || (hover && node.i === hover.i && (!selected || selected.i !== node.i));
    paintNode(node, sx, sy, marked);
  }
  drawFocusLabels();
}

function rectsHit(a, b) {
  return a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
}

function drawFocusLabels() {
  if (!focusNodes.length || Math.min(cam.sx, cam.sy) < 6) return;
  ctx.font = "500 12px \"IBM Plex Mono\", ui-monospace, monospace";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  const occupied = focusNodes.map((node) => {
    const [sx, sy] = toScreen(node.x, node.y);
    const size = markSize(node);
    return { l: sx - size / 2 - 2, t: sy - size / 2 - 2, r: sx + size / 2 + 2, b: sy + size / 2 + 2 };
  });
  const placed = [];
  const targets = selected ? focusNodes.filter((node) => node.i === selected.i) : focusNodes.slice(0, 1);
  for (const node of targets) {
    const text = shareText(stateName(node.state)).ratio;
    const tw = ctx.measureText(text).width;
    const [sx, sy] = toScreen(node.x, node.y);
    const size = markSize(node);
    const options = [
      { l: sx - tw / 2, t: sy - size / 2 - 20, r: sx + tw / 2, b: sy - size / 2 - 6 },
      { l: sx + size / 2 + 12, t: sy - 6, r: sx + size / 2 + 12 + tw, b: sy + 8 },
    ];
    const spot = options.find((box) => !occupied.some((r) => rectsHit(box, r)) && !placed.some((r) => rectsHit(box, r)));
    if (!spot) continue;
    ctx.fillStyle = "#e6e1d4";
    ctx.fillText(text, spot.l, spot.t);
    placed.push(spot);
  }
  ctx.textBaseline = "alphabetic";
}

function drawFocusCluster() {
  const byId = new Map(focusNodes.map((node) => [node.i, node]));
  for (const node of focusNodes) {
    const parent = byId.get(node.parent);
    if (!parent) continue;
    const [x0, y0] = toScreen(parent.x, parent.y);
    const [x1, y1] = toScreen(node.x, node.y);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = node.same ? "#e4dcc8" : "rgba(92,89,80,0.95)";
    ctx.lineWidth = node.same ? 2 : 1;
    ctx.stroke();
  }
  for (const node of focusNodes) {
    const [sx, sy] = toScreen(node.x, node.y);
    paintNode(node, sx, sy, selected && node.i === selected.i);
  }
  drawFocusLabels();
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  if (wantVectors()) drawVectors();
  else {
    drawOverview();
    if (focusNodes.length) {
      ctx.fillStyle = "rgba(12, 14, 12, 0.62)";
      ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      drawFocusCluster();
    }
  }
}

function swatch(hue, t) {
  const chip = document.createElement("i");
  chip.style.background = `rgb(${rgbFor(hue, t).join(",")})`;
  return chip;
}

function renderLegend() {
  const el = document.getElementById("legend");
  el.replaceChildren();
  const name = document.createElement("span");
  name.className = "legend-name";
  name.textContent = "Print";
  const rareName = document.createElement("span");
  rareName.className = "legend-name";
  rareName.textContent = "Rarer";
  const sameName = document.createElement("span");
  sameName.className = "legend-name";
  sameName.textContent = "Same print";
  const key = document.createElement("i");
  key.className = "same-key";
  el.append(
    name,
    swatch(28, 0.35),
    swatch(152, 0.35),
    swatch(212, 0.35),
    swatch(286, 0.35),
    rareName,
    swatch(28, 0),
    swatch(28, 1),
    sameName,
    key,
  );
}

function renderPanel() {
  const aside = document.getElementById("detail");
  aside.replaceChildren();
  const node = selected || hover;
  if (!node) {
    const h = document.createElement("h2");
    h.textContent = meta && meta.count ? meta.count.toLocaleString() : "—";
    const p = document.createElement("p");
    p.className = "share";
    p.textContent = meta && !meta.complete ? `${meta.blocks.toLocaleString()} / ${meta.block_count.toLocaleString()} blocks` : "transactions";
    aside.append(h, p);
    return;
  }
  const name = stateName(node.state);
  const share = shareText(name);
  const parts = parseState(name);
  const h = document.createElement("h2");
  h.className = "standout";
  h.textContent = share.ratio;
  const code = document.createElement("p");
  code.className = "code";
  code.textContent = label(name);
  const words = document.createElement("p");
  words.className = "words";
  words.textContent = !name || name === "other" ? "" : fingerprintWords(parts).join(" · ");
  aside.append(h, code, words);
  if (node.sats) {
    const amt = document.createElement("p");
    amt.className = "share";
    amt.textContent = btc(node.sats);
    aside.append(amt);
  }
  if (share.line) {
    const p = document.createElement("p");
    p.className = "share";
    p.textContent = share.line;
    aside.append(p);
  }
  const bar = document.createElement("div");
  bar.className = "meter";
  const fill = document.createElement("i");
  const n = lookup(name);
  fill.style.width = `${n == null ? 2 : Math.min(100, Math.max(0.8, 100 * n / total))}%`;
  fill.style.background = heatHex(name);
  bar.append(fill);
  aside.append(bar);
  const link = document.createElement("a");
  link.textContent = node.txid ? cut(node.txid) : "…";
  link.title = node.txid || "";
  if (node.txid) {
    link.href = `https://mempool.space/tx/${node.txid}`;
    link.target = "_blank";
    link.rel = "noreferrer";
  }
  aside.append(link);

  const rows = document.createElement("div");
  rows.className = "fork-rows";
  const list = focusNodes.length ? focusNodes : [node];
  for (const row of list) {
    const linked = !!row.txid;
    const b = document.createElement(linked ? "a" : "button");
    if (linked) {
      b.className = "fork-row";
      b.href = `https://mempool.space/tx/${row.txid}`;
      b.target = "_blank";
      b.rel = "noreferrer";
    } else b.type = "button";
    if (row.i === node.i) b.classList.add("on");
    if (row.same) b.classList.add("same");
    const sw = document.createElement("i");
    sw.style.background = heatHex(stateName(row.state));
    const text = document.createElement("span");
    const rowState = stateName(row.state);
    text.textContent = row.role || label(rowState);
    text.title = !rowState || rowState === "other" ? "" : fingerprintWords(parseState(rowState)).join(" · ");
    const ratio = document.createElement("small");
    ratio.textContent = shareText(stateName(row.state)).ratio;
    if (linked) {
      const tx = document.createElement("span");
      tx.className = "tx";
      tx.textContent = cut(row.txid);
      tx.title = row.txid;
      b.append(sw, text, tx, ratio);
    } else b.append(sw, text, ratio);
    b.addEventListener("click", (ev) => {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
      if (linked) ev.preventDefault();
      choose(row);
    });
    rows.append(b);
  }
  aside.append(rows);

  if (name && name !== "other") {
    const dl = document.createElement("dl");
    for (const [key, title] of FACETS) {
      if (!parts[key]) continue;
      const dt = document.createElement("dt");
      dt.textContent = title;
      const dd = document.createElement("dd");
      dd.textContent = facetLabel(key, parts[key]);
      dd.title = tipFor(key, parts[key]);
      dl.append(dt, dd);
    }
    aside.append(dl);
  }
}

let chooseGen = 0;

async function hydrate(node) {
  if (!node || node.x == null) return node;
  if (node.edgeAt != null && blocks.has(node.x)) return node;
  await loadHeight(node.x);
  const block = blocks.get(node.x);
  const real = block && block.nodes.find((item) => item.i === node.i);
  if (!real) return node;
  return {
    ...real,
    role: node.role,
    same: node.same,
    txid: node.txid || real.txid,
    sats: node.sats != null ? node.sats : real.sats,
  };
}

async function choose(node) {
  const gen = ++chooseGen;
  selected = node;
  hover = null;
  atHome = false;
  const full = await hydrate(node);
  if (gen !== chooseGen) return;
  selected = full;
  if (!full.txid) {
    fetchTxid(full.i).then((id) => {
      full.txid = id;
      if (gen === chooseGen) renderPanel();
    });
  }
  const children = edgesOf(full).map((edge) => ({
    i: edge.child,
    x: edge.x,
    y: edge.y,
    state: edge.state,
    nout: 0,
    flags: 0,
    parent: full.i,
    same: samePrint(full.state, edge.state),
    role: `Output ${edge.vout}`,
    txid: null,
  }));
  let parent = null;
  if (full.parent != null && full.parent !== NONE) {
    try {
      parent = await hydrate(await fetchNode(full.parent));
      if (gen !== chooseGen) return;
      parent.role = "Parent";
      parent.same = samePrint(parent.state, full.state);
    } catch (err) {
      parent = null;
    }
  }
  const self = { ...full, role: "Tx", same: parent ? samePrint(parent.state, full.state) : false };
  focusNodes = [parent, self, ...children].filter(Boolean);
  if (meta.values) {
    for (const row of focusNodes) {
      fetchSats(row.i).then((sats) => {
        row.sats = sats;
        if (gen === chooseGen) {
          renderPanel();
          draw();
        }
      });
    }
  }
  for (const row of focusNodes) {
    if (!row.txid) fetchTxid(row.i).then((id) => { row.txid = id; if (gen === chooseGen) renderPanel(); });
  }
  animateTo(frame(focusNodes, 6));
  renderPanel();
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  if (atHome && meta) fitAll(false);
  else draw();
}

function loadOverview() {
  const img = new Image();
  img.onload = () => {
    overview = img;
    if (atHome) fitAll(false);
    else draw();
  };
  img.src = `graph/overview.png?p=${meta.paint || 1}`;
}

async function refreshMeta() {
  const response = await fetch("graph/meta.json", { cache: "no-store" });
  if (!response.ok) return;
  const next = await response.json();
  const prev = meta;
  const grew = !prev || next.blocks !== prev.blocks || next.complete !== prev.complete || next.values !== prev.values || next.paint !== prev.paint;
  meta = next;
  if (grew) {
    const replaced = !prev || next.count < prev.count || next.complete !== prev.complete || next.values !== prev.values;
    if (replaced) {
      blocks.clear();
      selected = null;
      hover = null;
      focusNodes = [];
      atHome = true;
    }
    if (next.complete) {
      fetch("fingerprints.json", { cache: "no-store" }).then((r) => r.json()).then((prints) => {
        total = prints.total;
        unit = prints.unit || unit;
        setCounts(collapsePrints(prints.fingerprints));
        document.getElementById("window").textContent = windowLine(prints);
        renderLegend();
        renderPanel();
        draw();
      });
    }
    loadOverview();
    renderPanel();
  }
  setTimeout(refreshMeta, meta.complete ? 8000 : 2000);
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  drag = { x: e.clientX, y: e.clientY, ox: cam.x, oy: cam.y, moved: false };
  canvas.classList.add("drag");
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  const rect = canvas.getBoundingClientRect();
  if (drag) {
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (dx * dx + dy * dy > 9) drag.moved = true;
    if (drag.moved) {
      anim += 1;
      cam.x = drag.ox - dx / cam.sx;
      cam.y = drag.oy - dy / cam.sy;
      atHome = false;
      draw();
    }
    return;
  }
  const next = hit(e.clientX - rect.left, e.clientY - rect.top);
  if ((next && next.i) !== (hover && hover.i)) {
    hover = next;
    if (!selected) renderPanel();
    draw();
  }
});
canvas.addEventListener("pointerup", async (e) => {
  canvas.classList.remove("drag");
  const moved = drag && drag.moved;
  drag = null;
  if (moved) {
    ensureVisible();
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const node = hit(px, py) || await pickNearest(px, py);
  if (node) {
    choose(node);
    return;
  }
  const [wx, wy] = toWorld(px, py);
  atHome = false;
  clampZoom(1.55);
  animateTo({ x: wx, y: wy, sx: cam.sx, sy: cam.sy });
});
canvas.addEventListener("pointerleave", () => {
  if (drag || selected) return;
  if (!hover) return;
  hover = null;
  renderPanel();
  draw();
});
canvas.addEventListener("wheel", (e) => {
  if (e.target !== canvas) return;
  e.preventDefault();
  const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
  const dy = e.deltaY * scale;
  if (!dy) return;
  const rect = canvas.getBoundingClientRect();
  zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-dy * 0.00035));
}, { passive: false });

document.getElementById("fit").onclick = () => fitAll(true);
window.addEventListener("keydown", (e) => { if (e.key === "Escape") fitAll(true); });
window.addEventListener("resize", resize);
new ResizeObserver(resize).observe(canvas);

fetch("fingerprints.json", { cache: "no-store" }).then((r) => r.json()).then((prints) => {
  total = prints.total;
  unit = prints.unit || "transactions";
  setCounts(collapsePrints(prints.fingerprints));
  document.getElementById("window").textContent = windowLine(prints);
  renderLegend();
  refreshMeta();
});

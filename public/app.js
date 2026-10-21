const LADDER = [
  { title: "Population", key: null },
  { title: "Version", key: "version" },
  { title: "Sequence", key: "seq" },
  { title: "Locktime", key: "lock" },
  { title: "Script", key: "family" },
  { title: "Signature", key: "sighash" },
  { title: "Runestone", key: "rune" },
  { title: "Fingerprint", key: "state" },
];

const PALETTE = ["#e4dcc8", "#e07a5f", "#7dba9a", "#7aa2c4", "#d4c15a", "#c45d7a", "#9b84d6", "#e3a15a", "#8eb8b0", "#d48ab0", "#a3b86c", "#6f8f6a"];
const LABEL_COLORS = ["#f2efe6", "#e07a5f", "#7dba9a", "#7aa2c4", "#d4c15a", "#c45d7a", "#9b84d6"];

function clusterLabel(key, value, fps) {
  if (!key || value === "all" || value == null) return "All transactions";
  if (key === "state") return fingerprintCode(fps[0]);
  return facetLabel(key, value);
}
const CELL = 3;
const GAP = 1;
const STRIDE = CELL + GAP;

let payload, total, unit = "transactions", depth = 0, path = [], hover = null, join = "and";
const filters = {};
FACETS.forEach(([k]) => { filters[k] = new Set(); });
function loadLabels() {
  try {
    const parsed = JSON.parse(localStorage.getItem("fp-labels") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}
let labels = loadLabels();

const canvas = document.getElementById("field");
const ctx = canvas.getContext("2d");
let groups = [];
let viewN = 0;
let baseUnit = 0;
let homeS = 1;
let mode = "scale";
let colorOf = {};
let cam = { x: 28, y: 28, s: 1 };
let camTo = { x: 28, y: 28, s: 1 };
let animating = false;
let sizedFor = "";

function colorForIndex(i) {
  if (i < PALETTE.length) return PALETTE[i];
  const hue = (i * 47) % 360;
  const light = 58 + (i % 3) * 8;
  return `hsl(${hue} 38% ${light}%)`;
}

function assignColors() {
  colorOf = {};
  for (const [key] of FACETS) {
    const counts = new Map();
    for (const fp of payload.fingerprints) {
      if (fp[key] == null || fp[key] === "") continue;
      counts.set(fp[key], (counts.get(fp[key]) || 0) + fp.n);
    }
    [...counts.entries()].filter(([value]) => value != null && value !== "").sort((a, b) => b[1] - a[1]).forEach(([value], i) => {
      colorOf[`${key}:${value}`] = colorForIndex(i);
    });
  }
  payload.fingerprints.forEach((fp, i) => {
    colorOf[`state:${fp.state}`] = colorForIndex(i);
  });
}

function paintKey() {
  return LADDER[depth].key || "version";
}

function passes(fp) {
  for (const step of path) {
    if (fp[step.key] !== step.value) return false;
  }
  const hits = [];
  for (const [key, set] of Object.entries(filters)) {
    if (!set.size || path.some((step) => step.key === key)) continue;
    hits.push(set.has(fp[key]));
  }
  if (!hits.length) return true;
  return join === "or" ? hits.some(Boolean) : hits.every(Boolean);
}

function labelHits(fp, label) {
  const hits = [];
  for (const step of label.path || []) hits.push(fp[step.key] === step.value);
  for (const [key, vals] of Object.entries(label.filters || {})) {
    if (vals.length) hits.push(vals.includes(fp[key]));
  }
  if (!hits.length) return false;
  return (label.join || "and") === "or" ? hits.some(Boolean) : hits.every(Boolean);
}

function labelOf(fp) {
  for (const label of labels) if (labelHits(fp, label)) return label;
  return null;
}

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const key = `${w}x${h}`;
  if (key !== sizedFor || !baseUnit) {
    sizedFor = key;
    const availW = Math.max(STRIDE, w - 56);
    const availH = Math.max(STRIDE, h - 64);
    const budget = Math.max(1, Math.floor((availW / STRIDE) * (availH / STRIDE) * 0.9));
    baseUnit = Math.max(1, Math.round(total / budget));
    homeS = 1;
  }
}

function layoutGroups() {
  const matched = payload.fingerprints.filter(passes);
  viewN = matched.reduce((s, r) => s + r.n, 0);
  const spec = LADDER[depth];
  const buckets = new Map();
  for (const fp of matched) {
    const value = spec.key ? fp[spec.key] : "all";
    if (!buckets.has(value)) buckets.set(value, []);
    buckets.get(value).push(fp);
  }
  const clump = spec.key || "version";
  const seeds = [...buckets.entries()].map(([value, fps]) => {
    const rank = new Map();
    for (const fp of fps) rank.set(fp[clump], (rank.get(fp[clump]) || 0) + fp.n);
    fps.sort((a, b) => (rank.get(b[clump]) - rank.get(a[clump])) || (b.n - a.n));
    return {
      value,
      fps,
      n: fps.reduce((s, r) => s + r.n, 0),
      color: spec.key ? (colorOf[`${spec.key}:${value}`] || "#8e8a82") : "#e4dcc8",
    };
  }).sort((a, b) => b.n - a.n);

  const rowLimit = mode === "side"
    ? Math.max(canvas.clientWidth * 3, 2400)
    : Math.max(STRIDE * 8, canvas.clientWidth - 56);
  let x = 0;
  let y = 0;
  let rowH = 0;
  groups = seeds.map((g) => {
    const cells = Math.max(1, Math.round(g.n / baseUnit));
    const cols = Math.max(1, Math.ceil(Math.sqrt(cells * 1.5)));
    const rows = Math.ceil(cells / cols);
    const gw = cols * STRIDE - GAP;
    const gh = rows * STRIDE - GAP;
    if (x > 0 && x + gw > rowLimit) {
      x = 0;
      y += rowH + 22;
      rowH = 0;
    }
    const box = { ...g, cells, x, y: y + 18, cols, rows, gw, gh };
    x += gw + 18;
    rowH = Math.max(rowH, gh + 16);
    return box;
  });
}

function bounds(list) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const g of list) {
    minX = Math.min(minX, g.x);
    minY = Math.min(minY, g.y - 16);
    maxX = Math.max(maxX, g.x + g.gw);
    maxY = Math.max(maxY, g.y + g.gh);
  }
  if (!list.length) return { minX: 0, minY: 0, w: 1, h: 1 };
  return { minX, minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

function frameOf(list, cap) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!list.length) return { x: 28, y: 28, s: homeS };
  const b = bounds(list);
  let s = Math.min((w - 48) / b.w, (h - 48) / b.h);
  if (cap) s = Math.min(s, homeS);
  return { s, x: (w - b.w * s) / 2 - b.minX * s, y: (h - b.h * s) / 2 - b.minY * s };
}

function homeCamera() {
  if (!groups.length) return { x: 28, y: 28, s: homeS };
  const b = bounds(groups);
  return { s: homeS, x: 28 - b.minX * homeS, y: 28 - b.minY * homeS };
}

function aim(snap) {
  if (mode === "zoom") camTo = frameOf(groups, false);
  else if (mode === "side") camTo = frameOf(groups, true);
  else camTo = homeCamera();
  document.getElementById("mode-scale").classList.toggle("on", mode === "scale");
  document.getElementById("mode-side").classList.toggle("on", mode === "side");
  if (snap) {
    cam = { ...camTo };
    draw();
  } else animate();
}

function animate() {
  if (animating) return;
  animating = true;
  const step = () => {
    cam.x += (camTo.x - cam.x) * 0.045;
    cam.y += (camTo.y - cam.y) * 0.045;
    cam.s += (camTo.s - cam.s) * 0.045;
    draw();
    const done = Math.abs(cam.s - camTo.s) < 0.004
      && Math.abs(cam.x - camTo.x) < 0.5
      && Math.abs(cam.y - camTo.y) < 0.5;
    if (done) {
      cam = { ...camTo };
      draw();
      animating = false;
    } else requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function layout(opts = {}) {
  sizeCanvas();
  layoutGroups();
  aim(!opts.animate);
  renderReadout();
  renderLadder();
  renderLegend();
  renderFilters();
  document.getElementById("scale-readout").textContent = `1 box = ${baseUnit.toLocaleString()} ${unit}`;
}

function paintMark(x, y, span, accent) {
  const splits = Math.max(1, Math.floor(span / 3.25));
  if (splits === 1) {
    ctx.fillRect(x, y, span, span);
    if (accent) {
      ctx.fillStyle = accent;
      ctx.fillRect(x, y, span, Math.max(1, span * 0.22));
    }
    return;
  }
  const gap = Math.min(1, span / splits * 0.2);
  const size = (span - gap * (splits - 1)) / splits;
  const step = size + gap;
  for (let iy = 0; iy < splits; iy += 1) {
    for (let ix = 0; ix < splits; ix += 1) {
      ctx.fillRect(x + ix * step, y + iy * step, size, size);
    }
  }
  if (accent) {
    ctx.fillStyle = accent;
    ctx.fillRect(x, y, span, Math.max(1, size * 0.35));
  }
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.textBaseline = "top";
  const mosaic = !LADDER[depth].key;
  const key = paintKey();
  const labels = [];
  const span = CELL * cam.s;
  const viewL = -cam.x / cam.s - STRIDE;
  const viewT = -cam.y / cam.s - STRIDE;
  const viewR = (w - cam.x) / cam.s + STRIDE;
  const viewB = (h - cam.y) / cam.s + STRIDE;
  for (const g of groups) {
    const hot = hover === g;
    const title = clusterLabel(LADDER[depth].key || "version", g.value, g.fps);
    labels.push({
      text: title,
      x: cam.x + g.x * cam.s,
      y: cam.y + g.y * cam.s - 14,
      w: g.gw * cam.s,
      hot,
    });
    if (g.x + g.gw < viewL || g.y + g.gh < viewT || g.x > viewR || g.y > viewB) continue;
    let i = 0;
    g.fps.forEach((fp, fi) => {
      let n = fi === g.fps.length - 1 ? g.cells - i : Math.round((fp.n / g.n) * g.cells);
      n = Math.max(0, Math.min(n, g.cells - i));
      const lab = labelOf(fp);
      const fill = mosaic ? (colorOf[`${key}:${fp[key]}`] || "#8e8a82") : g.color;
      ctx.fillStyle = fill;
      for (let k = 0; k < n; k += 1) {
        const idx = i + k;
        const cx = g.x + (idx % g.cols) * STRIDE;
        const cy = g.y + Math.floor(idx / g.cols) * STRIDE;
        if (cx < viewL || cy < viewT || cx > viewR || cy > viewB) continue;
        paintMark(cam.x + cx * cam.s, cam.y + cy * cam.s, span, lab ? lab.color : null);
        if (lab) ctx.fillStyle = fill;
      }
      i += n;
    });
    if (hot) {
      ctx.strokeStyle = "#e6e1d4";
      ctx.lineWidth = 1;
      ctx.strokeRect(cam.x + (g.x - 1) * cam.s, cam.y + (g.y - 1) * cam.s, (g.gw + 2) * cam.s, (g.gh + 2) * cam.s);
    }
  }
  ctx.font = '12px "IBM Plex Mono", ui-monospace, monospace';
  ctx.textBaseline = "top";
  const placed = [];
  labels.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const lab of labels) {
    const tw = ctx.measureText(lab.text).width;
    if (lab.y < 2 || tw > lab.w - 2) continue;
    const hits = placed.some((p) => lab.x < p.r + 6 && lab.x + tw > p.l - 6 && Math.abs(lab.y - p.y) < 13);
    if (hits) continue;
    ctx.fillStyle = lab.hot ? "#e6e1d4" : "#8d887b";
    ctx.fillText(lab.text, lab.x, lab.y);
    placed.push({ l: lab.x, r: lab.x + tw, y: lab.y });
  }
}

function groupAt(px, py) {
  const x = (px - cam.x) / cam.s;
  const y = (py - cam.y) / cam.s;
  for (const g of groups) {
    if (x >= g.x && y >= g.y && x <= g.x + g.gw && y <= g.y + g.gh) return g;
  }
  return null;
}

function setDepth(next) {
  depth = Math.max(0, Math.min(LADDER.length - 1, next));
  const allowed = new Set(LADDER.slice(1, depth).map((l) => l.key));
  for (const step of path) {
    if (!allowed.has(step.key)) filters[step.key].delete(step.value);
  }
  path = path.filter((p) => allowed.has(p.key));
  hover = null;
  if (mode === "zoom") mode = depth === 0 ? "scale" : "side";
  layout({ animate: true });
}

function dive(group) {
  const spec = LADDER[depth];
  const screen = {
    x: cam.x + group.x * cam.s,
    y: cam.y + (group.y - 16) * cam.s,
    w: Math.max(8, group.gw * cam.s),
    h: Math.max(8, (group.gh + 16) * cam.s),
  };
  const canDescend = spec.key && depth < LADDER.length - 1;
  if (canDescend) {
    filters[spec.key].clear();
    filters[spec.key].add(group.value);
    path = path.filter((p) => p.key !== spec.key);
    path.push({ key: spec.key, value: group.value });
    depth += 1;
  }
  mode = "zoom";
  hover = null;
  sizeCanvas();
  layoutGroups();
  if (!canDescend) hover = groups.find((g) => g.value === group.value) || null;
  const b = bounds(canDescend ? groups : [group]);
  const s0 = Math.min(screen.w / b.w, screen.h / b.h);
  cam = { s: s0, x: screen.x - b.minX * s0, y: screen.y - b.minY * s0 };
  camTo = frameOf(canDescend ? groups : groups.filter((g) => g.value === group.value), false);
  document.getElementById("mode-scale").classList.remove("on");
  document.getElementById("mode-side").classList.remove("on");
  renderReadout();
  renderLadder();
  renderLegend();
  renderFilters();
  animate();
}

function shareText(n) {
  const p = total ? n / total : 0;
  const oneIn = oneInCount(p);
  return { p, oneIn: oneIn == null ? "—" : oneIn };
}

function renderLegend() {
  const el = document.getElementById("legend");
  const key = paintKey();
  const facet = FACETS.find((f) => f[0] === key);
  const name = document.createElement("span");
  name.className = "legend-name";
  name.textContent = depth === 0 ? "Color is version" : key === "state"
    ? "Code is version · sequence · lock · script · sighash · rune"
    : `Color is ${facet ? facet[1].toLowerCase() : "one fingerprint"}`;
  el.innerHTML = "";
  el.append(name);
  if (key === "state") return;
  const counts = new Map();
  for (const fp of payload.fingerprints.filter(passes)) {
    if (fp[key] == null || fp[key] === "") continue;
    counts.set(fp[key], (counts.get(fp[key]) || 0) + fp.n);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  ranked.slice(0, 8).forEach(([value]) => {
    const span = document.createElement("span");
    const sw = document.createElement("i");
    sw.style.background = colorOf[`${key}:${value}`] || "#8e8a82";
    span.append(sw, document.createTextNode(facetLabel(key, value)));
    el.append(span);
  });
  if (ranked.length > 8) {
    const more = document.createElement("span");
    more.textContent = `+${ranked.length - 8} more`;
    el.append(more);
  }
}

function mixRow(key, value, p, text) {
  const row = document.createElement("div");
  row.className = "mix-row";
  const name = document.createElement("span");
  name.textContent = text || facetLabel(key, value);
  if (value != null) name.title = tipFor(key, value);
  const bar = document.createElement("span");
  bar.className = "mix-bar";
  const fill = document.createElement("i");
  fill.style.width = `${Math.max(1.5, Math.min(100, p * 100))}%`;
  if (value != null && colorOf[`${key}:${value}`]) fill.style.background = colorOf[`${key}:${value}`];
  bar.append(fill);
  const pct = document.createElement("span");
  pct.className = "pct";
  pct.textContent = p >= 0.995 ? "100%" : `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`;
  row.append(name, bar, pct);
  return row;
}

function renderMix(fps) {
  const el = document.getElementById("sel-mix");
  el.replaceChildren();
  const totalN = fps.reduce((sum, row) => sum + row.n, 0) || 1;
  const fixed = [];
  const blocks = [];
  for (const [key, title] of FACETS) {
    const counts = new Map();
    for (const fp of fps) {
      if (fp[key] == null || fp[key] === "") continue;
      counts.set(fp[key], (counts.get(fp[key]) || 0) + fp.n);
    }
    if (!counts.size) continue;
    if (counts.size === 1) {
      fixed.push(facetLabel(key, [...counts.keys()][0]));
      continue;
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const block = document.createElement("div");
    block.className = "mix-facet";
    const h = document.createElement("h2");
    h.textContent = title;
    block.append(h);
    ranked.slice(0, 4).forEach(([value, n]) => block.append(mixRow(key, value, n / totalN)));
    const rest = ranked.slice(4).reduce((sum, [, n]) => sum + n, 0);
    if (rest) block.append(mixRow(key, null, rest / totalN, "rest"));
    blocks.push(block);
  }
  if (!blocks.length) return;
  const head = document.createElement("p");
  head.className = "kicker";
  head.textContent = "Composition";
  el.append(head);
  if (fixed.length) {
    const line = document.createElement("p");
    line.className = "fixed";
    line.textContent = fixed.join(" · ");
    el.append(line);
  }
  blocks.forEach((block) => el.append(block));
}

function renderReadout() {
  const chosen = [];
  for (const [key, set] of Object.entries(filters)) {
    if (set.size) chosen.push([...set].map((v) => facetLabel(key, v)).join(" or "));
  }
  const glue = join === "or" ? " or " : " · ";
  const matched = payload.fingerprints.filter(passes);
  const fallback = matched.length === 1 ? fingerprintCode(matched[0]) : (chosen.join(glue) || `All ${unit}`);
  const target = hover
    ? { title: clusterLabel(LADDER[depth].key, hover.value, hover.fps), n: hover.n, fps: hover.fps }
    : { title: fallback, n: viewN, fps: matched };
  const title = document.getElementById("sel-title");
  title.textContent = target.title || `All ${unit}`;
  title.classList.toggle("code", typeof target.title === "string" && target.title.includes("·"));
  title.title = hover && LADDER[depth].key ? tipFor(LADDER[depth].key, hover.value) : "";
  const { p, oneIn } = shareText(target.n);
  document.getElementById("sel-ratio").textContent = typeof oneIn === "number" ? `1 out of ${oneIn.toLocaleString()}` : "—";
  document.getElementById("sel-share").textContent = `${target.n.toLocaleString()} ${unit} · ${(p * 100).toFixed(2)}%`;
  const note = document.getElementById("sel-note");
  const mix = document.getElementById("sel-mix");
  let noteText = "";
  if (hover && hover.value === "other") noteText = tipFor(LADDER[depth].key, hover.value);
  else if (hover && hover.value === "v_other") noteText = TIP.v_other;
  if (hover && hover.fps.length === 1) {
    const words = fingerprintWords(hover.fps[0]).join(" · ");
    noteText = noteText ? `${noteText} ${words}` : words;
  } else if (!hover && matched.length === 1) noteText = fingerprintWords(matched[0]).join(" · ");
  note.textContent = noteText;
  if (hover && hover.fps.length > 1) renderMix(hover.fps);
  else mix.replaceChildren();
  const dl = document.getElementById("sel-attrs");
  dl.innerHTML = "";
  if (hover || !target.n) return;
  for (const [key, name] of FACETS) {
    const picked = filters[key];
    const mode = modeWithin(target.fps, key);
    if ((!picked || !picked.size) && !mode) continue;
    const dt = document.createElement("dt");
    dt.textContent = name;
    const dd = document.createElement("dd");
    if (picked && picked.size) {
      dt.className = "on";
      dd.className = "on";
      dd.textContent = [...picked].map((v) => facetLabel(key, v)).join(" or ");
    } else {
      dd.textContent = `${facetLabel(key, mode.value)}  ${(100 * mode.n / target.n).toFixed(1)}%`;
      dd.title = tipFor(key, mode.value);
    }
    dl.append(dt, dd);
  }
}

function modeWithin(fps, key) {
  const counts = new Map();
  for (const fp of fps) {
    const value = fp[key];
    if (value == null || value === "") continue;
    counts.set(value, (counts.get(value) || 0) + fp.n);
  }
  let value = null;
  let n = -1;
  for (const [candidate, count] of counts) {
    if (count > n) {
      value = candidate;
      n = count;
    }
  }
  return value == null ? null : { value, n };
}

function renderLadder() {
  const nav = document.getElementById("ladder");
  nav.replaceChildren();
  LADDER.forEach((step, i) => {
    const b = document.createElement("button");
    b.type = "button";
    const picked = step.key && path.find((p) => p.key === step.key);
    b.className = i === depth ? "on" : picked ? "reached" : "";
    if (i === depth) b.setAttribute("aria-current", "step");
    const name = document.createElement("span");
    name.textContent = step.title;
    b.append(name);
    if (picked) {
      const val = document.createElement("small");
      val.textContent = facetLabel(step.key, picked.value);
      val.title = tipFor(step.key, picked.value);
      b.append(val);
    }
    b.onclick = () => setDepth(i);
    nav.append(b);
  });
}

function renderFilters() {
  const root = document.getElementById("filters");
  root.innerHTML = "";
  for (const [key, title] of FACETS) {
    const counts = new Map();
    for (const fp of payload.fingerprints) {
      if (fp[key] == null || fp[key] === "") continue;
      counts.set(fp[key], (counts.get(fp[key]) || 0) + fp.n);
    }
    const facet = document.createElement("div");
    const stepOn = LADDER[depth] && LADDER[depth].key === key;
    const picked = path.some((p) => p.key === key);
    facet.className = stepOn || picked || filters[key].size ? "facet on" : "facet";
    const h = document.createElement("h2");
    h.textContent = title;
    const opts = document.createElement("div");
    opts.className = "opts";
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const shown = ranked.slice(0, 8);
    for (const value of filters[key]) {
      if (!shown.some(([v]) => v === value)) shown.push([value, counts.get(value) || 0]);
    }
    shown.forEach(([value, n]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = facetLabel(key, value);
      b.className = filters[key].has(value) ? "on" : "";
      b.title = `${tipFor(key, value)} · ${(100 * n / total).toFixed(1)}%`;
      b.onclick = () => {
        const step = path.find((p) => p.key === key);
        if (filters[key].has(value)) filters[key].delete(value);
        else filters[key].add(value);
        if (step && !(filters[key].size === 1 && filters[key].has(step.value))) {
          path = path.filter((p) => p.key !== key);
        }
        layout();
      };
      opts.append(b);
    });
    facet.append(h, opts);
    root.append(facet);
  }
}

function renderLabels() {
  const ul = document.getElementById("labels");
  ul.innerHTML = "";
  labels.forEach((label, i) => {
    const li = document.createElement("li");
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = label.color;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = label.name;
    name.onclick = () => {
      path = label.path.map((s) => ({ ...s }));
      FACETS.forEach(([k]) => filters[k].clear());
      for (const [k, vals] of Object.entries(label.filters || {})) {
        if (filters[k]) vals.forEach((v) => filters[k].add(v));
      }
      path = path.filter((step) => filters[step.key]);
      for (const step of path) filters[step.key].add(step.value);
      join = label.join || "and";
      document.getElementById("join-and").classList.toggle("on", join === "and");
      document.getElementById("join-or").classList.toggle("on", join === "or");
      depth = path.reduce((deepest, step) => {
        const i = LADDER.findIndex((level) => level.key === step.key);
        return i >= 0 ? Math.max(deepest, i + 1) : deepest;
      }, 0);
      layout();
    };
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Remove";
    del.onclick = () => {
      labels.splice(i, 1);
      localStorage.setItem("fp-labels", JSON.stringify(labels));
      renderLabels();
      layout();
    };
    li.append(sw, name, del);
    ul.append(li);
  });
}

canvas.addEventListener("mousemove", (e) => {
  const r = canvas.getBoundingClientRect();
  const g = groupAt(e.clientX - r.left, e.clientY - r.top);
  if (g !== hover) {
    hover = g;
    draw();
    renderReadout();
  }
});
canvas.addEventListener("mouseleave", () => {
  hover = null;
  draw();
  renderReadout();
});
canvas.addEventListener("click", (e) => {
  const r = canvas.getBoundingClientRect();
  const g = groupAt(e.clientX - r.left, e.clientY - r.top);
  if (g) dive(g);
});
let wheelDepth = 0;

function wheelPixels(e) {
  const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
  return { x: e.deltaX * scale, y: e.deltaY * scale };
}

canvas.addEventListener("wheel", (e) => {
  if (e.target !== canvas) return;
  const { x, y } = wheelPixels(e);
  if (e.ctrlKey) {
    e.preventDefault();
    wheelDepth += y;
    if (Math.abs(wheelDepth) < 180) return;
    const dir = wheelDepth > 0 ? 1 : -1;
    wheelDepth = 0;
    setDepth(depth + dir);
    return;
  }
  wheelDepth = 0;
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  cam.x -= x;
  cam.y -= y;
  camTo.x -= x;
  camTo.y -= y;
  hover = groupAt(e.clientX - rect.left, e.clientY - rect.top);
  draw();
  renderReadout();
}, { passive: false });

document.getElementById("label-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("label-name");
  const name = input.value.trim();
  if (!name) return;
  const spec = {};
  for (const [k, set] of Object.entries(filters)) spec[k] = [...set];
  labels.push({
    name,
    color: LABEL_COLORS[labels.length % LABEL_COLORS.length],
    path: path.map((s) => ({ ...s })),
    filters: spec,
    join,
  });
  localStorage.setItem("fp-labels", JSON.stringify(labels));
  input.value = "";
  renderLabels();
  layout();
});

function setJoin(next) {
  join = next;
  document.getElementById("join-and").classList.toggle("on", join === "and");
  document.getElementById("join-or").classList.toggle("on", join === "or");
  layout();
}
document.getElementById("join-and").onclick = () => setJoin("and");
document.getElementById("join-or").onclick = () => setJoin("or");

document.getElementById("mode-scale").onclick = () => {
  mode = "scale";
  layout({ animate: true });
};
document.getElementById("mode-side").onclick = () => {
  mode = "side";
  layout({ animate: true });
};

window.addEventListener("resize", () => layout());
new ResizeObserver(() => {
  const key = `${canvas.clientWidth}x${canvas.clientHeight}`;
  if (key !== sizedFor && payload) layout();
}).observe(canvas);

fetch("fingerprints.json").then((r) => r.json()).then((data) => {
  payload = data;
  payload.fingerprints = collapsePrints(data.fingerprints);
  total = data.total;
  unit = data.unit || "transactions";
  assignColors();
  document.getElementById("window").textContent = windowLine(data);
  renderFilters();
  renderLabels();
  layout();
});

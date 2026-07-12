/* ============================================================
   AgroDesign 3D Navigator
   Mapa 3D navegable estilo vuelo de dron con conmutación entre
   paisaje actual y diseño multifuncional. Multi-campo vía
   data/campos.json (?campo=id).
   ============================================================ */
"use strict";

/* ---------- Configuración de clases de paisaje ---------- */
const CLASS_META = {
  "agri":        { label: "Agrícola Secano",            legend: "#d9c98a" },
  "zona1":       { label: "Agrícola Secano · Zona 1",   legend: "#2e7d32" },
  "zona2":       { label: "Agrícola Secano · Zona 2",   legend: "#66bb6a" },
  "zona3":       { label: "Agrícola Secano · Zona 3",   legend: "#9ccc65" },
  "parche-le":   { label: "Parche Leñoso",              legend: "#1b4020" },
  "corr-le":     { label: "Corredor Leñoso",            legend: "#2f5d33" },
  "parche-herb": { label: "Parche Herbáceo",            legend: "#a9b284" },
  "corr-herb":   { label: "Corredor Herbáceo",          legend: "#b7bfa0" },
  "otros":       { label: "Otros",                      legend: "#9e9e9e" }
};
const NATURE_CLASSES = ["parche-le", "corr-le", "parche-herb", "corr-herb"];
const WOODY_CLASSES = ["parche-le", "corr-le"];
const HERB_CLASSES = ["parche-herb", "corr-herb"];

function classInicial(props) {
  switch (props.RASTER) {
    case 11: return "parche-le";
    case 12: return "corr-le";
    case 21: return "parche-herb";
    case 31: return "agri";
    default: return "otros";
  }
}
function classMulti(props) {
  const u = props.Unidad || "";
  if (u === "otros-parches") return "otros";
  if (CLASS_META[u]) return u;
  return "otros";
}

/* Paleta de monte de espinal: canopia (abajo) y corona (arriba, más luminosa) */
const CANOPY_COLORS = ["#1e3d1a", "#2a4f22", "#33602a", "#3e6d2f", "#4a7434", "#5c763a"];
const MID_COLORS    = ["#254a1f", "#316027", "#3c6c2f", "#487a35", "#54823b", "#688241"];
const CROWN_COLORS  = ["#316026", "#3e7030", "#4a8038", "#578e40", "#659647", "#7c964f"];
/* Arbustos del pastizal florecido (tonos salvia/lavanda de la foto de dron) */
const SHRUB_COLORS  = ["#7d8a5e", "#8a9370", "#9aa285", "#a2a3b0"];
const WOODY_BASE = { color: "#2e5026", height: 1.2, opacity: 0.45 };
const HERB_HEIGHT = 0.9;

/* ---------- Utilidades geométricas ---------- */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ringBBox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function pointInRing(pt, ring) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(pt, polygon) {
  if (!pointInRing(pt, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) if (pointInRing(pt, polygon[i])) return false;
  return true;
}

function ringAreaHa(ring, latRef) {
  const kx = 111320 * Math.cos((latRef * Math.PI) / 180), ky = 110574;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[j][1] * ky);
  }
  return Math.abs(a / 2) / 10000;
}

function featureCentroid(feature) {
  let best = null, bestArea = -1;
  for (const poly of feature.geometry.coordinates) {
    const a = ringAreaHa(poly[0], poly[0][0][1]);
    if (a > bestArea) { bestArea = a; best = poly[0]; }
  }
  let sx = 0, sy = 0;
  for (const [x, y] of best) { sx += x; sy += y; }
  return [sx / best.length, sy / best.length];
}

/* Polígono orgánico lobulado alrededor de un punto (radio en metros) */
function blobRing(lon, lat, rMeters, rng, verts = 8, jitter = 0.55) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110574;
  const ring = [];
  const rot = rng() * Math.PI * 2;
  for (let i = 0; i < verts; i++) {
    const ang = rot + (i * Math.PI * 2) / verts;
    const r = rMeters * (1 - jitter / 2 + rng() * jitter);
    ring.push([lon + (Math.cos(ang) * r) / kx, lat + (Math.sin(ang) * r) / ky]);
  }
  ring.push(ring[0]);
  return [ring];
}

/* Desplaza un anillo en metros (para sombras) */
function offsetRing(polygon, dxM, dyM, lat) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110574;
  return [polygon[0].map(([x, y]) => [x + dxM / kx, y + dyM / ky])];
}

/* Scatter determinístico de puntos dentro de los polígonos de ciertas clases */
function scatterInClasses(fc, classes, seed, densityPerHa, maxTotal, minPerPoly) {
  const rng = mulberry32(seed);
  const polys = [];
  for (const f of fc.features) {
    if (!classes.includes(f.properties._cls)) continue;
    for (const poly of f.geometry.coordinates) {
      const bbox = ringBBox(poly[0]);
      const ha = ringAreaHa(poly[0], (bbox[1] + bbox[3]) / 2);
      if (ha > 0.003) polys.push({ polygon: poly, bbox, ha });
    }
  }
  const totalHa = polys.reduce((s, p) => s + p.ha, 0);
  const density = Math.min(densityPerHa, maxTotal / Math.max(totalHa, 0.001));
  const points = [];
  for (const wp of polys) {
    const n = Math.max(minPerPoly, Math.round(wp.ha * density));
    const [minX, minY, maxX, maxY] = wp.bbox;
    let placed = 0, attempts = 0;
    while (placed < n && attempts < n * 60) {
      attempts++;
      const pt = [minX + rng() * (maxX - minX), minY + rng() * (maxY - minY)];
      if (!pointInPolygon(pt, wp.polygon)) continue;
      placed++;
      points.push(pt);
    }
  }
  return { points, rng };
}

/* ---------- Generación procedural de vegetación ---------- */
/* Árboles: cada uno = canopia ancha + corona alta (extrusiones) + sombra al piso */
function generateTrees(fc, seed) {
  const { points, rng } = scatterInClasses(fc, WOODY_CLASSES, seed, 55, 4200, 3);
  const trees = [], shadows = [];
  // tres niveles apilados para una silueta de copa redondeada
  const TIERS = [
    { rF: 0.85, b0: 0.18, b1: 0.55, k: "canopy", verts: 10 },
    { rF: 0.66, b0: 0.45, b1: 0.82, k: "mid",    verts: 9 },
    { rF: 0.40, b0: 0.72, b1: 1.00, k: "crown",  verts: 8 }
  ];
  for (const [lon, lat] of points) {
    const r = 3.4 + rng() * 3.4;               // radio de copa 3.4–6.8 m
    const h = 5 + rng() * 9;                   // altura total 5–14 m
    const c = Math.floor(rng() * CANOPY_COLORS.length);
    for (const t of TIERS) {
      trees.push({
        type: "Feature",
        properties: { b: +(h * t.b0).toFixed(1), h: +(h * t.b1).toFixed(1), c, k: t.k },
        geometry: { type: "Polygon", coordinates: blobRing(lon, lat, r * t.rF, rng, t.verts, 0.5) }
      });
    }
    // sombra proyectada (sol NO -> sombra SE)
    shadows.push({
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: offsetRing(blobRing(lon, lat, r * 1.2, rng, 7, 0.4), 2.4, -1.8, lat) }
    });
  }
  return {
    trees: { type: "FeatureCollection", features: trees },
    shadows: { type: "FeatureCollection", features: shadows }
  };
}

/* Arbustos y matas florecidas dentro de parches/corredores herbáceos */
function generateShrubs(fc, seed) {
  const { points, rng } = scatterInClasses(fc, HERB_CLASSES, seed, 14, 3200, 2);
  const shrubs = [];
  for (const [lon, lat] of points) {
    const r = 1.4 + rng() * 2.4;
    const h = 0.8 + rng() * 1.5;
    shrubs.push({
      type: "Feature",
      properties: { h: +h.toFixed(1), c: Math.floor(rng() * SHRUB_COLORS.length) },
      geometry: { type: "Polygon", coordinates: blobRing(lon, lat, r, rng, 7, 0.6) }
    });
  }
  return { type: "FeatureCollection", features: shrubs };
}

/* ---------- Estado global ---------- */
const params = new URLSearchParams(location.search);
const DEBUG = params.has("debug");

const state = {
  scenario: "inicial",
  campo: null,
  data: { inicial: null, multi: null },
  stats: { inicial: {}, multi: {} },
  bbox: null,
  tour: { running: false, timer: null },
  orbit: { running: false, raf: null },
  growth: { inicial: 1, multi: 0 },
  anim: null
};

let HOME_VIEW = { center: [-63.7885, -33.865], zoom: 12.6, pitch: 58, bearing: 15 };

/* ---------- Estilo base del mapa ---------- */
const mapStyle = {
  version: 8,
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    esri: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 18,
      attribution: "Imagen satelital © Esri, Maxar, Earthstar Geographics | AgroDesign"
    },
    terrain: {
      type: "raster-dem",
      tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
      tileSize: 256,
      encoding: "terrarium",
      maxzoom: 12
    }
  },
  layers: [{ id: "satellite", type: "raster", source: "esri" }],
  sky: {
    "sky-color": "#87b9e0",
    "horizon-color": "#dfe9d8",
    "fog-color": "#e6ecdc",
    "sky-horizon-blend": 0.6,
    "horizon-fog-blend": 0.65,
    "fog-ground-blend": 0.85
  },
  terrain: { source: "terrain", exaggeration: 1.5 }
};

const map = new maplibregl.Map({
  container: "map",
  style: mapStyle,
  preserveDrawingBuffer: DEBUG,
  center: HOME_VIEW.center,
  zoom: 11.4,
  pitch: 0,
  bearing: 0,
  maxPitch: 80,
  minZoom: 9.5,
  maxZoom: 17.8,
  attributionControl: { compact: true }
});
if (DEBUG) { window.__map = map; window.__mapStyle = mapStyle; window.__state = state; }
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
map.touchZoomRotate.enableRotation();

/* ---------- Carga de configuración y datos ---------- */
async function loadCampos() {
  const cfg = await fetch("data/campos.json").then(r => r.json());
  const wanted = params.get("campo") || cfg.default;
  state.campo = cfg.campos.find(c => c.id === wanted) || cfg.campos[0];

  const sel = document.getElementById("campo-select");
  sel.innerHTML = "";
  for (const c of cfg.campos) {
    const opt = document.createElement("option");
    opt.value = c.id; opt.textContent = c.nombre;
    if (c.id === state.campo.id) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => {
    const q = new URLSearchParams(location.search);
    q.set("campo", sel.value);
    location.search = q.toString();
  });

  document.getElementById("brand-campo").textContent = `${state.campo.nombre} · Navegador 3D`;
  document.getElementById("splash-campo").textContent = state.campo.nombre;
  document.title = `AgroDesign · Navegador 3D · ${state.campo.nombre}`;
}

async function loadData() {
  const [ini, multi] = await Promise.all([
    fetch(state.campo.inicial).then(r => r.json()),
    fetch(state.campo.multifuncional).then(r => r.json())
  ]);
  for (const f of ini.features) f.properties._cls = classInicial(f.properties);
  for (const f of multi.features) f.properties._cls = classMulti(f.properties);
  state.data.inicial = ini;
  state.data.multi = multi;
  computeStats();
  computeHomeView();
}

function computeStats() {
  for (const [key, fc] of [["inicial", state.data.inicial], ["multi", state.data.multi]]) {
    const sums = {};
    for (const f of fc.features) {
      const cls = f.properties._cls;
      sums[cls] = (sums[cls] || 0) + (f.properties.Sup || 0);
    }
    state.stats[key] = sums;
  }
}

/* Vista inicial y límites derivados del bbox de los datos del campo */
function computeHomeView() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const fc of [state.data.inicial, state.data.multi]) {
    for (const f of fc.features) {
      for (const poly of f.geometry.coordinates) {
        const [a, b, c, d] = ringBBox(poly[0]);
        if (a < minX) minX = a; if (b < minY) minY = b;
        if (c > maxX) maxX = c; if (d > maxY) maxY = d;
      }
    }
  }
  state.bbox = [[minX, minY], [maxX, maxY]];
  const cam = map.cameraForBounds(state.bbox, { padding: 80 });
  HOME_VIEW = { center: [(minX + maxX) / 2, (minY + maxY) / 2], zoom: (cam ? cam.zoom : 12.6) - 0.1, pitch: 58, bearing: 15 };
  const padX = Math.max(0.35, (maxX - minX)), padY = Math.max(0.3, (maxY - minY));
  map.setMaxBounds([[minX - padX, minY - padY], [maxX + padX, maxY + padY]]);
  map.jumpTo({ center: HOME_VIEW.center, zoom: HOME_VIEW.zoom - 1.2, pitch: 0, bearing: 0 });
}

function natureHa(key) {
  return NATURE_CLASSES.reduce((s, c) => s + (state.stats[key][c] || 0), 0);
}

const clsFilter = (...classes) => ["in", ["get", "_cls"], ["literal", classes]];
const colorMatch = (palette) => {
  const m = ["match", ["get", "c"]];
  palette.forEach((col, i) => { if (i < palette.length - 1) m.push(i, col); });
  m.push(palette[palette.length - 1]);
  return m;
};

function addScenarioLayers() {
  const ini = state.data.inicial, multi = state.data.multi;

  map.addSource("ini", { type: "geojson", data: ini });
  map.addSource("multi", { type: "geojson", data: multi });

  const iniVeg = generateTrees(ini, 20260711);
  const multiVeg = generateTrees(multi, 47110226);
  map.addSource("ini-trees", { type: "geojson", data: iniVeg.trees });
  map.addSource("ini-shadows", { type: "geojson", data: iniVeg.shadows });
  map.addSource("multi-trees", { type: "geojson", data: multiVeg.trees });
  map.addSource("multi-shadows", { type: "geojson", data: multiVeg.shadows });
  map.addSource("ini-shrubs", { type: "geojson", data: generateShrubs(ini, 11223344) });
  map.addSource("multi-shrubs", { type: "geojson", data: generateShrubs(multi, 55667788) });

  for (const p of ["ini", "multi"]) {
    const isMulti = p === "multi";
    const src = p;

    if (isMulti) {
      map.addLayer({
        id: "multi-zona-fill", type: "fill", source: src,
        filter: clsFilter("zona1", "zona2", "zona3"),
        paint: {
          "fill-color": ["match", ["get", "_cls"],
            "zona1", CLASS_META.zona1.legend,
            "zona2", CLASS_META.zona2.legend,
            CLASS_META.zona3.legend],
          "fill-opacity": 0
        }
      });
      map.addLayer({
        id: "multi-zona-line", type: "line", source: src,
        filter: clsFilter("zona1", "zona2", "zona3"),
        paint: {
          "line-color": ["match", ["get", "_cls"], "zona1", "#7ddf8a", "zona2", "#a8e6a0", "#c8eeb0"],
          "line-width": 1.6, "line-opacity": 0
        }
      });
    } else {
      map.addLayer({
        id: "ini-agri-line", type: "line", source: src,
        filter: clsFilter("agri"),
        paint: { "line-color": "#f3eecb", "line-width": 1.4, "line-opacity": 0 }
      });
    }

    // "Otros" (cascos, bajos): satélite visible, contorno punteado discreto
    map.addLayer({
      id: `${p}-otros-fill`, type: "fill", source: src,
      filter: clsFilter("otros"),
      paint: { "fill-color": "#c9c9b8", "fill-opacity": 0 }
    });
    map.addLayer({
      id: `${p}-otros-line`, type: "line", source: src,
      filter: clsFilter("otros"),
      paint: { "line-color": "#e8e6d5", "line-width": 1.2, "line-opacity": 0, "line-dasharray": [2.5, 2] }
    });

    // Pastizal: color salvia de lejos, textura fotográfica real de cerca
    map.addLayer({
      id: `${p}-herb-ext`, type: "fill-extrusion", source: src,
      filter: clsFilter("parche-herb", "corr-herb"),
      paint: {
        "fill-extrusion-color": ["match", ["get", "_cls"], "corr-herb", "#a3b183", "#96a873"],
        "fill-extrusion-height": 0,
        "fill-extrusion-opacity": 0
      }
    });
    map.addLayer({
      id: `${p}-herb-pattern`, type: "fill-extrusion", source: src,
      filter: clsFilter("parche-herb", "corr-herb"),
      paint: {
        "fill-extrusion-pattern": "pastizal",
        "fill-extrusion-height": 0,
        "fill-extrusion-opacity": 0
      }
    });
    // Matas y arbustos florecidos sobre el pastizal
    map.addLayer({
      id: `${p}-shrubs`, type: "fill-extrusion", source: `${p}-shrubs`,
      paint: {
        "fill-extrusion-color": colorMatch(SHRUB_COLORS),
        "fill-extrusion-height": 0,
        "fill-extrusion-opacity": 0,
        "fill-extrusion-vertical-gradient": true
      }
    });

    // Piso del monte + sombras + árboles en dos niveles
    map.addLayer({
      id: `${p}-woody-base`, type: "fill-extrusion", source: src,
      filter: clsFilter("parche-le", "corr-le"),
      paint: { "fill-extrusion-color": WOODY_BASE.color, "fill-extrusion-height": 0, "fill-extrusion-opacity": 0 }
    });
    map.addLayer({
      id: `${p}-tree-shadows`, type: "fill", source: `${p}-shadows`,
      paint: { "fill-color": "#0c1c08", "fill-opacity": 0 }
    });
    map.addLayer({
      id: `${p}-trees`, type: "fill-extrusion", source: `${p}-trees`,
      paint: {
        "fill-extrusion-color": ["case",
          ["==", ["get", "k"], "crown"], colorMatch(CROWN_COLORS),
          ["==", ["get", "k"], "mid"], colorMatch(MID_COLORS),
          colorMatch(CANOPY_COLORS)],
        "fill-extrusion-height": 0,
        "fill-extrusion-base": 0,
        "fill-extrusion-opacity": 0,
        "fill-extrusion-vertical-gradient": true
      }
    });
  }

  setupInteractivity();
}

/* Capas por escenario con su opacidad objetivo cuando el escenario está activo */
const SCENARIO_LAYERS = {
  inicial: [
    { id: "ini-agri-line", prop: "line-opacity", on: 0.55 },
    { id: "ini-otros-fill", prop: "fill-opacity", on: 0.06 },
    { id: "ini-otros-line", prop: "line-opacity", on: 0.5 },
    { id: "ini-herb-ext", prop: "fill-extrusion-opacity", on: 0.92 },
    { id: "ini-herb-pattern", prop: "fill-extrusion-opacity", on: 0.6, ramp: [13.8, 15.0] },
    { id: "ini-shrubs", prop: "fill-extrusion-opacity", on: 0.95 },
    { id: "ini-woody-base", prop: "fill-extrusion-opacity", on: WOODY_BASE.opacity },
    { id: "ini-tree-shadows", prop: "fill-opacity", on: 0.28 },
    { id: "ini-trees", prop: "fill-extrusion-opacity", on: 0.96 }
  ],
  multi: [
    { id: "multi-zona-fill", prop: "fill-opacity", on: 0.18 },
    { id: "multi-zona-line", prop: "line-opacity", on: 0.85 },
    { id: "multi-otros-fill", prop: "fill-opacity", on: 0.06 },
    { id: "multi-otros-line", prop: "line-opacity", on: 0.5 },
    { id: "multi-herb-ext", prop: "fill-extrusion-opacity", on: 0.92 },
    { id: "multi-herb-pattern", prop: "fill-extrusion-opacity", on: 0.6, ramp: [13.8, 15.0] },
    { id: "multi-shrubs", prop: "fill-extrusion-opacity", on: 0.95 },
    { id: "multi-woody-base", prop: "fill-extrusion-opacity", on: WOODY_BASE.opacity },
    { id: "multi-tree-shadows", prop: "fill-opacity", on: 0.28 },
    { id: "multi-trees", prop: "fill-extrusion-opacity", on: 0.96 }
  ]
};

/* Crecimiento 0..1 sobre las capas extruidas (los árboles "crecen") */
function applyGrowth(key, t) {
  state.growth[key] = t;
  const p = key === "inicial" ? "ini" : "multi";
  map.setPaintProperty(`${p}-trees`, "fill-extrusion-height", ["*", ["get", "h"], t]);
  map.setPaintProperty(`${p}-trees`, "fill-extrusion-base", ["*", ["get", "b"], t]);
  map.setPaintProperty(`${p}-shrubs`, "fill-extrusion-height", ["*", ["get", "h"], t]);
  map.setPaintProperty(`${p}-woody-base`, "fill-extrusion-height", WOODY_BASE.height * t);
  map.setPaintProperty(`${p}-herb-ext`, "fill-extrusion-height", HERB_HEIGHT * t);
  // levemente más alta para dibujarse por encima de la capa de color
  map.setPaintProperty(`${p}-herb-pattern`, "fill-extrusion-height", (HERB_HEIGHT + 0.06) * t);
}

function applyOpacity(key, t) {
  for (const l of SCENARIO_LAYERS[key]) {
    const v = l.on * t;
    // ramp: la capa recién aparece al acercarse (crossfade por zoom)
    map.setPaintProperty(l.id, l.prop, l.ramp
      ? ["interpolate", ["linear"], ["zoom"], l.ramp[0], 0, l.ramp[1], v]
      : v);
  }
}

const easeOutCubic = x => 1 - Math.pow(1 - x, 3);

/* ---------- Conmutación de escenario ---------- */
function setScenario(next, animate = true) {
  if (next === state.scenario) return;
  const prev = state.scenario;
  state.scenario = next;
  updatePanel();
  document.getElementById("sw-inicial").classList.toggle("active", next === "inicial");
  document.getElementById("sw-multi").classList.toggle("active", next === "multi");

  if (state.anim) cancelAnimationFrame(state.anim);
  if (!animate) {
    applyOpacity(prev, 0); applyGrowth(prev, 0);
    applyOpacity(next, 1); applyGrowth(next, 1);
    return;
  }

  const FADE_MS = 700, GROW_MS = 1800;
  const t0 = performance.now();
  const frame = now => {
    const dt = now - t0;
    const fade = Math.min(dt / FADE_MS, 1);
    const grow = easeOutCubic(Math.min(dt / GROW_MS, 1));
    applyOpacity(prev, 1 - fade);
    applyOpacity(next, fade);
    applyGrowth(prev, 1 - grow);
    applyGrowth(next, grow);
    if (dt < GROW_MS) state.anim = requestAnimationFrame(frame);
    else state.anim = null;
  };
  state.anim = requestAnimationFrame(frame);
}

/* ---------- Panel: leyenda y estadísticas ---------- */
const LEGEND_ORDER = {
  inicial: ["agri", "parche-le", "parche-herb", "corr-le", "otros"],
  multi: ["zona1", "zona2", "zona3", "parche-le", "parche-herb", "corr-le", "corr-herb", "otros"]
};

function fmtHa(v) {
  return v.toLocaleString("es-AR", { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + " ha";
}

function updatePanel() {
  const key = state.scenario;
  document.getElementById("panel-title").textContent = key === "inicial" ? "Paisaje Actual" : "Paisaje Multifuncional";
  document.getElementById("panel-sub").textContent = key === "inicial"
    ? `Composición actual de ${state.campo.nombre}`
    : "Propuesta de diseño AgroDesign: corredores biológicos y parches de naturaleza";

  const legend = document.getElementById("legend");
  legend.innerHTML = "";
  for (const cls of LEGEND_ORDER[key]) {
    const ha = state.stats[key][cls];
    if (!ha) continue;
    const li = document.createElement("li");
    li.innerHTML = `<span class="chip" style="background:${CLASS_META[cls].legend}"></span>${CLASS_META[cls].label}<span class="ha">${fmtHa(ha)}</span>`;
    legend.appendChild(li);
  }

  const before = natureHa("inicial"), after = natureHa("multi");
  document.getElementById("imp-before").textContent = fmtHa(before);
  document.getElementById("imp-after").textContent = fmtHa(after);
  const pct = Math.round(((after - before) / before) * 100);
  document.getElementById("imp-note").textContent =
    `El diseño multiplica la superficie destinada a biodiversidad (+${pct}%), conectando el paisaje con corredores biológicos sin resignar la matriz productiva.`;
}

/* ---------- Interactividad: popups ---------- */
function setupInteractivity() {
  const CLICKABLE = {
    inicial: ["ini-trees", "ini-woody-base", "ini-herb-ext", "ini-otros-fill"],
    multi: ["multi-trees", "multi-woody-base", "multi-herb-ext", "multi-zona-fill", "multi-otros-fill"]
  };

  map.on("click", e => {
    const layers = CLICKABLE[state.scenario].filter(id => map.getLayer(id));
    let feats = map.queryRenderedFeatures(e.point, { layers });
    feats = feats.filter(f => f.properties._cls);
    if (!feats.length) {
      const src = state.scenario === "inicial" ? state.data.inicial : state.data.multi;
      const pt = [e.lngLat.lng, e.lngLat.lat];
      const hit = src.features.find(f =>
        f.geometry.coordinates.some(poly => pointInPolygon(pt, poly)));
      if (hit) feats = [{ properties: hit.properties }];
    }
    if (!feats.length) return;
    const p = feats[0].properties;
    const meta = CLASS_META[p._cls] || CLASS_META.otros;
    const elemento = p.elementro || p.Elemento || "";
    new maplibregl.Popup({ closeButton: true, maxWidth: "260px" })
      .setLngLat(e.lngLat)
      .setHTML(`
        <div class="popup-title">${meta.label}</div>
        <div class="popup-sub">${elemento ? "Elemento: " + elemento : (state.scenario === "inicial" ? "Paisaje actual" : "Diseño propuesto")}</div>
        <div class="popup-ha">Superficie: <b>${fmtHa(p.Sup || 0)}</b></div>`)
      .addTo(map);
  });

  const hoverLayers = ["ini-woody-base", "ini-herb-ext", "multi-woody-base", "multi-herb-ext", "multi-zona-fill"];
  for (const id of hoverLayers) {
    map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
  }
}

/* ---------- Tour de dron (recorrido distinto en cada vuelo) ---------- */
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildTourWaypoints() {
  const multi = state.data.multi;
  const byArea = cls => multi.features
    .filter(f => f.properties._cls === cls)
    .sort((a, b) => (b.properties.Sup || 0) - (a.properties.Sup || 0));

  // pool: corredores y parches más relevantes, en orden aleatorio por corrida
  const corridors = shuffled(byArea("corr-herb").concat(byArea("corr-le")).slice(0, 6)).slice(0, 2);
  const patches = shuffled(byArea("parche-le").slice(0, 5)).slice(0, 2);
  const rnd = (a, b) => a + Math.random() * (b - a);

  const wp = [];
  wp.push({ center: HOME_VIEW.center, zoom: HOME_VIEW.zoom + 0.4, pitch: rnd(50, 60), bearing: rnd(-40, 40), duration: 6000, msg: "Sobrevolando el establecimiento" });
  if (corridors[0]) wp.push({ center: featureCentroid(corridors[0]), zoom: rnd(15.2, 15.6), pitch: rnd(68, 74), bearing: rnd(0, 360), duration: 8000, msg: "Descendiendo sobre un corredor biológico" });
  if (corridors[1]) wp.push({ center: featureCentroid(corridors[1]), zoom: rnd(15.6, 16.0), pitch: rnd(72, 76), bearing: rnd(0, 360), duration: 9000, msg: "Vuelo rasante sobre el corredor" });
  if (patches[0]) {
    const c = featureCentroid(patches[0]);
    const b = rnd(0, 360);
    wp.push({ center: c, zoom: rnd(15.4, 15.8), pitch: rnd(64, 70), bearing: b, duration: 8000, msg: "Aproximación al parche de monte" });
    wp.push({ center: c, zoom: rnd(15.4, 15.8), pitch: rnd(64, 70), bearing: b + 140, duration: 9000, msg: "Órbita sobre el parche leñoso" });
  }
  if (patches[1]) wp.push({ center: featureCentroid(patches[1]), zoom: rnd(15.0, 15.5), pitch: rnd(62, 70), bearing: rnd(0, 360), duration: 8000, msg: "Cruzando hacia otro parche de naturaleza" });
  wp.push({ center: HOME_VIEW.center, zoom: HOME_VIEW.zoom + 0.2, pitch: rnd(48, 56), bearing: rnd(-30, 30), duration: 8000, msg: "Vista general del paisaje rediseñado" });
  return wp;
}

function startTour() {
  stopOrbit();
  state.tour.running = true;
  state.tour.route = buildTourWaypoints();  // recorrido nuevo en cada vuelo
  state.tour.step = 0;
  document.getElementById("btn-tour").classList.add("active");
  document.getElementById("tour-banner").classList.add("visible");
  nextTourStep();
}

function nextTourStep() {
  if (!state.tour.running) return;
  if (state.tour.step >= state.tour.route.length) { stopTour(); return; }
  const wp = state.tour.route[state.tour.step++];
  document.getElementById("tour-banner").textContent = wp.msg;
  map.easeTo({ ...wp, easing: t => t * (2 - t), essential: false });
  state.tour.timer = setTimeout(nextTourStep, wp.duration + 400);
}

function stopTour() {
  if (!state.tour.running) return;
  state.tour.running = false;
  clearTimeout(state.tour.timer);
  document.getElementById("btn-tour").classList.remove("active");
  document.getElementById("tour-banner").classList.remove("visible");
}

/* ---------- Órbita ---------- */
function startOrbit() {
  stopTour();
  state.orbit.running = true;
  document.getElementById("btn-orbit").classList.add("active");
  let last = performance.now();
  const spin = now => {
    if (!state.orbit.running) return;
    const dt = now - last; last = now;
    map.setBearing(map.getBearing() + dt * 0.006);
    state.orbit.raf = requestAnimationFrame(spin);
  };
  state.orbit.raf = requestAnimationFrame(spin);
}

function stopOrbit() {
  state.orbit.running = false;
  if (state.orbit.raf) cancelAnimationFrame(state.orbit.raf);
  document.getElementById("btn-orbit").classList.remove("active");
}

for (const ev of ["mousedown", "touchstart", "wheel"]) {
  map.getCanvas().addEventListener(ev, () => { stopTour(); stopOrbit(); }, { passive: true });
}

/* ---------- UI ---------- */
document.getElementById("sw-inicial").addEventListener("click", () => setScenario("inicial"));
document.getElementById("sw-multi").addEventListener("click", () => setScenario("multi"));
document.getElementById("btn-panel").addEventListener("click", () =>
  document.getElementById("panel").classList.toggle("collapsed"));
document.getElementById("btn-tour").addEventListener("click", () =>
  state.tour.running ? stopTour() : startTour());
document.getElementById("btn-orbit").addEventListener("click", () =>
  state.orbit.running ? stopOrbit() : startOrbit());
document.getElementById("btn-reset").addEventListener("click", () => {
  stopTour(); stopOrbit();
  map.flyTo({ ...HOME_VIEW, duration: 3500, essential: true });
});

document.getElementById("btn-start").addEventListener("click", () => {
  document.getElementById("splash").classList.add("hidden");
  map.flyTo({ ...HOME_VIEW, duration: 5000, essential: true });
  setTimeout(startTour, 5200);
});

if (window.matchMedia("(max-width: 760px)").matches) {
  document.getElementById("panel").classList.add("collapsed");
}

/* ---------- Arranque ---------- */
map.on("load", async () => {
  try {
    const pattern = map.loadImage("img/pastizal.jpg");
    await loadCampos();
    await loadData();
    map.addImage("pastizal", (await pattern).data);
    addScenarioLayers();
    applyOpacity("inicial", 1); applyGrowth("inicial", 1);
    applyOpacity("multi", 0); applyGrowth("multi", 0);
    updatePanel();
    const btn = document.getElementById("btn-start");
    btn.disabled = false;
    document.getElementById("btn-start-label").textContent = "Iniciar vuelo";
  } catch (err) {
    console.error("Error cargando datos del paisaje:", err);
    document.getElementById("btn-start-label").textContent = "Error al cargar datos";
  }
});

/* ============================================================
   AgroDesign 3D Navigator — Monte Hermoso
   Mapa 3D navegable estilo vuelo de dron con conmutación entre
   paisaje actual y diseño multifuncional.
   ============================================================ */
"use strict";

/* ---------- Configuración de clases de paisaje ---------- */
// Clase canónica -> etiqueta y color de leyenda
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

// Clasificadores por escenario
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

/* Colores de las copas de árboles (4 tonos de monte) */
const TREE_COLORS = ["#24461f", "#2d5527", "#38652f", "#446f36"];
/* Colores del pastizal florecido (referencia: foto del corredor) */
const HERB_COLORS = ["#96a374", "#96a873", "#a3b183"];
const WOODY_BASE = { color: "#2e5026", height: 1.6, opacity: 0.55 };

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

// Área aproximada de un anillo en hectáreas (proyección local plana)
function ringAreaHa(ring, latRef) {
  const kx = 111320 * Math.cos((latRef * Math.PI) / 180), ky = 110574;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[j][1] * ky);
  }
  return Math.abs(a / 2) / 10000;
}

function featureCentroid(feature) {
  // centroide simple del anillo exterior más grande
  let best = null, bestArea = -1;
  for (const poly of feature.geometry.coordinates) {
    const a = ringAreaHa(poly[0], poly[0][0][1]);
    if (a > bestArea) { bestArea = a; best = poly[0]; }
  }
  let sx = 0, sy = 0;
  for (const [x, y] of best) { sx += x; sy += y; }
  return [sx / best.length, sy / best.length];
}

/* Hexágono (copa de árbol) alrededor de un punto, radio en metros */
function hexAround(lon, lat, rMeters, rng) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110574;
  const ring = [];
  const rot = rng() * Math.PI;
  for (let i = 0; i < 6; i++) {
    const ang = rot + (i * Math.PI) / 3;
    const r = rMeters * (0.82 + rng() * 0.36); // copa irregular
    ring.push([lon + (Math.cos(ang) * r) / kx, lat + (Math.sin(ang) * r) / ky]);
  }
  ring.push(ring[0]);
  return [ring];
}

/* ---------- Generador procedural de árboles ---------- */
function generateTrees(fc, classify, seed) {
  const rng = mulberry32(seed);
  const DENSITY = 45;         // árboles por hectárea (visual, no botánico)
  const MAX_TOTAL = 5500;
  const trees = [];

  const woodyPolys = []; // {polygon, bbox, ha}
  for (const f of fc.features) {
    const cls = classify(f.properties);
    if (cls !== "parche-le" && cls !== "corr-le") continue;
    for (const poly of f.geometry.coordinates) {
      const bbox = ringBBox(poly[0]);
      const ha = ringAreaHa(poly[0], (bbox[1] + bbox[3]) / 2);
      if (ha > 0.02) woodyPolys.push({ polygon: poly, bbox, ha });
    }
  }

  let totalHa = woodyPolys.reduce((s, p) => s + p.ha, 0);
  const density = Math.min(DENSITY, MAX_TOTAL / Math.max(totalHa, 0.001));

  for (const wp of woodyPolys) {
    const n = Math.max(4, Math.round(wp.ha * density));
    const [minX, minY, maxX, maxY] = wp.bbox;
    let placed = 0, attempts = 0;
    while (placed < n && attempts < n * 40) {
      attempts++;
      const pt = [minX + rng() * (maxX - minX), minY + rng() * (maxY - minY)];
      if (!pointInPolygon(pt, wp.polygon)) continue;
      placed++;
      const r = 3.2 + rng() * 3.4;             // radio de copa 3.2–6.6 m
      const h = 5 + rng() * 9;                 // altura 5–14 m
      trees.push({
        type: "Feature",
        properties: { h: Math.round(h * 10) / 10, b: Math.round(h * 0.25 * 10) / 10, c: Math.floor(rng() * TREE_COLORS.length) },
        geometry: { type: "Polygon", coordinates: hexAround(pt[0], pt[1], r, rng) }
      });
    }
  }
  return { type: "FeatureCollection", features: trees };
}

/* ---------- Estado global ---------- */
const state = {
  scenario: "inicial",
  data: { inicial: null, multi: null },
  stats: { inicial: {}, multi: {} },
  tour: { running: false, step: 0, timer: null },
  orbit: { running: false, raf: null },
  growth: { inicial: 1, multi: 0 },
  anim: null
};

const HOME_VIEW = { center: [-63.7885, -33.865], zoom: 12.6, pitch: 58, bearing: 15 };

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

/* ?debug habilita captura del canvas para verificación automatizada */
const DEBUG = new URLSearchParams(location.search).has("debug");

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
  maxBounds: [[-64.6, -34.5], [-63.0, -33.2]],
  attributionControl: { compact: true }
});
if (DEBUG) { window.__map = map; window.__mapStyle = mapStyle; window.__state = state; }
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
map.touchZoomRotate.enableRotation();

/* ---------- Carga de datos y capas ---------- */
async function loadData() {
  const [ini, multi] = await Promise.all([
    fetch("data/inicial.geojson").then(r => r.json()),
    fetch("data/multifuncional.geojson").then(r => r.json())
  ]);
  // Anotar clase canónica en cada feature (para filtros y popups)
  for (const f of ini.features) f.properties._cls = classInicial(f.properties);
  for (const f of multi.features) f.properties._cls = classMulti(f.properties);
  state.data.inicial = ini;
  state.data.multi = multi;
  computeStats();
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

function natureHa(key) {
  return NATURE_CLASSES.reduce((s, c) => s + (state.stats[key][c] || 0), 0);
}

/* Filtro por clases canónicas */
const clsFilter = (...classes) => ["in", ["get", "_cls"], ["literal", classes]];

function addScenarioLayers() {
  const ini = state.data.inicial, multi = state.data.multi;

  map.addSource("ini", { type: "geojson", data: ini });
  map.addSource("multi", { type: "geojson", data: multi });
  map.addSource("ini-trees", { type: "geojson", data: generateTrees(ini, classInicial, 20260711) });
  map.addSource("multi-trees", { type: "geojson", data: generateTrees(multi, classMulti, 47110226) });

  /* ===== Escenario INICIAL ===== */
  // Contorno de lotes agrícolas actuales
  map.addLayer({
    id: "ini-agri-line", type: "line", source: "ini",
    filter: clsFilter("agri"),
    paint: { "line-color": "#f3eecb", "line-width": 1.4, "line-opacity": 0.55 }
  });
  map.addLayer({
    id: "ini-otros-fill", type: "fill", source: "ini",
    filter: clsFilter("otros"),
    paint: { "fill-color": "#9e9e9e", "fill-opacity": 0.25 }
  });
  // Herbáceo existente: pastizal bajo
  map.addLayer({
    id: "ini-herb-ext", type: "fill-extrusion", source: "ini",
    filter: clsFilter("parche-herb"),
    paint: {
      "fill-extrusion-color": HERB_COLORS[0],
      "fill-extrusion-height": 0.9,
      "fill-extrusion-opacity": 0.9
    }
  });
  // Sotobosque + árboles del monte existente
  map.addLayer({
    id: "ini-woody-base", type: "fill-extrusion", source: "ini",
    filter: clsFilter("parche-le", "corr-le"),
    paint: { "fill-extrusion-color": WOODY_BASE.color, "fill-extrusion-height": WOODY_BASE.height, "fill-extrusion-opacity": WOODY_BASE.opacity }
  });
  map.addLayer({
    id: "ini-trees", type: "fill-extrusion", source: "ini-trees",
    paint: {
      "fill-extrusion-color": ["match", ["get", "c"], 0, TREE_COLORS[0], 1, TREE_COLORS[1], 2, TREE_COLORS[2], TREE_COLORS[3]],
      "fill-extrusion-height": ["get", "h"],
      "fill-extrusion-base": ["get", "b"],
      "fill-extrusion-opacity": 0.95,
      "fill-extrusion-vertical-gradient": true
    }
  });

  /* ===== Escenario MULTIFUNCIONAL ===== */
  // Zonas agrícolas rediseñadas: tintes suaves sobre el satélite
  map.addLayer({
    id: "multi-zona-fill", type: "fill", source: "multi",
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
    id: "multi-zona-line", type: "line", source: "multi",
    filter: clsFilter("zona1", "zona2", "zona3"),
    paint: {
      "line-color": ["match", ["get", "_cls"],
        "zona1", "#7ddf8a",
        "zona2", "#a8e6a0",
        "#c8eeb0"],
      "line-width": 1.6, "line-opacity": 0
    }
  });
  map.addLayer({
    id: "multi-otros-fill", type: "fill", source: "multi",
    filter: clsFilter("otros"),
    paint: { "fill-color": "#9e9e9e", "fill-opacity": 0 }
  });
  // Pastizales florecidos nuevos (parches y corredores herbáceos)
  map.addLayer({
    id: "multi-herb-ext", type: "fill-extrusion", source: "multi",
    filter: clsFilter("parche-herb", "corr-herb"),
    paint: {
      "fill-extrusion-color": ["match", ["get", "_cls"], "corr-herb", HERB_COLORS[2], HERB_COLORS[1]],
      "fill-extrusion-height": 0,
      "fill-extrusion-opacity": 0
    }
  });
  map.addLayer({
    id: "multi-woody-base", type: "fill-extrusion", source: "multi",
    filter: clsFilter("parche-le", "corr-le"),
    paint: { "fill-extrusion-color": WOODY_BASE.color, "fill-extrusion-height": 0, "fill-extrusion-opacity": 0 }
  });
  map.addLayer({
    id: "multi-trees", type: "fill-extrusion", source: "multi-trees",
    paint: {
      "fill-extrusion-color": ["match", ["get", "c"], 0, TREE_COLORS[0], 1, TREE_COLORS[1], 2, TREE_COLORS[2], TREE_COLORS[3]],
      "fill-extrusion-height": 0,
      "fill-extrusion-base": 0,
      "fill-extrusion-opacity": 0,
      "fill-extrusion-vertical-gradient": true
    }
  });

  setupInteractivity();
}

/* Capas de cada escenario con su opacidad objetivo cuando está activo */
const SCENARIO_LAYERS = {
  inicial: [
    { id: "ini-agri-line", prop: "line-opacity", on: 0.55 },
    { id: "ini-otros-fill", prop: "fill-opacity", on: 0.25 },
    { id: "ini-herb-ext", prop: "fill-extrusion-opacity", on: 0.9 },
    { id: "ini-woody-base", prop: "fill-extrusion-opacity", on: WOODY_BASE.opacity },
    { id: "ini-trees", prop: "fill-extrusion-opacity", on: 0.95 }
  ],
  multi: [
    { id: "multi-zona-fill", prop: "fill-opacity", on: 0.18 },
    { id: "multi-zona-line", prop: "line-opacity", on: 0.85 },
    { id: "multi-otros-fill", prop: "fill-opacity", on: 0.25 },
    { id: "multi-herb-ext", prop: "fill-extrusion-opacity", on: 0.9 },
    { id: "multi-woody-base", prop: "fill-extrusion-opacity", on: WOODY_BASE.opacity },
    { id: "multi-trees", prop: "fill-extrusion-opacity", on: 0.95 }
  ]
};

/* Altura de crecimiento: factor 0..1 aplicado a las capas extruidas */
function applyGrowth(key, t) {
  state.growth[key] = t;
  const p = key === "inicial" ? "ini" : "multi";
  map.setPaintProperty(`${p}-trees`, "fill-extrusion-height", ["*", ["get", "h"], t]);
  map.setPaintProperty(`${p}-trees`, "fill-extrusion-base", ["*", ["get", "b"], t]);
  map.setPaintProperty(`${p}-woody-base`, "fill-extrusion-height", WOODY_BASE.height * t);
  map.setPaintProperty(`${p}-herb-ext`, "fill-extrusion-height", 0.9 * t);
}

function applyOpacity(key, t) {
  for (const l of SCENARIO_LAYERS[key]) {
    map.setPaintProperty(l.id, l.prop, l.on * t);
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
    ? "Composición actual del establecimiento"
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
    // Los árboles no llevan propiedades del paisaje: buscar el polígono debajo
    feats = feats.filter(f => f.properties._cls);
    if (!feats.length) {
      // click sobre un árbol: consultar la fuente del escenario en ese punto
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

/* ---------- Tour de dron ---------- */
function buildTourWaypoints() {
  const multi = state.data.multi;
  const byArea = cls => multi.features
    .filter(f => f.properties._cls === cls)
    .sort((a, b) => (b.properties.Sup || 0) - (a.properties.Sup || 0));

  const corr = byArea("corr-herb").concat(byArea("corr-le"));
  const patches = byArea("parche-le");

  const corrPt = corr.length ? featureCentroid(corr[0]) : HOME_VIEW.center;
  const corrPt2 = corr.length > 1 ? featureCentroid(corr[1]) : corrPt;
  const patchPt = patches.length ? featureCentroid(patches[0]) : HOME_VIEW.center;

  return [
    { center: HOME_VIEW.center, zoom: 13.0, pitch: 55, bearing: 25, duration: 6000, msg: "Sobrevolando el establecimiento" },
    { center: corrPt, zoom: 15.4, pitch: 70, bearing: 70, duration: 8000, msg: "Descendiendo sobre un corredor biológico" },
    { center: corrPt2, zoom: 15.8, pitch: 74, bearing: 120, duration: 9000, msg: "Vuelo rasante sobre el corredor" },
    { center: patchPt, zoom: 15.6, pitch: 66, bearing: 200, duration: 8000, msg: "Aproximación al parche de monte" },
    { center: patchPt, zoom: 15.6, pitch: 66, bearing: 340, duration: 9000, msg: "Órbita sobre el parche leñoso" },
    { center: HOME_VIEW.center, zoom: 12.8, pitch: 52, bearing: 15, duration: 8000, msg: "Vista general del paisaje rediseñado" }
  ];
}

let TOUR = [];

function startTour() {
  stopOrbit();
  state.tour.running = true;
  state.tour.step = 0;
  document.getElementById("btn-tour").classList.add("active");
  document.getElementById("tour-banner").classList.add("visible");
  nextTourStep();
}

function nextTourStep() {
  if (!state.tour.running) return;
  if (state.tour.step >= TOUR.length) { stopTour(); return; }
  const wp = TOUR[state.tour.step++];
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

/* Cualquier interacción del usuario corta tour y órbita */
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

/* En móviles el panel arranca colapsado */
if (window.matchMedia("(max-width: 760px)").matches) {
  document.getElementById("panel").classList.add("collapsed");
}

/* ---------- Arranque ---------- */
map.on("load", async () => {
  try {
    await loadData();
    addScenarioLayers();
    applyOpacity("inicial", 1); applyGrowth("inicial", 1);
    applyOpacity("multi", 0); applyGrowth("multi", 0);
    updatePanel();
    TOUR = buildTourWaypoints();
    const btn = document.getElementById("btn-start");
    btn.disabled = false;
    document.getElementById("btn-start-label").textContent = "Iniciar vuelo";
  } catch (err) {
    console.error("Error cargando datos del paisaje:", err);
    document.getElementById("btn-start-label").textContent = "Error al cargar datos";
  }
});

/* ============================================================
   AgroDesign 3D Navigator
   Mapa 3D navegable estilo vuelo de dron con conmutación entre
   paisaje actual y diseño multifuncional. Árboles low-poly
   instanciados en GPU (Three.js). Multi-campo vía data/campos.json.
   ============================================================ */
"use strict";

/* ---------- Configuración de clases de paisaje ---------- */
const CLASS_META = {
  "agri":          { label: "Agrícola Secano",            legend: "#d9c98a" },
  "zona1":         { label: "Agrícola Secano · Zona 1",   legend: "#2e7d32" },
  "zona2":         { label: "Agrícola Secano · Zona 2",   legend: "#66bb6a" },
  "zona3":         { label: "Agrícola Secano · Zona 3",   legend: "#9ccc65" },
  "parche-le":     { label: "Parche Leñoso",              legend: "#1b4020" },
  "corr-le":       { label: "Corredor Leñoso",            legend: "#2f5d33" },
  "parche-herb":   { label: "Parche Herbáceo",            legend: "#8a9c66" },
  "corr-herb":     { label: "Corredor Herbáceo",          legend: "#a68b56" },
  "bajo":          { label: "Bajo en Recuperación",       legend: "#7c9a80" },
  "instalaciones": { label: "Instalaciones",              legend: "#b8b3a4" },
  "camino":        { label: "Caminos",                    legend: "#c9bd9e" },
  "otros":         { label: "Otros",                      legend: "#9e9e9e" }
};
/* Orden canónico para leyendas (se muestran solo las clases presentes) */
const CLASS_ORDER = ["agri", "zona1", "zona2", "zona3", "parche-le", "parche-herb",
  "corr-le", "corr-herb", "bajo", "instalaciones", "camino", "otros"];
const NATURE_CLASSES = ["parche-le", "corr-le", "parche-herb", "corr-herb"];
const WOODY_CLASSES = ["parche-le", "corr-le"];
const HERB_LIKE_CLASSES = ["parche-herb", "corr-herb", "bajo"];
const MISC_CLASSES = ["otros", "instalaciones", "camino"];

/* Clasificador universal: tolera las variantes de esquema de cada campo
   (Unidad/UNIDAD, nombres largos, con acentos, o solo códigos RASTER) */
function classify(props) {
  const raw = (props.Unidad || props.UNIDAD || props.unidad || "")
    .toString().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (raw && raw !== "no aplica") {
    if (/otros/.test(raw)) return "otros";
    if (/bajo/.test(raw)) return "bajo";
    if (/instalacion/.test(raw)) return "instalaciones";
    if (/camino/.test(raw)) return "camino";
    if (/parche.*herb/.test(raw)) return "parche-herb";
    if (/corr.*herb/.test(raw)) return "corr-herb";
    if (/parche/.test(raw)) return "parche-le";
    if (/corr/.test(raw)) return "corr-le";
    if (/(zona\s*-?1|z1)/.test(raw)) return "zona1";
    if (/(zona\s*-?2|z2)/.test(raw)) return "zona2";
    if (/(zona\s*-?3|z3)/.test(raw)) return "zona3";
    if (/(agricola|ag-secano|secano)/.test(raw)) return "agri";
  }
  switch (props.RASTER) {
    case 11: return "parche-le";
    case 12: return "corr-le";
    case 21: return "parche-herb";
    case 22: return "corr-herb";
    case 31: return "agri";
    case 311: return "zona1";
    case 312: return "zona2";
    case 313: return "zona3";
    case 41: return "instalaciones";
    case 42: return "camino";
    default: return "otros";
  }
}

/* Paleta de copas de monte de espinal */
const CROWN_PALETTE = [0x2a4f22, 0x33602a, 0x3e6d2f, 0x4a7434, 0x567c38, 0x6a7f3e];
const TRUNK_COLOR = 0x5b4632;
const WOODY_BASE = { color: "#2e5026", height: 1.2, opacity: 0.45 };
const HERB_HEIGHT = 0.6;

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

function blobRing(lon, lat, rMeters, rng, verts = 7, jitter = 0.5) {
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

function offsetRing(polygon, dxM, dyM, lat) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110574;
  return [polygon[0].map(([x, y]) => [x + dxM / kx, y + dyM / ky])];
}

/* Scatter determinístico dentro de los polígonos de ciertas clases */
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

/* Genera atributos de árboles + sombras drapeadas (GeoJSON) */
function generateTreeData(fc, seed) {
  const { points, rng } = scatterInClasses(fc, WOODY_CLASSES, seed, 55, 4200, 3);
  const trees = [], shadowFeats = [];
  for (const [lon, lat] of points) {
    const h = 5 + rng() * 9;                    // altura total 5–14 m
    const r = h * (0.32 + rng() * 0.2);         // radio de copa proporcional
    trees.push({
      lon, lat, h, r,
      c: Math.floor(rng() * CROWN_PALETTE.length),
      lobe: rng() < 0.45,
      j: rng()
    });
    shadowFeats.push({
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: offsetRing(blobRing(lon, lat, r * 1.15, rng, 7, 0.4), 2.4, -1.8, lat) }
    });
  }
  return { trees, shadows: { type: "FeatureCollection", features: shadowFeats } };
}

/* ---------- Estado global ---------- */
const params = new URLSearchParams(location.search);
const DEBUG = params.has("debug");

const state = {
  scenario: "inicial",
  campo: null,
  data: { inicial: null, multi: null },
  veg: { inicial: null, multi: null },
  stats: { inicial: {}, multi: {} },
  bbox: null,
  designOpacity: 1,
  tour: { running: false, timer: null, route: [], step: 0 },
  orbit: { running: false, raf: null },
  growth: { inicial: 1, multi: 0 },
  anim: null
};

let HOME_VIEW = { center: [-63.7885, -33.865], zoom: 12.6, pitch: 58, bearing: 15 };

/* ---------- Estilo base del mapa (sin terreno: llanura, evita
   artefactos de extrusiones cortadas en pendientes) ---------- */
const mapStyle = {
  version: 8,
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    esri: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      // maxzoom por defecto; se ajusta por campo en loadCampos() según hasta
      // qué nivel Esri tiene imagen nativa (z18 en Monte Hermoso, z17 en
      // Silesia/Carmen). Más allá, Esri devuelve "Map data not yet available",
      // así que reescalamos el último tile real en vez de pedir los inexistentes.
      maxzoom: 17,
      attribution: "Imagen satelital © Esri, Maxar, Earthstar Geographics | AgroDesign"
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
  }
};

const map = new maplibregl.Map({
  container: "map",
  style: mapStyle,
  preserveDrawingBuffer: true,  // permite exportar la vista a PNG (botón capturar)
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

/* ---------- Capa custom Three.js: árboles low-poly instanciados ---------- */
const vegLayer = {
  id: "veg-3d",
  type: "custom",
  renderingMode: "3d",
  groups: {},

  onAdd(mapInstance, gl) {
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xfff3da, 0.85);
    sun.position.set(-0.5, 1, -0.7);  // sol NO (sombras GeoJSON al SE)
    this.scene.add(sun);

    const origin = maplibregl.MercatorCoordinate.fromLngLat(HOME_VIEW.center, 0);
    this.scale = origin.meterInMercatorCoordinateUnits();
    // escena en metros: X=este, Y=arriba, Z=sur
    this.l = new THREE.Matrix4()
      .makeTranslation(origin.x, origin.y, 0)
      .scale(new THREE.Vector3(this.scale, -this.scale, this.scale))
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    this.origin = origin;

    for (const key of ["inicial", "multi"]) {
      const g = this.buildGroup(state.veg[key].trees);
      g.group.scale.y = state.growth[key] || 0.0001;
      this.setGroupOpacity(g, key === "inicial" ? 1 : 0);
      this.scene.add(g.group);
      this.groups[key] = g;
    }

    this.renderer = new THREE.WebGLRenderer({ canvas: mapInstance.getCanvas(), context: gl });
    this.renderer.autoClear = false;
  },

  buildGroup(trees) {
    const group = new THREE.Group();
    const nLobes = trees.reduce((s, t) => s + (t.lobe ? 1 : 0), 0);

    const trunkGeo = new THREE.CylinderGeometry(0.7, 1, 1, 5);
    trunkGeo.translate(0, 0.5, 0); // base del tronco en y=0
    const crownGeo = new THREE.IcosahedronGeometry(1, 1);

    const trunkMat = new THREE.MeshPhongMaterial({ color: 0xffffff, flatShading: true, shininess: 0, transparent: true });
    const crownMat = new THREE.MeshPhongMaterial({ color: 0xffffff, flatShading: true, shininess: 0, transparent: true });

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, trees.length + nLobes);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const col = new THREE.Color();
    const origin = this.origin, s = this.scale;

    let ci = 0;
    trees.forEach((t, i) => {
      // posición exacta en Mercator -> metros de escena (X este, Z sur)
      const mc = maplibregl.MercatorCoordinate.fromLngLat([t.lon, t.lat], 0);
      const x = (mc.x - origin.x) / s;
      const z = (mc.y - origin.y) / s;
      const trunkH = t.h * 0.32;
      const trunkR = 0.12 + t.h * 0.035;

      m.compose(
        new THREE.Vector3(x, 0, z),
        q.identity(),
        new THREE.Vector3(trunkR, trunkH, trunkR)
      );
      trunks.setMatrixAt(i, m);
      col.setHex(TRUNK_COLOR).offsetHSL(0, 0, (t.j - 0.5) * 0.08);
      trunks.setColorAt(i, col);

      const sy = t.h * 0.42;
      const cy = trunkH + sy * 0.82;
      eul.set(0, t.j * Math.PI * 2, 0);
      m.compose(
        new THREE.Vector3(x, cy, z),
        q.setFromEuler(eul),
        new THREE.Vector3(t.r, sy, t.r * (0.9 + t.j * 0.2))
      );
      crowns.setMatrixAt(ci, m);
      col.setHex(CROWN_PALETTE[t.c]).offsetHSL(0, 0, (t.j - 0.5) * 0.07);
      crowns.setColorAt(ci, col);
      ci++;

      if (t.lobe) {
        const lr = t.r * 0.6;
        m.compose(
          new THREE.Vector3(x + (t.j - 0.5) * t.r * 1.4, cy + sy * 0.35, z + (((t.j * 7) % 1) - 0.5) * t.r * 1.4),
          q.identity(),
          new THREE.Vector3(lr, lr * 0.9, lr)
        );
        crowns.setMatrixAt(ci, m);
        col.setHex(CROWN_PALETTE[(t.c + 1) % CROWN_PALETTE.length]).offsetHSL(0, 0, (t.j - 0.5) * 0.07);
        crowns.setColorAt(ci, col);
        ci++;
      }
    });
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    if (trunks.instanceColor) trunks.instanceColor.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;

    group.add(trunks, crowns);
    return { group, trunkMat, crownMat };
  },

  setGroupOpacity(g, o) {
    g.trunkMat.opacity = o;
    g.crownMat.opacity = o;
    g.group.visible = o > 0.02;
  },

  setOpacity(key, o) {
    if (this.groups[key]) this.setGroupOpacity(this.groups[key], o);
  },

  setGrowth(key, t) {
    if (this.groups[key]) this.groups[key].group.scale.y = Math.max(t, 0.0001);
  },

  render(gl, matrix) {
    this.camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(this.l);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }
};

/* ---------- Carga de configuración y datos ---------- */
async function loadCampos() {
  // no-cache: revalida el config (ETag/304) para que cambios de campo o de
  // maxzoom lleguen a usuarios que ya tenían la página cacheada.
  const cfg = await fetch("data/campos.json", { cache: "no-cache" }).then(r => r.json());
  const wanted = params.get("campo") || cfg.default;
  state.campo = cfg.campos.find(c => c.id === wanted) || cfg.campos[0];

  // Resolución satelital por campo: reconstruimos la fuente Esri con el maxzoom
  // del campo si difiere del default (evita el cartel "Map data not yet
  // available" donde no hay imagen, sin resignar nitidez donde sí la hay).
  const mz = state.campo.maxzoom || mapStyle.sources.esri.maxzoom;
  if (map.getSource("esri") && mz !== mapStyle.sources.esri.maxzoom) {
    map.removeLayer("satellite");
    map.removeSource("esri");
    map.addSource("esri", { ...mapStyle.sources.esri, maxzoom: mz });
    map.addLayer({ id: "satellite", type: "raster", source: "esri" });
  }

  const list = document.getElementById("campo-list");
  list.innerHTML = "";
  const ddLabel = c => (c.cliente && c.cliente !== "AgroDesign") ? `${c.cliente} — ${c.nombre}` : c.nombre;
  for (const c of cfg.campos) {
    const li = document.createElement("li");
    li.dataset.id = c.id;
    li.innerHTML = `<span class="dot"></span><span class="dd-name">${ddLabel(c)}</span><span class="check">✓</span>`;
    if (c.id === state.campo.id) li.classList.add("selected");
    li.addEventListener("click", () => {
      const q = new URLSearchParams(location.search);
      q.set("campo", c.id);
      location.search = q.toString();
    });
    list.appendChild(li);
  }
  document.getElementById("campo-current").textContent = ddLabel(state.campo);
  document.getElementById("brand-campo").textContent = `${state.campo.nombre} · Navegador 3D`;
  document.getElementById("splash-campo").textContent = state.campo.nombre;
  document.title = `AgroDesign · Navegador 3D · ${state.campo.nombre}`;
}

async function loadData() {
  const [ini, multi] = await Promise.all([
    fetch(state.campo.inicial).then(r => r.json()),
    fetch(state.campo.multifuncional).then(r => r.json())
  ]);
  for (const fc of [ini, multi]) {
    for (const f of fc.features) {
      f.properties._cls = classify(f.properties);
      // superficie: del atributo si existe, si no calculada de la geometría
      let sup = f.properties.Sup ?? f.properties.SUP ?? f.properties.sup;
      if (sup == null || sup === 0) {
        sup = f.geometry.coordinates.reduce((s, poly) =>
          s + ringAreaHa(poly[0], poly[0][0][1]), 0);
      }
      f.properties._sup = sup;
    }
  }
  state.data.inicial = ini;
  state.data.multi = multi;
  computeStats();
  computeHomeView();
  state.veg.inicial = generateTreeData(ini, 20260711);
  state.veg.multi = generateTreeData(multi, 47110226);
}

function computeStats() {
  for (const [key, fc] of [["inicial", state.data.inicial], ["multi", state.data.multi]]) {
    const sums = {};
    for (const f of fc.features) {
      const cls = f.properties._cls;
      sums[cls] = (sums[cls] || 0) + (f.properties._sup || 0);
    }
    state.stats[key] = sums;
  }
}

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

function addScenarioLayers() {
  map.addSource("ini", { type: "geojson", data: state.data.inicial });
  map.addSource("multi", { type: "geojson", data: state.data.multi });
  map.addSource("ini-shadows", { type: "geojson", data: state.veg.inicial.shadows });
  map.addSource("multi-shadows", { type: "geojson", data: state.veg.multi.shadows });

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

    map.addLayer({
      id: `${p}-otros-fill`, type: "fill", source: src,
      filter: clsFilter(...MISC_CLASSES),
      paint: { "fill-color": "#c9c9b8", "fill-opacity": 0 }
    });
    map.addLayer({
      id: `${p}-otros-line`, type: "line", source: src,
      filter: clsFilter(...MISC_CLASSES),
      paint: { "line-color": "#e8e6d5", "line-width": 1.2, "line-opacity": 0, "line-dasharray": [2.5, 2] }
    });

    // Pastizal: color base + textura uniforme de grano fino
    map.addLayer({
      id: `${p}-herb-ext`, type: "fill-extrusion", source: src,
      filter: clsFilter(...HERB_LIKE_CLASSES),
      paint: {
        "fill-extrusion-color": ["match", ["get", "_cls"], "corr-herb", "#8a7a4c", "bajo", "#6f8a72", "#6d8050"],
        "fill-extrusion-height": 0,
        "fill-extrusion-opacity": 0
      }
    });
    map.addLayer({
      id: `${p}-herb-pattern`, type: "fill-extrusion", source: src,
      filter: clsFilter(...HERB_LIKE_CLASSES),
      paint: {
        // corredores herbáceos en pardo (pasto seco) para distinguirlos
        // de parches y bajos verdes
        "fill-extrusion-pattern": ["match", ["get", "_cls"], "corr-herb", "pastizal-pardo", "pastizal"],
        "fill-extrusion-height": 0,
        "fill-extrusion-opacity": 0
      }
    });

    map.addLayer({
      id: `${p}-woody-base`, type: "fill-extrusion", source: src,
      filter: clsFilter("parche-le", "corr-le"),
      paint: { "fill-extrusion-color": WOODY_BASE.color, "fill-extrusion-height": 0, "fill-extrusion-opacity": 0 }
    });
    map.addLayer({
      id: `${p}-tree-shadows`, type: "fill", source: `${p}-shadows`,
      paint: { "fill-color": "#0c1c08", "fill-opacity": 0 }
    });
  }

  map.addLayer(vegLayer);
  setupInteractivity();
}

const SCENARIO_LAYERS = {
  inicial: [
    { id: "ini-agri-line", prop: "line-opacity", on: 0.55 },
    { id: "ini-otros-fill", prop: "fill-opacity", on: 0.06 },
    { id: "ini-otros-line", prop: "line-opacity", on: 0.5 },
    { id: "ini-herb-ext", prop: "fill-extrusion-opacity", on: 0.9 },
    { id: "ini-herb-pattern", prop: "fill-extrusion-opacity", on: 0.75 },
    { id: "ini-woody-base", prop: "fill-extrusion-opacity", on: WOODY_BASE.opacity },
    { id: "ini-tree-shadows", prop: "fill-opacity", on: 0.28 }
  ],
  multi: [
    { id: "multi-zona-fill", prop: "fill-opacity", on: 0.18 },
    { id: "multi-zona-line", prop: "line-opacity", on: 0.85 },
    { id: "multi-otros-fill", prop: "fill-opacity", on: 0.06 },
    { id: "multi-otros-line", prop: "line-opacity", on: 0.5 },
    { id: "multi-herb-ext", prop: "fill-extrusion-opacity", on: 0.9 },
    { id: "multi-herb-pattern", prop: "fill-extrusion-opacity", on: 0.75 },
    { id: "multi-woody-base", prop: "fill-extrusion-opacity", on: WOODY_BASE.opacity },
    { id: "multi-tree-shadows", prop: "fill-opacity", on: 0.28 }
  ]
};

function applyGrowth(key, t) {
  state.growth[key] = t;
  const p = key === "inicial" ? "ini" : "multi";
  map.setPaintProperty(`${p}-woody-base`, "fill-extrusion-height", WOODY_BASE.height * t);
  map.setPaintProperty(`${p}-herb-ext`, "fill-extrusion-height", HERB_HEIGHT * t);
  map.setPaintProperty(`${p}-herb-pattern`, "fill-extrusion-height", (HERB_HEIGHT + 0.05) * t);
  vegLayer.setGrowth(key, t);
}

function applyOpacity(key, t) {
  const f = t * state.designOpacity;
  for (const l of SCENARIO_LAYERS[key]) map.setPaintProperty(l.id, l.prop, l.on * f);
  vegLayer.setOpacity(key, f);
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

/* ---------- Panel ---------- */
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
  for (const cls of CLASS_ORDER) {
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

/* ---------- Interactividad ---------- */
function setupInteractivity() {
  const CLICKABLE = {
    inicial: ["ini-woody-base", "ini-herb-ext", "ini-otros-fill"],
    multi: ["multi-woody-base", "multi-herb-ext", "multi-zona-fill", "multi-otros-fill"]
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
    const elemento = p.elementro || p.Elemento || p.ELEMENTO || "";
    new maplibregl.Popup({ closeButton: true, maxWidth: "260px" })
      .setLngLat(e.lngLat)
      .setHTML(`
        <div class="popup-title">${meta.label}</div>
        <div class="popup-sub">${elemento ? "Elemento: " + elemento : (state.scenario === "inicial" ? "Paisaje actual" : "Diseño propuesto")}</div>
        <div class="popup-ha">Superficie: <b>${fmtHa(p._sup || 0)}</b></div>`)
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
    .sort((a, b) => (b.properties._sup || 0) - (a.properties._sup || 0));

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
  state.tour.route = buildTourWaypoints();
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

/* ---------- Captura de imagen (PNG de la vista actual) ---------- */
function captureImage() {
  // Forzar un render fresco y leer el buffer en el mismo frame
  map.once("render", () => {
    let url;
    try {
      url = map.getCanvas().toDataURL("image/png");
    } catch (err) {
      console.error("No se pudo capturar la imagen:", err);
      return;
    }
    const escena = state.scenario === "inicial" ? "paisaje-actual" : "paisaje-multifuncional";
    const campo = (state.campo && state.campo.id) || "campo";
    const stamp = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = `agrodesign-${campo}-${escena}-${stamp}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  map.triggerRepaint();
}
document.getElementById("btn-capture").addEventListener("click", captureImage);

/* ---------- Pantalla completa (útil para el iframe embebido) ---------- */
function toggleFullscreen() {
  const el = document.documentElement;
  if (!document.fullscreenElement) {
    (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
  }
}
document.getElementById("btn-fullscreen").addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  document.getElementById("btn-fullscreen").classList.toggle("active", !!document.fullscreenElement);
});

document.getElementById("btn-start").addEventListener("click", () => {
  document.getElementById("splash").classList.add("hidden");
  map.flyTo({ ...HOME_VIEW, duration: 5000, essential: true });
  setTimeout(startTour, 5200);
});

/* Dropdown de campos */
const campoDd = document.getElementById("campo-dd");
document.getElementById("campo-btn").addEventListener("click", e => {
  e.stopPropagation();
  campoDd.classList.toggle("open");
});
document.addEventListener("click", () => campoDd.classList.remove("open"));

/* Slider de opacidad del diseño */
const opSlider = document.getElementById("opacity-slider");
opSlider.addEventListener("input", () => {
  state.designOpacity = opSlider.value / 100;
  document.getElementById("opacity-val").textContent = `${opSlider.value}%`;
  applyOpacity(state.scenario, 1);
});

if (window.matchMedia("(max-width: 760px)").matches) {
  document.getElementById("panel").classList.add("collapsed");
}

/* ---------- Arranque ---------- */
map.on("load", async () => {
  try {
    const pattern = map.loadImage("img/pastizal.jpg");
    const patternPardo = map.loadImage("img/pastizal-pardo.jpg");
    await loadCampos();
    await loadData();
    map.addImage("pastizal", (await pattern).data);
    map.addImage("pastizal-pardo", (await patternPardo).data);
    addScenarioLayers();
    applyOpacity("inicial", 1); applyGrowth("inicial", 1);
    applyOpacity("multi", 0); applyGrowth("multi", 0);
    updatePanel();
    const btn = document.getElementById("btn-start");
    btn.disabled = false;
    document.getElementById("btn-start-label").textContent = "Iniciar simulación";
  } catch (err) {
    console.error("Error cargando datos del paisaje:", err);
    document.getElementById("btn-start-label").textContent = "Error al cargar datos";
  }
});

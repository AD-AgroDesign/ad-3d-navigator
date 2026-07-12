# AgroDesign · Navegador 3D — Monte Hermoso

Escenario 3D georreferenciado y navegable estilo vuelo de dron sobre imagen satelital real,
que permite conmutar entre el **paisaje actual** del establecimiento y el **diseño de paisaje
multifuncional** propuesto por AgroDesign (corredores biológicos y parches de naturaleza).

## Uso

Es un sitio estático puro: no requiere build ni API keys. Servir la carpeta con cualquier
servidor HTTP (p. ej. `python -m http.server`) o publicarla en GitHub Pages / Netlify.

## Embeber en la web de la empresa

```html
<iframe
  src="https://TU-URL-DE-PAGES/"
  style="width:100%; height:640px; border:0; border-radius:12px;"
  allow="fullscreen"
  loading="lazy"
  title="AgroDesign · Navegador 3D · Monte Hermoso">
</iframe>
```

## Estructura

- `index.html` — UI (splash, header, panel, controles de vuelo)
- `css/style.css` — tema AgroDesign, responsive
- `js/main.js` — mapa MapLibre GL, vegetación 3D procedural, tour de dron, conmutador de escenarios
- `data/inicial.geojson` — paisaje inicial (capas GIS de AgroDesign)
- `data/multifuncional.geojson` — diseño multifuncional propuesto

## Fuentes de datos

- Imagen satelital: Esri World Imagery (© Esri, Maxar, Earthstar Geographics)
- Terreno: AWS Terrain Tiles (Mapzen terrarium)
- Capas de paisaje: equipo GIS de AgroDesign (WGS84 / EPSG:4326)

## Agregar otro campo

Reemplazar los dos GeoJSON en `data/` (misma estructura de atributos: `RASTER` para el
paisaje inicial, `Unidad` para el multifuncional) y ajustar `HOME_VIEW` y `maxBounds`
en `js/main.js` a las coordenadas del nuevo establecimiento.

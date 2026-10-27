"use strict";

const el = (id) => document.getElementById(id);
const integer = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 });
const money = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const missing = "Sin información en la fuente";
const colors = {
  historicas: { VENTA: "#b53c32", ARRIENDO: "#2876ac", SIN_CLASIFICAR: "#687580" },
  interes: { SIN_CLASIFICAR: "#a564b5" },
  capturas: { VENTA: "#d97816", ARRIENDO: "#19856c", SIN_CLASIFICAR: "#897451" },
};
const operationLabels = { VENTA: "Ventas", ARRIENDO: "Arrendamientos", SIN_CLASIFICAR: "Sin clasificar" };
const layerLabels = { historicas: "Ofertas históricas", capturas: "Web Scraping (Capturas web)" };
const hiddenGroups = new Set();
const symbolCache = new Map();
const propertyColors = {
  CASA: "#b53c32", APARTAMENTO: "#2876ac", APARTAESTUDIO: "#19856c",
  LOTE: "#b47408", "CASA LOTE": "#8f571d", LOCAL: "#9b419f",
  "LOCAL COMERCIAL": "#7044a5", BODEGA: "#536674", OFICINA: "#c33b77",
  "EDIFICIO DE OFICINAS": "#394eaa", GARAJE: "#6b751d", HABITACION: "#16818c",
  CONDOMINIO: "#447b32", OTRO: "#767676",
};
const sources = {};
const layers = {};
let collection = [];
let pageNumber = 0;
let requestNumber = 0;
let selectedId = null;
const pageSize = 50;
const geojson = new ol.format.GeoJSON();
const baseLayer = new ol.layer.Tile();
const blocksSource = new ol.source.Vector();
const blocksStyle = new ol.style.Style({
  stroke: new ol.style.Stroke({ color: "#53667488", width: 1 }),
  fill: new ol.style.Fill({ color: "#b9c8d011" }),
});
const blocksLabelStyle = new ol.style.Style({
  text: new ol.style.Text({
    font: "600 12px Arial, sans-serif",
    fill: new ol.style.Fill({ color: "#243746" }),
    stroke: new ol.style.Stroke({ color: "#ffffff", width: 3 }),
    overflow: false,
  }),
});
const blocksLayer = new ol.layer.Vector({
  source: blocksSource, visible: false, minZoom: 14, declutter: true,
  style: (feature, resolution) => {
    if (resolution > map.getView().getResolutionForZoom(16)) return blocksStyle;
    const code = String(feature.get("code") ?? "").trim();
    if (!/^\d{4,}$/.test(code)) return blocksStyle;
    blocksLabelStyle.getText().setText(code.slice(-4));
    return [blocksStyle, blocksLabelStyle];
  },
});

const styles = Object.fromEntries(Object.entries(colors).map(([key, palette]) => [
  key, Object.fromEntries(Object.entries(palette).map(([operation, color]) => [operation, new ol.style.Style({
    image: new ol.style.Circle({
      radius: 5, fill: new ol.style.Fill({ color }),
      stroke: new ol.style.Stroke({ color: "#ffffff", width: 1.1 }),
    }),
  })])),
]));
function operationFor(feature) {
  return Object.hasOwn(operationLabels, feature.get("offer_type")) ? feature.get("offer_type") : "SIN_CLASIFICAR";
}

function groupKey(key, operation, type) {
  return JSON.stringify([key, operation, type]);
}

function featureVisible(key, feature) {
  return key === "interes" || !hiddenGroups.has(groupKey(key, operationFor(feature), feature.get("property_type") || "OTRO"));
}

function propertyColor(type) {
  if (Object.hasOwn(propertyColors, type)) return propertyColors[type];
  let hash = 0;
  for (const character of type) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360}, 55%, 38%)`;
}

function propertyStyle(operation, type) {
  const key = JSON.stringify([operation, type]);
  if (!symbolCache.has(key)) {
    const options = {
      radius: 6, fill: new ol.style.Fill({ color: propertyColor(type) }),
      stroke: new ol.style.Stroke({ color: "#ffffff", width: 1.1 }),
    };
    const image = operation === "VENTA" ? new ol.style.Circle(options) :
      new ol.style.RegularShape({ ...options, points: operation === "ARRIENDO" ? 3 : 4 });
    symbolCache.set(key, new ol.style.Style({ image }));
  }
  return symbolCache.get(key);
}

function legendSymbol(operation, type) {
  const symbol = document.createElement("span");
  symbol.className = `dot symbol-${operation}`;
  symbol.style.backgroundColor = propertyColor(type);
  return symbol;
}

function renderGroups() {
  const legend = el("map-legend");
  const legendExpanded = new Set([...legend.querySelectorAll("details[open]")].map(node => node.dataset.layer));
  const firstRender = !legend.querySelector("details");
  legend.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = "Leyenda";
  legend.append(heading);
  for (const key of Object.keys(layerLabels)) {
    const previous = el(`groups-${key}`);
    const expanded = new Set(previous ? [...previous.querySelectorAll("details[open]")].map(node => node.dataset.operation) : []);
    const group = document.createElement("div");
    group.id = `groups-${key}`;
    group.className = "operation-layers";
    const legendGroup = document.createElement("details");
    legendGroup.dataset.layer = key;
    legendGroup.open = firstRender || legendExpanded.has(key);
    const title = document.createElement("summary");
    title.textContent = layerLabels[key];
    legendGroup.append(title);
    legend.append(legendGroup);
    legendGroup.hidden = !layers[key].getVisible();
    const features = sources[key].getFeatures();
    for (const operation of Object.keys(operationLabels)) {
      const types = [...new Set(features.filter(feature => operationFor(feature) === operation)
        .map(feature => feature.get("property_type") || "OTRO"))].sort((a, b) => a.localeCompare(b, "es"));
      if (!types.length) continue;
      const details = document.createElement("details");
      details.dataset.operation = operation;
      details.open = expanded.has(operation);
      const summary = document.createElement("summary");
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.setAttribute("aria-label", `${operationLabels[operation]} · ${layerLabels[key]}`);
      const keys = types.map(type => groupKey(key, operation, type));
      const syncToggle = () => {
        const visible = keys.filter(id => !hiddenGroups.has(id)).length;
        toggle.checked = visible > 0;
        toggle.indeterminate = visible > 0 && visible < keys.length;
      };
      syncToggle();
      toggle.addEventListener("click", event => event.stopPropagation());
      const changed = () => {
        layers[key].changed();
        overlay.setPosition(undefined);
        el("popup").hidden = true;
        updateLegend();
      };
      toggle.addEventListener("change", () => {
        for (const id of keys) {
          if (toggle.checked) hiddenGroups.delete(id);
          else hiddenGroups.add(id);
        }
        for (const input of details.querySelectorAll(".check input")) input.checked = toggle.checked;
        syncToggle();
        changed();
      });
      summary.append(toggle, document.createTextNode(` ${operationLabels[operation]}`));
      details.append(summary);
      const legendOperation = document.createElement("div");
      const operationTitle = document.createElement("h3");
      operationTitle.textContent = operationLabels[operation];
      legendOperation.append(operationTitle);
      const legendItems = [];
      for (const type of types) {
        const id = groupKey(key, operation, type);
        const label = document.createElement("label");
        label.className = "check";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !hiddenGroups.has(id);
        input.setAttribute("aria-label", `${type} · ${operationLabels[operation]} · ${layerLabels[key]}`);
        input.addEventListener("change", () => {
          if (input.checked) hiddenGroups.delete(id);
          else hiddenGroups.add(id);
          syncToggle();
          changed();
        });
        label.append(input, legendSymbol(operation, type), document.createTextNode(type));
        details.append(label);
        const item = document.createElement("div");
        item.className = "legend-item";
        item.append(legendSymbol(operation, type), document.createTextNode(type));
        legendOperation.append(item);
        legendItems.push([id, item]);
      }
      const updateLegend = () => {
        legendGroup.hidden = !layers[key].getVisible();
        for (const [id, item] of legendItems) item.hidden = hiddenGroups.has(id);
        legendOperation.hidden = legendItems.every(([id]) => hiddenGroups.has(id));
      };
      updateLegend();
      group.append(details);
      legendGroup.append(legendOperation);
    }
    if (!features.length) group.textContent = "Sin puntos en esta consulta.";
    if (previous) previous.replaceWith(group);
    else el(`show-${key}`).closest("label").after(group);
  }
  if (layers.interes.getVisible()) {
    const item = document.createElement("div");
    item.className = "legend-item";
    const dot = document.createElement("span");
    dot.className = "dot interest";
    item.append(dot, document.createTextNode("Puntos de interés"));
    legend.append(item);
  }
}

const selectedStyle = new ol.style.Style({
  image: new ol.style.Circle({
    radius: 9, fill: new ol.style.Fill({ color: "#fff18a" }),
    stroke: new ol.style.Stroke({ color: "#e17418", width: 3 }),
  }),
  zIndex: 10,
});
for (const key of Object.keys(colors)) {
  sources[key] = new ol.source.Vector();
  layers[key] = new ol.layer.Vector({
    source: sources[key],
    opacity: key === "historicas" ? 0.5 : 1,
    style: (f) => {
      if (!featureVisible(key, f)) return undefined;
      return f.get("id") === selectedId ? selectedStyle :
        key === "interes" ? styles.interes.SIN_CLASIFICAR :
          propertyStyle(operationFor(f), f.get("property_type") || "OTRO");
    },
  });
}
const overlay = new ol.Overlay({
  element: el("popup"), autoPan: { animation: { duration: 200 } },
  positioning: "bottom-center", offset: [0, -15],
});
const map = new ol.Map({
  target: "map", layers: [baseLayer, blocksLayer, ...Object.values(layers)],
  overlays: [overlay],
  view: new ol.View({ center: ol.proj.fromLonLat([-75.2819, 2.9273]), zoom: 13 }),
});

function setStatus(id, message, error = false) {
  const node = el(id);
  node.textContent = message;
  node.classList.toggle("error", error);
}

function switchBase() {
  const choice = el("basemap").value;
  let source = null;
  if (choice === "osm") source = new ol.source.OSM();
  if (choice === "satellite" || choice === "topographic") {
    const service = choice === "satellite" ? "World_Imagery" : "World_Topo_Map";
    source = new ol.source.XYZ({
      url: `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`,
      attributions: "Tiles © Esri — Sources: Esri, Maxar, Earthstar Geographics and GIS User Community",
      maxZoom: 19,
    });
  }
  if (source) source.on("tileloaderror", () => {
    if (baseLayer.getSource() === source) {
      setStatus("basemap-status", "No se pudo cargar parte del fondo. Compruebe Internet o cambie el mapa base.", true);
    }
  });
  baseLayer.setSource(source);
  setStatus("basemap-status", choice === "none" ? "Fondo desactivado; las capas permanecen visibles." :
    "Fondo externo informativo; su fecha no corresponde necesariamente a las capturas.");
}

async function getJSON(url) {
  if (globalThis.OICNEPublic) return globalThis.OICNEPublic.getJSON(url);
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function filters() {
  const params = new URLSearchParams();
  for (const [key, value] of new FormData(el("filters"))) {
    if (String(value).trim()) params.set(key, String(value).trim());
  }
  return params;
}

function fillOptions(id, values) {
  const select = el(id);
  const current = select.value;
  while (select.options.length > 1) select.remove(1);
  for (const value of [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"))) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  select.value = current;
}

function displayPrice(p) {
  if (p.price === null) return missing;
  if (p.currency === "COP") return `${p.price_basis === "DESDE" ? "Desde " : ""}${money.format(p.price)}`;
  return `${decimal.format(p.price)} ${p.currency || "(moneda no informada)"}`;
}

function displayDate(value) {
  if (!value) return "Sin fecha";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("es-CO");
}

function linkTo(url, label) {
  const link = document.createElement("a");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Enlace de fuente no permitido.");
  link.href = parsed.href;
  link.textContent = label;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function attributes(p) {
  const table = document.createElement("table");
  table.className = "attributes";
  const fields = [
    ["Operación", p.offer_type], ["Inmueble", p.property_type], ["Barrio", p.neighborhood],
    ["Municipio", p.municipality], ["Precio publicado", displayPrice(p)],
    ["Área m²", p.area_m2 === null ? null : decimal.format(p.area_m2)],
    ["Habitaciones", p.bedrooms], ["Baños", p.bathrooms], ["Fuente", p.source],
    ["Fecha de captura", displayDate(p.retrieved_at)], ["Procedencia", p.origin],
    ["Ubicación", p.location_status], ["Identificador", p.id],
  ];
  for (const [name, value] of fields) {
    const row = table.insertRow();
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = name;
    row.append(th);
    row.insertCell().textContent = value === null || value === undefined || value === "" ? missing : String(value);
  }
  if (p.source_url) {
    const row = table.insertRow();
    row.insertCell().textContent = "Anuncio original";
    row.insertCell().append(linkTo(p.source_url, "Consultar fuente"));
  }
  return table;
}

function selectRecord(row, pan = false) {
  selectedId = row.properties.id;
  for (const layer of Object.values(layers)) layer.changed();
  el("details").replaceChildren(attributes(row.properties));
  if (row.geometry) {
    const coordinate = ol.proj.fromLonLat(row.geometry.coordinates);
    el("popup-content").replaceChildren(attributes(row.properties));
    el("popup").hidden = false;
    overlay.setPosition(coordinate);
    if (pan) {
      switchTab("map");
      map.getView().animate({ center: coordinate, zoom: Math.max(16, map.getView().getZoom()), duration: 350 });
    }
  } else {
    overlay.setPosition(undefined);
    el("popup").hidden = true;
    el("details").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function renderTable() {
  const body = el("rows");
  body.replaceChildren();
  const start = pageNumber * pageSize;
  for (const row of collection.slice(start, start + pageSize)) {
    const p = row.properties;
    const tr = document.createElement("tr");
    const values = [p.offer_type, p.property_type, p.neighborhood || missing, displayPrice(p),
      p.area_m2 === null ? missing : decimal.format(p.area_m2)];
    for (const value of values) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    }
    const source = document.createElement("td");
    source.textContent = p.source;
    const date = document.createElement("small");
    date.textContent = displayDate(p.retrieved_at);
    source.append(date);
    tr.append(source);
    const location = document.createElement("td");
    location.textContent = row.geometry ? "Coordenadas del origen" : "Sin coordenadas";
    tr.append(location);
    const cell = document.createElement("td");
    const button = document.createElement("button");
    button.textContent = "Ver ficha";
    button.addEventListener("click", () => selectRecord(row, Boolean(row.geometry)));
    cell.append(button);
    tr.append(cell);
    body.append(tr);
  }
  el("page-status").textContent = collection.length ?
    `${start + 1}–${Math.min(start + pageSize, collection.length)} de ${integer.format(collection.length)}` : "Sin resultados";
  el("previous").disabled = pageNumber === 0;
  el("next").disabled = start + pageSize >= collection.length;
}

function fitResults() {
  const extent = ol.extent.createEmpty();
  let count = 0;
  for (const key of Object.keys(sources)) {
    if (!layers[key].getVisible()) continue;
    for (const feature of sources[key].getFeatures()) {
      if (!featureVisible(key, feature)) continue;
      ol.extent.extend(extent, feature.getGeometry().getExtent());
      count += 1;
    }
  }
  if (count) map.getView().fit(extent, { padding: [50, 50, 60, 50], maxZoom: 17, duration: 300 });
  else setStatus("status", "No hay puntos visibles que encuadrar. Consulte las ofertas sin coordenadas en la tabla.");
}

async function loadOffers(initial = false) {
  const request = ++requestNumber;
  setStatus("status", globalThis.OICNEPublic ? "Consultando datos en Supabase…" : "Consultando datos locales…");
  try {
    const params = filters();
    const data = await getJSON(`/api/offers?${params}`);
    if (request !== requestNumber) return;
    collection = data.features;
    pageNumber = 0;
    if (initial) {
      fillOptions("property_type", collection.map((r) => r.properties.property_type));
      fillOptions("source", collection.map((r) => r.properties.source));
    }
    for (const key of Object.keys(sources)) {
      sources[key].clear();
      sources[key].addFeatures(geojson.readFeatures({
        type: "FeatureCollection", features: collection.filter((r) => r.properties.layer === key && r.geometry),
      }, { featureProjection: "EPSG:3857" }));
    }
    renderGroups();
    overlay.setPosition(undefined);
    el("popup").hidden = true;
    selectedId = null;
    el("details").textContent = "Seleccione un punto o una fila de resultados.";
    const summary = data.summary;
    el("k-total").textContent = integer.format(summary.total);
    el("k-mapped").textContent = integer.format(summary.mapped);
    el("k-unmapped").textContent = integer.format(summary.total - summary.mapped);
    el("k-priced").textContent = integer.format(summary.priced_cop);
    el("price-note").textContent = summary.median_cop === null ?
      "Mediana de precios: seleccione venta o arriendo para no mezclar operaciones; solo se consideran precios COP positivos." :
      `Mediana del precio publicado: ${money.format(summary.median_cop)} · ${integer.format(summary.priced_cop)} registros con precio COP. No es un avalúo.`;
    const counts = {};
    for (const row of collection) counts[row.properties.property_type] = (counts[row.properties.property_type] || 0) + 1;
    el("distribution").replaceChildren(...Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([key, count]) => {
      const item = document.createElement("span");
      item.textContent = `${key}: ${integer.format(count)}`;
      return item;
    }));
    el("warnings").replaceChildren(...data.warnings.map((message) => {
      const li = document.createElement("li"); li.textContent = message; return li;
    }));
    el("download").href = `/api/export.csv?${params}`;
    setStatus("status", `${integer.format(summary.total)} resultados · ${integer.format(summary.mapped)} con ubicación. Las casillas de capas solo afectan el mapa.`);
    renderTable();
  } catch (error) {
    if (request === requestNumber) setStatus("status", `No se actualizó la consulta: ${error.message}. Se conserva la selección anterior.`, true);
  }
}

async function loadSources() {
  try {
    const data = await getJSON("/api/sources");
    el("sources").replaceChildren();
    for (const source of data.sources) {
      const card = document.createElement("article");
      card.className = "source-card";
      const title = document.createElement("h3");
      title.textContent = source.name;
      const category = document.createElement("p");
      category.className = "note";
      category.textContent = `${source.category} · adaptador ${source.adapter}`;
      const report = source.update || source.diagnostic;
      const badge = document.createElement("span");
      badge.className = `badge ${report ? report.state : ""}`;
      const states = { capturado: "Datos reales capturados", error: "Acceso bloqueado o error", sin_datos: "Sin ofertas extraídas", pendiente: "Pendiente", robots_permite: "Robots permite" };
      badge.textContent = report ? (states[report.state] || report.state) : "Sin intento registrado";
      const detail = document.createElement("p");
      detail.className = "note";
      detail.textContent = report ? `${report.count} registros · ${displayDate(report.checked_at)}. ${report.message}` : source.note;
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = source.note;
      card.append(title, category, badge, detail, note);
      source.urls.forEach((url, index) => card.append(linkTo(url, `Abrir consulta ${index + 1} ↗`)));
      if (!source.reuse_reviewed) {
        const review = document.createElement("p");
        review.className = "note";
        review.textContent = "Condiciones de reutilización institucional: pendientes de revisión.";
        card.append(review);
      }
      el("sources").append(card);
    }
    setStatus("sources-status", `${data.sources.length} fuentes registradas. El estado refleja el último intento, no disponibilidad garantizada.`);
  } catch (error) {
    setStatus("sources-status", `No se pudieron cargar las fuentes: ${error.message}`, true);
  }
}

function switchTab(name) {
  for (const value of ["map", "table", "sources"]) {
    el(`panel-${value}`).hidden = value !== name;
    el(`tab-${value}`).setAttribute("aria-selected", String(value === name));
  }
  if (name === "map") map.updateSize();
}

map.on("singleclick", (event) => {
  const clicked = map.forEachFeatureAtPixel(event.pixel, (f, layer) =>
    Object.values(layers).includes(layer) ? f : undefined, { hitTolerance: 6 });
  if (clicked) {
    const row = collection.find((r) => r.properties.id === clicked.get("id"));
    if (row) selectRecord(row);
  }
});
el("close-popup").addEventListener("click", () => { overlay.setPosition(undefined); el("popup").hidden = true; });
el("basemap").addEventListener("change", switchBase);
el("extent").addEventListener("click", fitResults);
el("filters").addEventListener("submit", (event) => { event.preventDefault(); loadOffers(); });
el("clear-filters").addEventListener("click", () => { el("filters").reset(); loadOffers(); });
el("previous").addEventListener("click", () => { pageNumber -= 1; renderTable(); });
el("next").addEventListener("click", () => { pageNumber += 1; renderTable(); });
el("refresh").addEventListener("click", () => {
  if (globalThis.OICNEPublic) globalThis.OICNEPublic.invalidate();
  loadOffers(true); loadSources();
});
if (globalThis.OICNEPublic) el("download").addEventListener("click", async event => {
  event.preventDefault();
  try {
    const params = new URL(el("download").href).searchParams;
    const content = await globalThis.OICNEPublic.download(params);
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "ofertas_oicne.csv";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    setStatus("status", `No se pudo descargar el CSV: ${error.message}`, true);
  }
});
for (const key of Object.keys(layers)) el(`show-${key}`).addEventListener("change", (event) => {
  layers[key].setVisible(event.target.checked);
  overlay.setPosition(undefined);
  el("popup").hidden = true;
  renderGroups();
});
for (const name of ["map", "table", "sources"]) el(`tab-${name}`).addEventListener("click", () => switchTab(name));
let blocksLoaded = false;
el("show-blocks").addEventListener("change", async (event) => {
  const checkbox = event.target;
  if (checkbox.checked && !blocksLoaded) {
    checkbox.disabled = true;
    setStatus("blocks-status", "Cargando manzanas…");
    try {
      const data = await getJSON("/api/manzanas");
      blocksSource.addFeatures(geojson.readFeatures(data, { featureProjection: "EPSG:3857" }));
      blocksLoaded = true;
      setStatus("blocks-status", `${integer.format(data.features.length)} manzanas; visibles desde zoom 14, números de cuatro dígitos desde zoom 16.`);
    } catch (error) {
      checkbox.checked = false;
      setStatus("blocks-status", `No se cargaron las manzanas: ${error.message}`, true);
    } finally { checkbox.disabled = false; }
  }
  blocksLayer.setVisible(checkbox.checked);
});
switchBase();
loadOffers(true);
loadSources();

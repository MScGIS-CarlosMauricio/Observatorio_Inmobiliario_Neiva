"use strict";

(function (root) {
  const normalize = value => String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase().trim();
  const fields = ["id", "layer", "origin", "offer_type", "property_type", "price", "currency",
    "area_m2", "bedrooms", "bathrooms", "neighborhood", "municipality", "source", "source_url",
    "retrieved_at", "location_status", "price_basis"];

  function filterFeatures(rows, params) {
    const allowed = new Set(["q", "layer", "offer_type", "property_type", "source", "min_price", "max_price", "location"]);
    for (const key of params.keys()) {
      if (!allowed.has(key) || params.getAll(key).length !== 1) throw new Error("Filtro desconocido o repetido.");
    }
    const bounds = {};
    for (const key of ["min_price", "max_price"]) {
      if (!params.get(key)) continue;
      const value = Number(params.get(key).replace(",", "."));
      if (!Number.isFinite(value) || value < 0 || !params.get(key).trim()) {
        throw new Error("El precio debe ser un número finito no negativo.");
      }
      bounds[key] = value;
    }
    if ((bounds.min_price ?? 0) > (bounds.max_price ?? Infinity)) throw new Error("El precio mínimo no puede superar el máximo.");
    if (!["", "mapped", "unmapped"].includes(params.get("location") || "")) throw new Error("Filtro de ubicación inválido.");
    const query = normalize(params.get("q"));
    return rows.filter(row => {
      const p = row.properties;
      if (["layer", "offer_type", "property_type", "source"].some(key => params.get(key) && params.get(key) !== p[key])) return false;
      if (query && !normalize(["id", "neighborhood", "property_type", "source"].map(key => p[key] || "").join(" ")).includes(query)) return false;
      if (params.get("location") === "mapped" && !row.geometry) return false;
      if (params.get("location") === "unmapped" && row.geometry) return false;
      const price = p.currency === "COP" ? p.price : null;
      return !Object.keys(bounds).length || (price !== null && price >= (bounds.min_price ?? 0) && price <= (bounds.max_price ?? Infinity));
    });
  }

  function summary(rows) {
    const priced = rows.filter(r => r.properties.currency === "COP" && r.properties.price > 0);
    const prices = priced.map(r => r.properties.price).sort((a, b) => a - b);
    const operations = new Set(rows.filter(r => r.properties.price).map(r => r.properties.offer_type));
    const middle = Math.floor(prices.length / 2);
    const median = prices.length && operations.size <= 1 ?
      (prices.length % 2 ? prices[middle] : (prices[middle - 1] + prices[middle]) / 2) : null;
    return { total: rows.length, mapped: rows.filter(r => r.geometry).length,
      priced_cop: prices.length, median_cop: median };
  }

  function csv(rows) {
    const escape = value => {
      let text = value === null || value === undefined ? "" : String(value);
      if (typeof value === "string" && /^[\s]*[=+\-@\t\r]/.test(value)) text = "'" + text;
      return `"${text.replace(/"/g, '""')}"`;
    };
    return "\ufeff" + [[...fields, "longitude", "latitude"], ...rows.map(row =>
      [...fields.map(key => row.properties[key]), ...(row.geometry ? row.geometry.coordinates.slice(0, 2) : [null, null])]
    )].map(row => row.map(escape).join(",")).join("\r\n") + "\r\n";
  }

  function createClient(config) {
    if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(config.url) || !config.key.startsWith("sb_publishable_")) {
      throw new Error("Configuración pública Supabase inválida.");
    }
    const cache = new Map();
    async function dataset(name) {
      if (!cache.has(name)) {
        const request = (async () => {
          const response = await fetch(`${config.url}/rest/v1/rpc/oicne_dataset`, {
            method: "POST", headers: { apikey: config.key, "Content-Type": "application/json" },
            body: JSON.stringify({ dataset: name }), signal: AbortSignal.timeout(30000),
          });
          if (!response.ok) throw new Error(`Supabase HTTP ${response.status}: no se pudo consultar ${name}.`);
          const data = await response.json();
          if (name === "fuentes" ? !Array.isArray(data.sources) :
            data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
            throw new Error(`Respuesta de Supabase inválida para ${name}.`);
          }
          return data;
        })();
        cache.set(name, request);
        try { return await request; }
        catch (error) { cache.delete(name); throw error; }
      }
      return cache.get(name);
    }
    return {
      invalidate() { cache.clear(); },
      async getJSON(url) {
        const parsed = new URL(url, "https://oicne.local");
        if (parsed.pathname === "/api/sources") return dataset("fuentes");
        if (parsed.pathname === "/api/manzanas") return dataset("manzanas");
        if (parsed.pathname !== "/api/offers") throw new Error("Consulta OICNE no disponible.");
        const data = await dataset("ofertas");
        const features = filterFeatures(data.features, parsed.searchParams);
        return { ...data, features, summary: summary(features) };
      },
      async download(params) {
        const data = await dataset("ofertas");
        return csv(filterFeatures(data.features, params));
      },
    };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { filterFeatures, summary, csv, createClient };
  else root.OICNEPublic = createClient(root.OICNE_CONFIG);
})(globalThis);

// ── Play-origin helper ───────────────────────────────────────
// Best-effort 2-letter country of the request. Most CDNs / reverse proxies
// (Cloudflare, Vercel, Fastly, GCP, Netlify) inject the country as a header,
// so no GeoIP database is needed. Returns null when unknown.
function getCountry(req) {
  const h = req.headers;
  const raw =
    h["cf-ipcountry"] ||             // Cloudflare
    h["x-vercel-ip-country"] ||      // Vercel
    h["x-country-code"] ||           // generic
    h["fastly-geoip-countrycode"] || // Fastly
    h["x-appengine-country"] ||      // Google App Engine
    h["x-nf-geo-country"];           // Netlify
  if (!raw) return null;
  const cc = String(raw).trim().toUpperCase().slice(0, 2);
  // Cloudflare uses "XX"/"T1" for unknown/Tor; treat those as unknown.
  return /^[A-Z]{2}$/.test(cc) && cc !== "XX" && cc !== "T1" ? cc : null;
}

module.exports = { getCountry };

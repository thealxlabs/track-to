/**
 * TrackTO API — server.js v4
 * Public REST API for Toronto Transit Commission real-time data
 *
 * New in v4:
 *  - /api/v1/* versioned endpoints (old /api/* still works)
 *  - /api/v1/stops/search  — search stops by name or number
 *  - /api/v1/bunching      — detect vehicle bunching per route
 *  - /api/v1/subway        — Lines 1-4 dedicated status
 *  - /api/v1/trip          — simple trip planner (origin→dest stop)
 *  - /api/v1/stops/nearby  — stops near lat/lng
 *  - Rate limiting (120 req/min per IP)
 *  - X-RateLimit headers
 *  - /api/docs             — machine-readable OpenAPI-lite spec
 */

const http  = require("http");
const https = require("https");
const fs    = require("fs");

const PORT       = process.env.PORT || 3000;
const UMO_BASE   = "https://retro.umoiq.com/service/publicJSONFeed";
const ALERTS_URL = "https://alerts.ttc.ca/api/alerts/live-alerts";
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT || "120"); // req per min per IP

// ── HTTP ───────────────────────────────────────────────────────────────────
function get(url, ms = 9000) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { "User-Agent": "TrackTO/4.0 (api.trackto.ca)" }
    }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => { try { resolve(JSON.parse(buf)); } catch { reject(new Error("Bad JSON from upstream")); } });
    });
    req.on("error", reject);
    req.setTimeout(ms, () => { req.destroy(); reject(new Error("Upstream timeout")); });
  });
}

function umo(params) {
  return `${UMO_BASE}?${new URLSearchParams({ a: "ttc", ...params })}`;
}

// ── CACHE ─────────────────────────────────────────────────────────────────
const _cache = {};
function cached(k, ttl, fn) {
  const now = Date.now();
  if (_cache[k] && now - _cache[k].ts < ttl) return Promise.resolve(_cache[k].v);
  return fn().then(v => { _cache[k] = { ts: now, v }; return v; });
}

// ── RATE LIMITER ──────────────────────────────────────────────────────────
const _rl = {}; // ip → { count, reset }
function rateCheck(ip) {
  const now = Date.now();
  if (!_rl[ip] || now > _rl[ip].reset) _rl[ip] = { count: 0, reset: now + 60000 };
  _rl[ip].count++;
  return {
    ok:        _rl[ip].count <= RATE_LIMIT,
    count:     _rl[ip].count,
    limit:     RATE_LIMIT,
    remaining: Math.max(0, RATE_LIMIT - _rl[ip].count),
    reset:     Math.ceil(_rl[ip].reset / 1000),
  };
}
// Prune stale IP entries every 5min
setInterval(() => { const now = Date.now(); for (const ip in _rl) if (now > _rl[ip].reset + 5000) delete _rl[ip]; }, 300000);

// ── RESPONSE HELPERS ──────────────────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  res.setHeader("Access-Control-Expose-Headers", "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset");
}
function setRLHeaders(res, rl) {
  res.setHeader("X-RateLimit-Limit",     rl.limit);
  res.setHeader("X-RateLimit-Remaining", rl.remaining);
  res.setHeader("X-RateLimit-Reset",     rl.reset);
}

const send = (res, d, s = 200) => {
  cors(res);
  res.setHeader("Content-Type", "application/json");
  res.writeHead(s);
  res.end(JSON.stringify({ ok: true, ...d }));
};
const fail = (res, message, status = 500, code = "ERROR") => {
  cors(res);
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(JSON.stringify({ ok: false, error: { code, message, status } }));
};

// ── NORMALIZERS ───────────────────────────────────────────────────────────
const arr = x => !x ? [] : Array.isArray(x) ? x : [x];

function normVehicle(v) {
  return {
    id:    v.id,
    route: v.routeTag,
    dir:   v.dirTag || "",
    lat:   parseFloat(v.lat),
    lng:   parseFloat(v.lon),
    hdg:   parseInt(v.heading, 10) || 0,
    spd:   parseFloat(v.speedKmHr) || 0,
    age:   parseInt(v.secsSinceReport, 10) || 0,
    pred:  v.predictable === "true",
  };
}

function normRoutes(raw) {
  return arr(raw?.route).map(r => ({ tag: r.tag, title: r.title }));
}

function normRouteDetail(raw) {
  const r = raw?.route;
  if (!r) return null;
  return {
    tag:        r.tag,
    title:      r.title,
    color:      r.color ? "#" + r.color : "#da291c",
    directions: arr(r.direction).map(d => ({
      tag:   d.tag, title: d.title,
      stops: arr(d.stop).map(s => typeof s === "string" ? s : s.tag),
    })),
    stops: arr(r.stop).map(s => ({
      tag: s.tag, title: s.title, stopId: s.stopId || s.tag,
      lat: parseFloat(s.lat), lng: parseFloat(s.lon),
    })),
    paths: arr(r.path).map(p =>
      arr(p.point).map(pt => [parseFloat(pt.lat), parseFloat(pt.lon)])
    ),
  };
}

function normArrivals(raw) {
  const out = [];
  arr(raw?.predictions).forEach(p => {
    const msgs = arr(p.message).map(m => m.text || "").filter(Boolean);
    arr(p.direction).forEach(d => {
      arr(d.prediction).forEach(pr => {
        out.push({
          route: p.routeTag, routeTitle: p.routeTitle,
          stop: p.stopTag, stopTitle: p.stopTitle,
          dir: d.title, dirTag: d.tag,
          min: parseInt(pr.minutes, 10),
          sec: parseInt(pr.seconds, 10),
          epoch: parseInt(pr.epochTime, 10),
          vehicle: pr.vehicle,
          delayed: pr.delayed === "true",
          layover: pr.affectedByLayover === "true",
          msgs,
        });
      });
    });
    if (!p.direction && p.dirTitleBecauseNoPredictions) {
      out.push({
        route: p.routeTag, routeTitle: p.routeTitle,
        stop: p.stopTag, stopTitle: p.stopTitle,
        dir: p.dirTitleBecauseNoPredictions, min: null, noPred: true,
      });
    }
  });
  return out.sort((a, b) => (a.sec ?? 999999) - (b.sec ?? 999999));
}

function normAlerts(raw) {
  return [...arr(raw?.routes), ...arr(raw?.accessibility)].map(a => ({
    id:       a.id,
    title:    a.title || a.headerText || "Service Alert",
    desc:     a.description || "",
    routes:   a.route ? a.route.split(",").map(r => r.trim()) : [],
    type:     a.routeType || "",
    severity: a.severity === "Critical" ? "major" : a.severity === "Minor" ? "minor" : "info",
    effect:   a.effectDesc || a.effect || "",
    cause:    a.causeDescription || a.cause || "",
    updated:  a.lastUpdated || null,
    url:      a.url || null,
  }));
}

function normMessages(raw) {
  return arr(raw?.message).map(m => ({
    id: m.id, text: m.text || "",
    routes: arr(m.route).map(r => r.tag),
  })).filter(m => m.text);
}

// ── VEHICLE STATE ─────────────────────────────────────────────────────────
let vMap      = {};  // id → vehicle + _ts + _hist
let umoTs     = 0;
const HIST_LEN = 8; // positions to keep per vehicle for trail

async function refreshVehicles() {
  try {
    const raw = await get(umo({ command: "vehicleLocations", t: umoTs }));
    if (raw.lastTime?.time) umoTs = raw.lastTime.time;
    const now = Date.now();
    arr(raw.vehicle).forEach(v => {
      const norm = normVehicle(v);
      const prev = vMap[v.id];
      // Append to position history for trail feature
      const hist = prev?._hist || [];
      if (prev && (prev.lat !== norm.lat || prev.lng !== norm.lng)) {
        hist.push([prev.lat, prev.lng, prev._ts]);
        if (hist.length > HIST_LEN) hist.shift();
      }
      vMap[v.id] = { ...norm, _ts: now, _hist: hist };
    });
    for (const id in vMap) { if (vMap[id].age > 300) delete vMap[id]; }
  } catch (e) { console.error("Vehicle poll:", e.message); }
}

// Bunching computation — runs after each vehicle refresh
// Two vehicles on the same route within ~400m (≈0.004° lat) = bunching
function computeBunching() {
  const byRoute = {};
  for (const v of Object.values(vMap)) {
    if (!byRoute[v.route]) byRoute[v.route] = [];
    byRoute[v.route].push(v);
  }
  const bunches = [];
  for (const [route, vehicles] of Object.entries(byRoute)) {
    if (vehicles.length < 2) continue;
    for (let i = 0; i < vehicles.length; i++) {
      for (let j = i + 1; j < vehicles.length; j++) {
        const a = vehicles[i], b = vehicles[j];
        const dist = Math.sqrt((a.lat-b.lat)**2 + (a.lng-b.lng)**2) * 111000; // metres
        if (dist < 400) {
          bunches.push({ route, vehicles: [a.id, b.id], dist: Math.round(dist), lat: (a.lat+b.lat)/2, lng: (a.lng+b.lng)/2 });
        }
      }
    }
  }
  return bunches;
}

refreshVehicles().then(() => setInterval(refreshVehicles, 1000));

// ── STOP INDEX (built after first route cache warm-up) ────────────────────
// Maps stopId/tag → { tag, title, stopId, lat, lng, routes[] }
let stopIndex = {}; // tag → stop
let stopByNum = {}; // stopId → stop

async function buildStopIndex() {
  try {
    const routes = await cached("routes", 3600_000, async () => {
      const raw = await get(umo({ command: "routeList" }));
      return normRoutes(raw);
    });
    // Load all route configs in parallel batches of 10
    const batch = async (tags) => {
      const results = await Promise.allSettled(tags.map(tag =>
        cached(`route_${tag}`, 3600_000, async () => {
          const raw = await get(umo({ command: "routeConfig", r: tag }));
          return normRouteDetail(raw);
        })
      ));
      return results.filter(r => r.status === "fulfilled").map(r => r.value).filter(Boolean);
    };
    const tags  = routes.map(r => r.tag);
    const size  = 10;
    for (let i = 0; i < tags.length; i += size) {
      const details = await batch(tags.slice(i, i + size));
      for (const d of details) {
        for (const s of (d.stops || [])) {
          if (!stopIndex[s.tag]) stopIndex[s.tag] = { ...s, routes: [] };
          if (!stopIndex[s.tag].routes.includes(d.tag)) stopIndex[s.tag].routes.push(d.tag);
          if (s.stopId) stopByNum[s.stopId] = stopIndex[s.tag];
        }
      }
      await new Promise(r => setTimeout(r, 200)); // polite delay between batches
    }
    console.log(`Stop index built: ${Object.keys(stopIndex).length} stops`);
  } catch (e) { console.error("Stop index build failed:", e.message); }
}

// Build stop index 5 seconds after startup (let route cache warm first)
setTimeout(buildStopIndex, 5000);

// ── HANDLERS ──────────────────────────────────────────────────────────────

function hVehicles(res, q) {
  const since   = q.since ? parseInt(q.since) : 0;
  const all     = Object.values(vMap);
  const byRoute = q.route ? all.filter(v => v.route === q.route) : all;
  const out     = since ? byRoute.filter(v => v._ts >= since) : byRoute;
  // Strip internal _ts/_hist from public response
  const clean = out.map(({ _ts, _hist, ...v }) => v);
  send(res, { full: !since, total: byRoute.length, vehicles: clean, ts: Date.now(), umoTs });
}

function hVehicleTrail(res, q) {
  if (!q.id) return fail(res, "?id= required", 400, "MISSING_PARAM");
  const v = vMap[q.id];
  if (!v) return fail(res, "Vehicle not found", 404, "NOT_FOUND");
  const { _ts, _hist, ...clean } = v;
  send(res, { vehicle: clean, trail: _hist || [] });
}

async function hRoutes(res) {
  try {
    const routes = await cached("routes", 3600_000, async () => {
      const raw = await get(umo({ command: "routeList" }));
      return normRoutes(raw);
    });
    send(res, { count: routes.length, routes });
  } catch (e) { fail(res, e.message); }
}

async function hRoute(res, q) {
  if (!q.tag) return fail(res, "?tag= required", 400, "MISSING_PARAM");
  try {
    const detail = await cached(`route_${q.tag}`, 3600_000, async () => {
      const raw = await get(umo({ command: "routeConfig", r: q.tag }));
      return normRouteDetail(raw);
    });
    if (!detail) return fail(res, "Route not found", 404, "NOT_FOUND");
    const vehicles   = Object.values(vMap).filter(v => v.route === q.tag);
    const liveCount  = vehicles.length;
    const bunching   = computeBunching().filter(b => b.route === q.tag);
    send(res, { ...detail, liveCount, bunching });
  } catch (e) { fail(res, e.message); }
}

async function hArrivals(res, q) {
  if (!q.stop) return fail(res, "?stop= required", 400, "MISSING_PARAM");
  try {
    const url = q.route
      ? umo({ command: "predictions", r: q.route, s: q.stop })
      : umo({ command: "predictions", stopId: q.stop });
    const raw = await get(url);
    send(res, { arrivals: normArrivals(raw), ts: Date.now() });
  } catch (e) { fail(res, e.message); }
}

async function hMessages(res, q) {
  try {
    const p   = q.route ? { command: "messages", r: q.route } : { command: "messages" };
    const raw = await get(umo(p));
    send(res, { messages: normMessages(raw) });
  } catch { send(res, { messages: [] }); }
}

async function hAlerts(res, q) {
  try {
    const alerts = await cached("alerts", 90_000, async () => {
      const raw = await get(ALERTS_URL);
      return normAlerts(raw);
    });
    const out = q.route ? alerts.filter(a => a.routes.includes(q.route)) : alerts;
    send(res, { count: out.length, alerts: out });
  } catch (e) {
    send(res, { count: 0, alerts: [] });
  }
}

function hBunching(res, q) {
  const bunches = computeBunching();
  const out     = q.route ? bunches.filter(b => b.route === q.route) : bunches;
  send(res, { count: out.length, bunching: out, ts: Date.now() });
}

async function hSubway(res) {
  const LINES = { "1": "Yonge–University", "2": "Bloor–Danforth", "3": "Scarborough RT", "4": "Sheppard" };
  try {
    const [alerts, vehicles] = await Promise.all([
      cached("alerts", 90_000, async () => normAlerts(await get(ALERTS_URL))),
      Promise.resolve(Object.values(vMap)),
    ]);
    const lines = Object.entries(LINES).map(([tag, name]) => {
      const lineVehicles = vehicles.filter(v => v.route === tag);
      const lineAlerts   = alerts.filter(a => a.routes.includes(tag));
      const moving       = lineVehicles.filter(v => v.spd > 0);
      const avgSpd       = moving.length ? Math.round(moving.reduce((s,v)=>s+v.spd,0)/moving.length) : 0;
      const severity     = lineAlerts.some(a=>a.severity==="major") ? "major"
                         : lineAlerts.some(a=>a.severity==="minor") ? "minor"
                         : lineAlerts.length ? "info" : "ok";
      return { tag, name, vehicles: lineVehicles.length, alerts: lineAlerts, avgSpd, severity };
    });
    send(res, { lines });
  } catch (e) { fail(res, e.message); }
}

function hStopSearch(res, q) {
  if (!q.q && !q.id) return fail(res, "?q= or ?id= required", 400, "MISSING_PARAM");
  if (Object.keys(stopIndex).length === 0) return fail(res, "Stop index still building, retry in 30s", 503, "INDEX_BUILDING");

  // Search by stop number
  if (q.id) {
    const stop = stopByNum[q.id] || stopIndex[q.id];
    if (!stop) return fail(res, "Stop not found", 404, "NOT_FOUND");
    return send(res, { stops: [stop] });
  }

  // Search by name
  const lq = q.q.toLowerCase().trim();
  const limit = Math.min(parseInt(q.limit || "20"), 50);
  const results = Object.values(stopIndex)
    .filter(s => s.title.toLowerCase().includes(lq))
    .slice(0, limit);
  send(res, { count: results.length, stops: results });
}

function hStopsNearby(res, q) {
  if (!q.lat || !q.lng) return fail(res, "?lat= and ?lng= required", 400, "MISSING_PARAM");
  if (Object.keys(stopIndex).length === 0) return fail(res, "Stop index still building", 503, "INDEX_BUILDING");

  const lat    = parseFloat(q.lat);
  const lng    = parseFloat(q.lng);
  const radius = parseFloat(q.radius || "500"); // metres
  const limit  = Math.min(parseInt(q.limit || "20"), 50);

  const nearby = Object.values(stopIndex)
    .map(s => ({ ...s, dist: Math.round(Math.sqrt((s.lat-lat)**2 + (s.lng-lng)**2) * 111000) }))
    .filter(s => s.dist <= radius)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);

  send(res, { count: nearby.length, stops: nearby, lat, lng, radius });
}

// Trip planner — finds routes that serve both origin and destination stops
// Returns routes that have BOTH stops in ANY direction, ordered by fewer stops between them
async function hTrip(res, q) {
  if (!q.from || !q.to) return fail(res, "?from= and ?to= required (stop tags)", 400, "MISSING_PARAM");
  if (Object.keys(stopIndex).length === 0) return fail(res, "Stop index still building", 503, "INDEX_BUILDING");

  const fromStop = stopIndex[q.from] || stopByNum[q.from];
  const toStop   = stopIndex[q.to]   || stopByNum[q.to];
  if (!fromStop) return fail(res, `Origin stop '${q.from}' not found`, 404, "NOT_FOUND");
  if (!toStop)   return fail(res, `Destination stop '${q.to}' not found`, 404, "NOT_FOUND");

  // Find routes that serve both stops
  const sharedRoutes = fromStop.routes.filter(r => toStop.routes.includes(r));

  if (!sharedRoutes.length) {
    // Try 1-transfer: find routes from origin + routes from dest, find common intermediate stop
    const transfers = [];
    for (const rFrom of fromStop.routes) {
      for (const rTo of toStop.routes) {
        if (rFrom === rTo) continue;
        // Find stops in common between the two routes
        const fromDetail = _cache[`route_${rFrom}`]?.v;
        const toDetail   = _cache[`route_${rTo}`]?.v;
        if (!fromDetail || !toDetail) continue;
        const fromStopTags = new Set((fromDetail.stops||[]).map(s=>s.tag));
        const common = (toDetail.stops||[]).filter(s => fromStopTags.has(s.tag));
        if (common.length) {
          transfers.push({ type: "transfer", from: rFrom, to: rTo, transferAt: common[0] });
        }
      }
    }
    return send(res, {
      from: fromStop, to: toStop,
      direct: [], transfers: transfers.slice(0, 5),
      note: transfers.length ? "No direct route. Transfer options shown." : "No routes found connecting these stops.",
    });
  }

  // Score direct routes by stop count between origin and dest
  const scored = await Promise.all(sharedRoutes.map(async tag => {
    try {
      const detail = await cached(`route_${tag}`, 3600_000, async () =>
        normRouteDetail(await get(umo({ command: "routeConfig", r: tag })))
      );
      let bestStops = Infinity, bestDir = null;
      for (const dir of (detail?.directions || [])) {
        const fi = dir.stops.indexOf(q.from);
        const ti = dir.stops.indexOf(q.to);
        if (fi !== -1 && ti !== -1 && ti > fi) {
          const count = ti - fi;
          if (count < bestStops) { bestStops = count; bestDir = dir.title; }
        }
      }
      const vehicles = Object.values(vMap).filter(v => v.route === tag);
      return { route: tag, routeTitle: detail?.title || tag, direction: bestDir, stops: bestStops === Infinity ? null : bestStops, vehicles: vehicles.length };
    } catch { return { route: tag, stops: null, vehicles: 0 }; }
  }));

  scored.sort((a, b) => (a.stops ?? 999) - (b.stops ?? 999));
  send(res, { from: fromStop, to: toStop, direct: scored, transfers: [], note: `${scored.length} direct route(s) found.` });
}

function hHealth(res) {
  const uptime = process.uptime();
  send(res, {
    status:    "ok",
    version:   "4.0.0",
    uptime:    Math.round(uptime),
    uptimeStr: `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`,
    vehicles:  Object.keys(vMap).length,
    stops:     Object.keys(stopIndex).length,
    stopIndexReady: Object.keys(stopIndex).length > 0,
    umoTs,
    ts: Date.now(),
  });
}

function hDocs(res) {
  const base = `http://localhost:${PORT}`;
  cors(res);
  res.setHeader("Content-Type", "application/json");
  res.writeHead(200);
  res.end(JSON.stringify({
    name:    "TrackTO API",
    version: "4.0.0",
    base:    base,
    rateLimit: `${RATE_LIMIT} requests/minute per IP`,
    endpoints: [
      { method:"GET", path:"/api/v1/vehicles",            params:["since (ts)","route (tag)"],        desc:"Live vehicle positions. Use ?since= for delta updates (only changed vehicles)." },
      { method:"GET", path:"/api/v1/vehicles/trail",      params:["id (required)"],                   desc:"Position history trail for a specific vehicle." },
      { method:"GET", path:"/api/v1/routes",              params:[],                                  desc:"All TTC routes. Cached 1 hour." },
      { method:"GET", path:"/api/v1/route",               params:["tag (required)"],                  desc:"Route detail: stops, paths, directions, live vehicle count, bunching." },
      { method:"GET", path:"/api/v1/arrivals",            params:["stop (required)","route"],         desc:"Arrival predictions at a stop." },
      { method:"GET", path:"/api/v1/alerts",              params:["route"],                           desc:"Live service alerts. Cached 90s. Filter by route with ?route=." },
      { method:"GET", path:"/api/v1/bunching",            params:["route"],                           desc:"Detect vehicle bunching (<400m apart on same route)." },
      { method:"GET", path:"/api/v1/subway",              params:[],                                  desc:"Subway Lines 1-4 live status." },
      { method:"GET", path:"/api/v1/stops/search",        params:["q (name)","id (stop number)"],     desc:"Search stops by name or stop number." },
      { method:"GET", path:"/api/v1/stops/nearby",        params:["lat","lng","radius (m)","limit"],  desc:"Stops within radius metres of a coordinate." },
      { method:"GET", path:"/api/v1/trip",                params:["from (stop tag)","to (stop tag)"], desc:"Trip planner: find routes or transfers between two stops." },
      { method:"GET", path:"/api/v1/messages",            params:["route"],                           desc:"Service messages for a route." },
      { method:"GET", path:"/api/v1/health",              params:[],                                  desc:"API health, uptime, vehicle count, stop index status." },
      { method:"GET", path:"/api/docs",                   params:[],                                  desc:"This document." },
    ],
    examples: [
      `${base}/api/v1/vehicles?since=0`,
      `${base}/api/v1/vehicles?route=501`,
      `${base}/api/v1/vehicles/trail?id=4231`,
      `${base}/api/v1/route?tag=501`,
      `${base}/api/v1/arrivals?stop=3318&route=501`,
      `${base}/api/v1/bunching?route=504`,
      `${base}/api/v1/stops/search?q=spadina`,
      `${base}/api/v1/stops/nearby?lat=43.6532&lng=-79.3832&radius=300`,
      `${base}/api/v1/trip?from=3318&to=3007`,
      `${base}/api/v1/subway`,
      `${base}/api/v1/alerts?route=501`,
    ],
  }, null, 2));
}

// ── ROUTER ────────────────────────────────────────────────────────────────
const ROUTES = {
  "/api/v1/vehicles":       hVehicles,
  "/api/v1/vehicles/trail": hVehicleTrail,
  "/api/v1/routes":         hRoutes,
  "/api/v1/route":          hRoute,
  "/api/v1/arrivals":       hArrivals,
  "/api/v1/alerts":         hAlerts,
  "/api/v1/messages":       hMessages,
  "/api/v1/bunching":       hBunching,
  "/api/v1/subway":         hSubway,
  "/api/v1/stops/search":   hStopSearch,
  "/api/v1/stops/nearby":   hStopsNearby,
  "/api/v1/trip":           hTrip,
  "/api/v1/health":         hHealth,
  // Legacy aliases
  "/api/vehicles":          hVehicles,
  "/api/routes":            hRoutes,
  "/api/route":             hRoute,
  "/api/arrivals":          hArrivals,
  "/api/alerts":            hAlerts,
  "/api/messages":          hMessages,
  "/api/health":            hHealth,
  "/api/docs":              hDocs,
};

// ── STATIC FILE MIME TYPES ────────────────────────────────────────────────
const MIME = {
  ".html": "text/html",
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
};

// ── MAIN REQUEST HANDLER (exported for Vercel) ────────────────────────────
async function handler(req, res) {
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); res.end(); return; }

  const u   = new URL(req.url, `http://localhost:${PORT}`);
  const q   = Object.fromEntries(u.searchParams);
  const ip  = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "unknown";

  // Rate limit all /api/* requests
  if (u.pathname.startsWith("/api")) {
    const rl = rateCheck(ip);
    setRLHeaders(res, rl);
    if (!rl.ok) return fail(res, `Rate limit exceeded. ${RATE_LIMIT} requests/minute. Resets at ${new Date(rl.reset*1000).toISOString()}.`, 429, "RATE_LIMITED");
  }

  const routeHandler = ROUTES[u.pathname];
  if (routeHandler) {
    try {
      await routeHandler(res, q);
    } catch (e) {
      console.error(u.pathname, e.message);
      fail(res, "Internal server error", 500, "INTERNAL_ERROR");
    }
    return;
  }

  // Serve static files from ./public/
  if (!u.pathname.startsWith("/api")) {
    const ext = u.pathname.match(/\.[^./]+$/)?.[0] || "";
    // For paths with a known static extension, try to serve the file directly
    if (ext && MIME[ext]) {
      const filePath = `./public${u.pathname}`;
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { "Content-Type": MIME[ext] });
        res.end(fs.readFileSync(filePath));
        return;
      }
    }
    // SPA fallback: serve index.html for all non-API, non-asset routes
    const indexPath = "./public/index.html";
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(indexPath));
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>TrackTO</h1>");
    }
    return;
  }

  fail(res, "Endpoint not found", 404, "NOT_FOUND");
}

module.exports = handler;

if (require.main === module) {
  http.createServer(handler).listen(PORT, () => {
    console.log(`\n▶  TrackTO v4  →  http://localhost:${PORT}`);
    console.log(`   Frontend:    http://localhost:${PORT}/`);
    console.log(`   API Docs:    http://localhost:${PORT}/api/docs`);
    console.log(`   Rate limit:  ${RATE_LIMIT} req/min per IP\n`);
    console.log("   Endpoints:");
    console.log("   GET /api/v1/vehicles?since=<ts>            delta positions");
    console.log("   GET /api/v1/vehicles/trail?id=<id>         vehicle trail");
    console.log("   GET /api/v1/routes                         all routes");
    console.log("   GET /api/v1/route?tag=501                  route detail + bunching");
    console.log("   GET /api/v1/arrivals?stop=3318             predictions");
    console.log("   GET /api/v1/bunching                       bunching system-wide");
    console.log("   GET /api/v1/subway                         Lines 1-4 status");
    console.log("   GET /api/v1/stops/search?q=spadina         stop search");
    console.log("   GET /api/v1/stops/nearby?lat=43.65&lng=-79.38  nearby stops");
    console.log("   GET /api/v1/trip?from=3318&to=3007         trip planner\n");
  });
}

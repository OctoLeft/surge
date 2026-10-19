/*
 * NordVPN WireGuard selector for Surge.
 *
 * One file, three roles (picked by the globals Surge provides):
 *   http-request  serves http://nord.surge/{setup,scaffold,status}
 *   dns           resolves <cc>-<nn>.nord.surge to the server assigned to that slot
 *   cron/generic  fetches candidates, probes their round-trip time from Surge, keeps the best N per country
 *   event         re-runs the update when this device has no assignment yet or the last one is stale
 *
 * Why slots: WireGuard sections cannot be delivered through policy-path, and a script-served
 * #!include deadlocks a full engine restart. So the profile holds static sections whose peer
 * endpoint is a *.nord.surge hostname; NordVPN uses one public key per city, so any server in
 * the slot's city can be swapped in by changing DNS alone.
 */

const NORD_API = "https://api.nordvpn.com/v1";
const STATE_KEY = "nord_state";
const DNS_KEY = "nord_dns";
const SECRET_KEY = "nord_secret";
const INDEX_KEY = "nord_countries";
const HOST_SUFFIX = ".nord.surge";
const UNDERLAY_GROUP = "Nord-Underlay";
const UNDERLAY_ALT = "Nord-Direct";
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const STATS_TTL = 7 * DAY;
const INDEX_TTL = 7 * DAY;
const INCUMBENT_BONUS = 0.9;
const PROBE_TIMEOUT = 3;
const PROBE_SAMPLES = 3;
const PROBE_CONCURRENCY = 6;
const LANES = 3;
const STALE_AFTER = 26 * HOUR;
const RUN_LOCK = 10 * 60 * 1000;
const DEFAULT_COUNTRIES = "HK+TW+JP+SG+KR+US+GB+AU+DE";

// ---------- pure helpers (unit-tested with node) ----------

function parseArgs(str) {
  const out = {};
  String(str || "").split("&").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  });
  return out;
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function makeConfig(args) {
  const countries = String(args.countries || DEFAULT_COUNTRIES)
    .toUpperCase()
    .split(/[+\s,;|]+/)
    .filter((c) => /^[A-Z]{2}$/.test(c));
  const cities = {};
  String(args.cities || "").split(";").forEach((entry) => {
    const i = entry.indexOf(":");
    if (i > 0) cities[entry.slice(0, i).trim().toUpperCase()] = entry.slice(i + 1).trim();
  });
  return {
    countries: countries.filter((c, i) => countries.indexOf(c) === i),
    cities,
    // Each slot that carries traffic holds one of the ~10 sessions NordVPN allows per key.
    slots: clampInt(args.slots, 3, 1, 10),
    candidates: clampInt(args.candidates, 30, 3, 60),
    notify: (args.notify || "error").toLowerCase(),
  };
}

const pad2 = (n) => (n < 10 ? "0" : "") + n;
const slotLabel = (cc, i) => cc.toLowerCase() + "-" + pad2(i);
const sectionName = (cc, i) => "nord-" + slotLabel(cc, i);
const policyName = (cc, i) => "Nord " + cc + " " + pad2(i);
const groupName = (cc) => "Nord-" + cc;

function recommendationsUrl(opts) {
  const q = ["limit=" + (opts.limit || 30)];
  const add = (k, v) => q.push(encodeURIComponent(k) + (v === undefined ? "" : "=" + encodeURIComponent(v)));
  if (opts.cityId) add("filters[country_city_id]", opts.cityId);
  else add("filters[country_id]", opts.countryId);
  add("filters[servers_technologies][identifier]", "wireguard_udp");
  add("filters[servers_groups][identifier]", "legacy_standard");
  [
    "hostname", "station", "load", "status",
    "locations.country.code", "locations.country.city.name",
    "groups.identifier", "technologies.identifier", "technologies.metadata",
  ].forEach((f) => add("fields[servers." + f + "]"));
  return NORD_API + "/servers/recommendations?" + q.join("&");
}

function parseServers(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  list.forEach((s) => {
    const loc = (s.locations && s.locations[0]) || {};
    const country = loc.country || {};
    const wg = (s.technologies || []).find((t) => t.identifier === "wireguard_udp");
    const pk = wg && (wg.metadata || []).find((m) => m.name === "public_key");
    // Dedicated-IP servers report low load but reject regular subscriptions.
    const standard = !s.groups || s.groups.some((g) => g.identifier === "legacy_standard");
    if (!s.hostname || !s.station || !pk || !standard) return;
    if (s.status && s.status !== "online") return;
    out.push({
      host: s.hostname,
      ip: s.station,
      load: Number(s.load) || 0,
      cc: country.code || null,
      city: (country.city && country.city.name) || null,
      publicKey: pk.value,
    });
  });
  return out;
}

function buildIndex(countries) {
  const map = {};
  (countries || []).forEach((c) => {
    const cities = {};
    (c.cities || []).forEach((ci) => { cities[String(ci.name).toLowerCase()] = { id: ci.id, name: ci.name }; });
    map[c.code] = { id: c.id, name: c.name, cities };
  });
  return map;
}

function chooseLayout(cc, servers, index) {
  const first = servers[0];
  if (!first) throw new Error(cc + ": NordVPN 没有返回可用的 WireGuard 标准服务器");
  const entry = index[cc] || { cities: {} };
  const city = entry.cities[String(first.city).toLowerCase()];
  return {
    id: entry.id,
    city: first.city,
    cityId: city ? city.id : null,
    publicKey: first.publicKey,
  };
}

function emptySlots(n) {
  const a = [];
  for (let i = 0; i < n; i++) a.push(null);
  return a;
}

function normalizeSlots(slots, n) {
  const a = (Array.isArray(slots) ? slots : []).slice(0, n);
  while (a.length < n) a.push(null);
  return a;
}

function scoreOf(server, rtt, isIncumbent) {
  const loadFactor = 1 + (server.load || 0) / 200;
  return rtt * loadFactor * (isIncumbent ? INCUMBENT_BONUS : 1);
}

/*
 * Choose the servers for a country's slots from probed candidates.
 * Incumbents that are still among the winners keep their slot, so only slots
 * whose server actually changed see a new DNS answer (and a new Nord session).
 * Slots that cannot be filled with a probed winner keep their current server,
 * or fall back to NordVPN's own ordering.
 */
function pickSlots(current, cands, rtt, n) {
  const slots = normalizeSlots(current, n);
  const incumbent = {};
  slots.forEach((s) => { if (s) incumbent[s.host] = true; });
  const ranked = cands
    .filter((c) => typeof rtt[c.host] === "number")
    .map((c) => ({ c, score: scoreOf(c, rtt[c.host], incumbent[c.host]) }))
    .sort((x, y) => x.score - y.score)
    .slice(0, n)
    .map((r) => r.c);
  const byHost = {};
  cands.forEach((c) => { byHost[c.host] = c; });
  const winner = {};
  ranked.forEach((c) => { winner[c.host] = true; });

  const next = slots.map((s) => (s && winner[s.host] ? byHost[s.host] : null));
  const used = {};
  next.forEach((s) => { if (s) used[s.host] = true; });
  const queue = ranked.filter((c) => !used[c.host]);
  for (let i = 0; i < n; i++) {
    if (next[i] || !queue.length) continue;
    next[i] = queue.shift();
    used[next[i].host] = true;
  }
  const spare = cands.filter((c) => !used[c.host] && typeof rtt[c.host] !== "number");
  for (let i = 0; i < n; i++) {
    if (next[i]) continue;
    const keep = slots[i] && !used[slots[i].host] && typeof rtt[slots[i].host] !== "number" ? slots[i] : null;
    next[i] = keep || spare.shift() || null;
    if (next[i]) used[next[i].host] = true;
  }
  return next;
}

// A TCP probe cannot establish that a WireGuard peer is dead. Keep assigned
// endpoints even when absent from recommendations or temporarily unreachable.
// Ranking is only used to fill empty slots, never to rotate live sessions.
function stableSlots(current, cands, rtt, n) {
  const slots = normalizeSlots(current, n);
  const used = new Set(slots.filter(Boolean).map((s) => s.host));
  const fresh = {};
  cands.forEach((s) => { fresh[s.host] = s; });
  const available = cands.filter((s) => !used.has(s.host));
  const queue = pickSlots([], available, rtt, n).filter(Boolean);
  return slots.map((s) => {
    if (s) {
      // Refresh metadata without changing the assigned IP or endpoint identity.
      return Object.assign({}, s, fresh[s.host] ? { load: fresh[s.host].load } : {});
    }
    return queue.shift() || null;
  });
}

function bestOf(samples) {
  const ok = samples.filter((v) => typeof v === "number");
  return ok.length ? Math.min.apply(null, ok) : null;
}

function updateStats(stats, rtt, now) {
  Object.keys(rtt).forEach((host) => { stats[host] = { at: now, rtt: rtt[host] }; });
  Object.keys(stats).forEach((h) => {
    const st = stats[h];
    if (!st || !st.at || now - st.at > STATS_TTL) delete stats[h];
  });
  return stats;
}

/*
 * Every device shares one NordLynx key, and a server keeps only the newest session
 * per key, so two devices on the same server keep kicking each other off.
 * Each device kind therefore draws from its own disjoint share of the servers.
 */
function deviceLane(env) {
  const e = env || {};
  if (e.system === "macOS") return 0;
  if (/^iPad/i.test(String(e["device-model"] || ""))) return 2;
  return 1;
}

function serverLane(host) {
  const m = String(host).match(/(\d+)/);
  return m ? parseInt(m[1], 10) % LANES : 0;
}

/*
 * $persistentStore is per device, so a phone that receives the profile through
 * iCloud starts with no assignment; event triggers use this to bootstrap it.
 */
function needsRun(state, dnsMap, cfg, now) {
  if (state.runningAt && now - state.runningAt < RUN_LOCK) return false;
  if (!state.lastRun || now - state.lastRun > STALE_AFTER) return true;
  return cfg.countries.some((cc) => {
    for (let i = 1; i <= cfg.slots; i++) if (!dnsMap[slotLabel(cc, i)]) return true;
    return false;
  });
}

function buildDnsMap(state, countries) {
  const map = {};
  countries.forEach((cc) => {
    const c = state.countries[cc];
    if (!c) return;
    (c.slots || []).forEach((s, i) => { if (s) map[slotLabel(cc, i + 1)] = s.ip; });
  });
  return map;
}

function dnsAnswer(domain, map) {
  const d = String(domain || "").toLowerCase().replace(/\.$/, "");
  if (!d.endsWith(HOST_SUFFIX)) return null;
  return map[d.slice(0, -HOST_SUFFIX.length)] || null;
}

function renderScaffold(state, privateKey, cfg) {
  const wireguard = [];
  const proxies = [UNDERLAY_ALT + " = direct"];
  const groups = [];
  const countries = cfg.countries.filter((cc) => state.countries[cc] && state.countries[cc].publicKey);
  countries.forEach((cc) => {
    const layout = state.countries[cc];
    const members = [];
    for (let i = 1; i <= cfg.slots; i++) {
      wireguard.push(
        "[WireGuard " + sectionName(cc, i) + "]",
        "private-key = " + privateKey,
        "self-ip = 10.5.0.2",
        "dns-server = 103.86.96.100, 103.86.99.100",
        "peer = (public-key = " + layout.publicKey + ", allowed-ips = 0.0.0.0/0, endpoint = " +
          slotLabel(cc, i) + HOST_SUFFIX + ":51820, keepalive = 0)",
        ""
      );
      proxies.push(policyName(cc, i) + " = wireguard, section-name=" + sectionName(cc, i) +
        ", underlying-proxy=" + UNDERLAY_GROUP);
      members.push(policyName(cc, i));
    }
    groups.push(groupName(cc) + " = smart, " + members.join(", "));
  });
  groups.push(UNDERLAY_GROUP + " = select, DIRECT, " + UNDERLAY_ALT + ", hidden=true");
  return {
    countries: countries.map((cc) => ({ cc, city: state.countries[cc].city })),
    slots: cfg.slots,
    wireguard: wireguard.join("\n"),
    proxies,
    groups,
  };
}

function fingerprint(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
}

function base64(str) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < str.length; i += 3) {
    const a = str.charCodeAt(i);
    const b = i + 1 < str.length ? str.charCodeAt(i + 1) : NaN;
    const c = i + 2 < str.length ? str.charCodeAt(i + 2) : NaN;
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] +
      (isNaN(b) ? "=" : chars[(n >> 6) & 63]) + (isNaN(c) ? "=" : chars[n & 63]);
  }
  return out;
}

function newState() {
  return { v: 1, countries: {}, stats: {} };
}

function publicStatus(state, cfg) {
  const countries = {};
  Object.keys(state.countries || {}).forEach((cc) => {
    const c = state.countries[cc];
    countries[cc] = {
      city: c.city,
      configured: cfg.countries.indexOf(cc) >= 0,
      slots: (c.slots || []).map((s, i) => s && {
        policy: policyName(cc, i + 1),
        host: s.host,
        ip: s.ip,
        load: s.load,
        rtt: state.stats[s.host] && state.stats[s.host].rtt,
      }),
    };
  });
  return { lastRun: state.lastRun || null, lastError: state.lastError || null, summary: state.summary || null, countries };
}

// ---------- Surge adapters ----------

function readJSON(key, fallback) {
  try {
    const raw = $persistentStore.read(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJSON(key, value) {
  return $persistentStore.write(JSON.stringify(value), key);
}

function loadState() {
  const s = readJSON(STATE_KEY, null);
  if (!s || s.v !== 1) return newState();
  s.countries = s.countries || {};
  s.stats = s.stats || {};
  return s;
}

function request(opts) {
  return new Promise((resolve, reject) => {
    $httpClient.get(Object.assign({ timeout: 20, policy: "DIRECT" }, opts), (err, resp, body) => {
      if (err) reject(new Error(String(err)));
      else resolve({ status: resp.status, body });
    });
  });
}

async function getJSON(url) {
  const res = await request({ url, headers: { Accept: "application/json" } });
  if (res.status !== 200) throw new Error("HTTP " + res.status + " " + url.split("?")[0]);
  return JSON.parse(res.body);
}

function httpAPI(method, path, body) {
  if (typeof $httpAPI !== "function") return Promise.resolve(null);
  return new Promise((resolve) => $httpAPI(method, path, body || {}, (r) => resolve(r)));
}


async function ensureIndex() {
  const cached = readJSON(INDEX_KEY, null);
  if (cached && cached.map && Date.now() - cached.at < INDEX_TTL) return cached.map;
  const map = buildIndex(await getJSON(NORD_API + "/servers/countries"));
  writeJSON(INDEX_KEY, { at: Date.now(), map });
  return map;
}

async function ensurePrivateKey(token) {
  const secret = readJSON(SECRET_KEY, {});
  if (!token) {
    if (secret.key) return secret.key;
    throw new Error("尚未设置 NordVPN access token：请在浏览器打开 http://nord.surge/setup");
  }
  const fp = fingerprint(token);
  if (secret.key && secret.fp === fp) return secret.key;
  const res = await request({
    url: NORD_API + "/users/services/credentials",
    headers: { Accept: "application/json", Authorization: "Basic " + base64("token:" + token) },
  });
  if (res.status === 401 || res.status === 403) throw new Error("NordVPN 拒绝了 access token（HTTP " + res.status + "）");
  if (res.status !== 200) throw new Error("获取 NordVPN 凭据失败（HTTP " + res.status + "）");
  const data = JSON.parse(res.body);
  if (!data.nordlynx_private_key) throw new Error("NordVPN 凭据中没有 nordlynx_private_key");
  writeJSON(SECRET_KEY, { fp, key: data.nordlynx_private_key, at: Date.now() });
  return data.nordlynx_private_key;
}

async function fetchCandidates(layout, limit, lane) {
  const list = parseServers(await getJSON(recommendationsUrl({ cityId: layout.cityId, countryId: layout.id, limit })));
  const matching = list.filter((s) => s.publicKey === layout.publicKey);
  return { all: list, matching: matching.filter((s) => serverLane(s.host) === lane) };
}

/*
 * A device without stored layouts (e.g. a phone that got the profile through iCloud)
 * rebuilds them from the cities pinned in the script argument; the pinned city is what
 * guarantees the same public key as the WireGuard sections generated on the Mac.
 */
async function bootstrapLayouts(state, cfg, warnings) {
  const missing = cfg.countries.filter((cc) => !(state.countries[cc] && state.countries[cc].publicKey && state.countries[cc].cityId));
  if (!missing.length) return;
  const pinned = missing.filter((cc) => cfg.cities[cc]);
  missing.filter((cc) => !cfg.cities[cc]).forEach((cc) => warnings.push(cc + " 没有固定城市，无法在本设备生成槽位（在 Mac 上重新运行 tools/migrate.py）"));
  if (!pinned.length) return;
  const index = await ensureIndex();
  await Promise.all(pinned.map(async (cc) => {
    try {
      state.countries[cc] = await layoutCountry(cc, cfg, index, null);
    } catch (e) {
      warnings.push(String(e.message || e));
    }
  }));
}

async function layoutCountry(cc, cfg, index, previous) {
  const entry = index[cc];
  if (!entry) throw new Error(cc + ": 不是 NordVPN 支持的国家/地区代码");
  const wanted = cfg.cities[cc];
  let cityId = null;
  if (wanted) {
    const city = entry.cities[wanted.toLowerCase()];
    if (!city) throw new Error(cc + ": NordVPN 在该国家没有城市 " + wanted);
    cityId = city.id;
  }
  const servers = parseServers(await getJSON(recommendationsUrl({ countryId: entry.id, cityId, limit: 10 })));
  const layout = chooseLayout(cc, servers, index);
  const keep = previous && previous.publicKey === layout.publicKey && previous.city === layout.city;
  layout.slots = keep ? normalizeSlots(previous.slots, cfg.slots) : emptySlots(cfg.slots);
  return layout;
}

async function scaffold(cfg, refresh) {
  const state = loadState();
  const index = await ensureIndex();
  const errors = [];
  await Promise.all(cfg.countries.map(async (cc) => {
    if (state.countries[cc] && state.countries[cc].publicKey && !refresh &&
        (!cfg.cities[cc] || cfg.cities[cc].toLowerCase() === String(state.countries[cc].city).toLowerCase())) {
      state.countries[cc].slots = normalizeSlots(state.countries[cc].slots, cfg.slots);
      return;
    }
    try {
      state.countries[cc] = await layoutCountry(cc, cfg, index, state.countries[cc]);
    } catch (e) {
      errors.push(String(e.message || e));
    }
  }));
  writeJSON(STATE_KEY, state);
  const key = await ensurePrivateKey(null);
  const out = renderScaffold(state, key, cfg);
  out.errors = errors;
  return out;
}

async function applyAssignments(state, cfg) {
  writeJSON(DNS_KEY, buildDnsMap(state, cfg.countries));
  await httpAPI("POST", "/v1/dns/flush");
  // Surge periodically re-resolves endpoint hostnames. Do not reset every
  // WireGuard transport just because an empty slot acquired its first answer.
}

/*
 * Round-trip time to the server itself, without WireGuard: NordVPN accepts sessions
 * from one key on only about ten servers at a time and keeps that quota occupied for
 * a long while, so handshaking candidates just to measure them is not an option.
 * Port 80 accepts TCP and then closes the connection, so the request fails with EOF
 * after roughly one round trip; only a timeout means the server is unreachable.
 */
function probeOnce(ip) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    $httpClient.get({ url: "http://" + ip + "/", timeout: PROBE_TIMEOUT, policy: "DIRECT" }, (err) => {
      const ms = Date.now() - t0;
      resolve(err && /timeout|timed out/i.test(String(err)) || ms >= PROBE_TIMEOUT * 1000 ? null : ms);
    });
  });
}

async function probe(ip) {
  const samples = [];
  for (let i = 0; i < PROBE_SAMPLES; i++) {
    const v = await probeOnce(ip);
    if (v === null && i === 0) return null;
    samples.push(v);
  }
  return bestOf(samples);
}

async function probeAll(servers) {
  const out = {};
  let next = 0;
  const worker = async () => {
    while (next < servers.length) {
      const s = servers[next++];
      const v = await probe(s.ip);
      if (v !== null) out[s.host] = v;
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(PROBE_CONCURRENCY, servers.length); i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

function sameAssignment(a, b) {
  return JSON.stringify(a.map((s) => s && s.host)) === JSON.stringify(b.map((s) => s && s.host));
}

async function runUpdate(cfg) {
  const now = Date.now();
  const state = loadState();
  const warnings = [];
  const lane = deviceLane(typeof $environment === "object" ? $environment : null);
  state.runningAt = now;
  writeJSON(STATE_KEY, state);
  await bootstrapLayouts(state, cfg, warnings);
  const countries = cfg.countries.filter((cc) => state.countries[cc] && state.countries[cc].publicKey && state.countries[cc].cityId);
  if (!countries.length) throw new Error("没有可用的国家槽位：" + (warnings.join("; ") || "请先运行 tools/migrate.py"));

  const cands = {};
  await Promise.all(countries.map(async (cc) => {
    const layout = state.countries[cc];
    try {
      const r = await fetchCandidates(layout, cfg.candidates, lane);
      cands[cc] = r.matching;
      if (!r.matching.length && r.all.length) warnings.push(cc + " " + layout.city + " 的公钥已变化，请重新运行 tools/migrate.py --refresh");
    } catch (e) {
      cands[cc] = [];
      warnings.push(cc + " 拉取候选失败：" + (e.message || e));
    }
  }));

  const all = [];
  countries.forEach((cc) => { all.push.apply(all, cands[cc]); });
  const rtt = await probeAll(all);
  updateStats(state.stats, rtt, now);

  let changed = false;
  let probed = 0;
  let reachable = 0;
  const lines = [];
  const silent = [];
  countries.forEach((cc) => {
    const c = state.countries[cc];
    const before = normalizeSlots(c.slots, cfg.slots);
    const ok = cands[cc].filter((s) => typeof rtt[s.host] === "number").length;
    probed += cands[cc].length;
    reachable += ok;
    // Nothing reachable at all points to our own network, not to every server being down.
    if (cands[cc].length && !ok) silent.push(cc);
    const empty = before.every((x) => !x);
    c.slots = ok || empty ? stableSlots(before, cands[cc], rtt, cfg.slots) : before;
    if (!sameAssignment(before, c.slots)) changed = true;
    lines.push(cc + " " + c.city + ": " + c.slots.map((s) => {
      if (!s) return "-";
      const v = rtt[s.host];
      return s.host.split(".")[0] + (typeof v === "number" ? "(" + v + "ms, " + s.load + "%)" : "(?)");
    }).join(" "));
  });
  if (silent.length) warnings.push(silent.join(", ") + " 的候选全部无法连通，保留原有节点");
  const dns = buildDnsMap(state, cfg.countries);
  if (JSON.stringify(dns) !== JSON.stringify(readJSON(DNS_KEY, {}))) await applyAssignments(state, cfg);

  state.lastRun = now;
  state.runningAt = null;
  state.lastError = warnings.length ? warnings.join("; ") : null;
  state.summary = "探测 " + probed + " 个候选，可达 " + reachable + " 个" + (changed ? "，已更新节点" : "，节点无变化");
  writeJSON(STATE_KEY, state);
  return { summary: state.summary, lines, warnings };
}

function respond(status, body, type) {
  $done({
    response: {
      status,
      headers: { "Content-Type": (type || "application/json") + "; charset=utf-8", "Cache-Control": "no-store" },
      body: typeof body === "string" ? body : JSON.stringify(body, null, 2),
    },
  });
}

function parseQuery(url) {
  const q = {};
  const i = url.indexOf("?");
  if (i < 0) return q;
  url.slice(i + 1).split("&").forEach((p) => {
    const j = p.indexOf("=");
    if (j > 0) q[decodeURIComponent(p.slice(0, j))] = decodeURIComponent(p.slice(j + 1));
    else if (p) q[decodeURIComponent(p)] = "";
  });
  return q;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function setupPage(message, ok) {
  const has = !!readJSON(SECRET_KEY, {}).key;
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    "<title>Surge-Nord</title><body style=\"font:15px -apple-system,sans-serif;max-width:560px;margin:40px auto;padding:0 16px\">" +
    "<h2>Surge-Nord 设置</h2>" +
    (message ? '<p style="color:' + (ok ? "green" : "crimson") + '">' + escapeHtml(message) + "</p>" : "") +
    "<p>NordLynx 私钥：" + (has ? "已保存" : "未设置") + "</p>" +
    '<form method="POST" action="/setup">' +
    '<p><input name="token" type="password" autocomplete="off" placeholder="NordVPN access token" style="width:100%;padding:8px"></p>' +
    '<p><button type="submit" style="padding:8px 16px">保存</button></p></form>' +
    "<p style=\"color:#666\">Token 只用于向 NordVPN 换取 NordLynx 私钥，不会被保存。</p></body>";
}

async function handleSetup() {
  if ($request.method !== "POST") return respond(200, setupPage(), "text/html");
  const form = parseQuery("?" + String($request.body || "").replace(/\+/g, " "));
  const token = String(form.token || "").trim();
  if (!token) return respond(400, setupPage("请输入 token", false), "text/html");
  try {
    await ensurePrivateKey(token);
    respond(200, setupPage("已获取并保存 NordLynx 私钥。现在可以运行 tools/migrate.py。", true), "text/html");
  } catch (e) {
    respond(400, setupPage(String(e.message || e), false), "text/html");
  }
}

async function serve(cfg) {
  const url = $request.url;
  const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  const query = parseQuery(url);
  try {
    if (path === "/setup") {
      await handleSetup();
    } else if (path === "/scaffold") {
      respond(200, await scaffold(cfg, query.refresh === "1"));
    } else if (path === "/status" || path === "/") {
      respond(200, publicStatus(loadState(), cfg));
    } else {
      respond(404, { error: "not found" });
    }
  } catch (e) {
    respond(500, { error: String(e.message || e) });
  }
}

function resolveDns() {
  const ip = dnsAnswer($domain, readJSON(DNS_KEY, {}));
  $done(ip ? { address: ip, ttl: 30 } : {});
}

async function cronMain(cfg) {
  try {
    const r = await runUpdate(cfg);
    const text = r.summary + "\n" + r.lines.join("\n");
    console.log(text + (r.warnings.length ? "\n警告: " + r.warnings.join("; ") : ""));
    $surge.logbook("Nord: " + r.summary);
    if (r.warnings.length) $notification.post("NordVPN 节点更新", "有警告", r.warnings.join("\n"));
    else if (cfg.notify === "all") $notification.post("NordVPN 节点更新", r.summary, r.lines.join("\n"));
  } catch (e) {
    const msg = String(e.message || e);
    console.log("error: " + msg);
    const state = loadState();
    state.lastError = msg;
    state.runningAt = null;
    writeJSON(STATE_KEY, state);
    $notification.post("NordVPN 节点更新失败", "", msg);
  }
  $done();
}

function eventMain(cfg) {
  if (!needsRun(loadState(), readJSON(DNS_KEY, {}), cfg, Date.now())) return $done();
  console.log("event " + ($event && $event.name) + ": running update");
  return cronMain(cfg);
}

if (typeof $done === "function") {
  const cfg = makeConfig(parseArgs(typeof $argument === "string" ? $argument : ""));
  if (typeof $request !== "undefined") serve(cfg);
  else if (typeof $domain !== "undefined") resolveDns();
  else if (typeof $event !== "undefined") eventMain(cfg);
  else cronMain(cfg);
} else if (typeof module !== "undefined") {
  module.exports = {
    parseArgs, makeConfig, recommendationsUrl, parseServers, buildIndex, chooseLayout,
    pickSlots, stableSlots, applyAssignments, bestOf, probeAll, updateStats, buildDnsMap, deviceLane, serverLane, needsRun,
    dnsAnswer, renderScaffold, fingerprint, base64, publicStatus, newState,
    slotLabel, sectionName, policyName, groupName,
  };
}

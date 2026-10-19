/*
 * BiliBili CDN Speed — 播放地址改写脚本 (type=http-response)
 *
 * 在 playurl (JSON) / PlayViewUnite (gRPC) 返回时就把视频地址换成最快的线路，
 * 之后播放器直接请求目标主机，视频分片不再经过 MitM 和脚本。
 *
 * 这个脚本不发任何网络请求，只读后台测好的结果，所以不会拖慢 playurl 响应。
 * （之前在这里现场赛跑，要拖住响应约 6 秒，Apple TV 上会导致完全播不动。）
 *
 * - Akamai 签名地址（upos-hz-mirrorakam，os=akam + hdnts，tvOS 常见）：按 bili-cdn-speedtest.js
 *   测出的线路排名（bili_cdn_choice：Akamai / 海外 ov / CNHK / 最快 upos）排列，第一名做主地址；
 *   还没有排名时默认 Akamai 优先（澳大利亚实测 Akamai 15–67 Mbps，ov 只有 0.6–3.8 Mbps）。
 *   CNHK 规则移植自 OctoLeft/BiliBili-Redirect-tvOS：只接受 http、原样保留签名 query，
 *   按 platform 决定是否补 buvid/build（写法由后台测速探测）。
 * - 其他 upos 签名地址：换成后台测出的最快主机，原地址放进 backup_url。
 * 同时把签名地址存为测速样本，供后台测速用真实分片测试。
 */

const KEY_BEST = "bili_cdn_best";
const KEY_CHOICE = "bili_cdn_choice";
const KEY_SAMPLE = "bili_cdn_sample";
const KEY_SAMPLE_AKAM = "bili_cdn_sample_akam";
const KEY_BUVID = "bili_cdn_buvid";

const DEFAULT_CNHK_POOL = [
  "cn-hk-eq-01-03.bilivideo.com",
  "cn-hk-eq-01-13.bilivideo.com",
  "cn-hk-eq-01-12.bilivideo.com",
  "cn-hk-eq-01-01.bilivideo.com",
  "cn-hk-eq-01-09.bilivideo.com",
  "cn-hk-eq-01-10.bilivideo.com",
  "cn-hk-eq-01-14.bilivideo.com",
];
const OV_HOSTS = [
  "upos-sz-mirroraliov.bilivideo.com",
  "upos-sz-mirrorcosov.bilivideo.com",
  "upos-sz-mirrorhwov.bilivideo.com",
  "upos-sz-mirrorawsov.bilivideo.com",
];

function parseArgs(raw) {
  const out = {};
  if (!raw) return out;
  for (const pair of String(raw).split("&")) {
    const i = pair.indexOf("=");
    if (i < 0) continue;
    const k = decodeURIComponent(pair.slice(0, i).trim());
    let v = decodeURIComponent(pair.slice(i + 1).trim());
    v = v.replace(/^"(.*)"$/, "$1");
    if (v && !/^\{\{\{.*\}\}\}$/.test(v)) out[k] = v;
  }
  return out;
}

function readJSON(key) {
  try {
    return JSON.parse($persistentStore.read(key) || "null");
  } catch (e) {
    return null;
  }
}

function writeJSON(key, value) {
  $persistentStore.write(JSON.stringify(value), key);
}

const args = parseArgs(typeof $argument === "undefined" ? "" : $argument);
const MAX_AGE_MIN = Number(args.MaxAge || 120);
const TVOS_BUILD = args.Build || "89600100";
const CNHK_POOL = args.CNHKPool
  ? args.CNHKPool.split(/[,|]/).map((s) => s.trim()).filter(isCNHKHost)
  : DEFAULT_CNHK_POOL;

// ---------- URL 工具：全部按原始字符串处理，避免重新编码破坏签名 ----------

function hostOf(url) {
  const m = String(url).match(/^[a-z]+:\/\/([^/:?#]+)/i);
  return m ? m[1].toLowerCase() : "";
}

function withHost(url, scheme, host) {
  return String(url).replace(/^[a-z][a-z\d+.-]*:\/\/[^/?#]+/i, scheme + "//" + host);
}

function getParam(url, name) {
  const m = String(url).match(new RegExp("[?&]" + name + "=([^&#]*)"));
  return m ? m[1] : "";
}

function setParam(url, name, value) {
  const re = new RegExp("([?&]" + name + "=)[^&#]*");
  if (re.test(url)) return url.replace(re, "$1" + encodeURIComponent(value));
  return url + (url.indexOf("?") < 0 ? "?" : "&") + name + "=" + encodeURIComponent(value);
}

function signedParams(url) {
  let v = getParam(url, "uparams");
  try {
    v = decodeURIComponent(v);
  } catch (e) {}
  return v.split(",").filter(Boolean);
}

function isCNHKHost(host) {
  return /^cn-hk-eq-\d{2}-\d{2}\.bilivideo\.com$/.test(host);
}

function isAkamaiSigned(url) {
  return hostOf(url) === "upos-hz-mirrorakam.akamaized.net" && getParam(url, "os") === "akam" && /[?&]hdnts=exp(=|%3D)\d+~hmac(=|%3D)/.test(url);
}

function isUposSigned(url) {
  return /^upos-[a-z0-9-]*mirror[a-z0-9-]*\.bilivideo\.com$/.test(hostOf(url)) && /\/upgcxcode\//.test(url) && !!getParam(url, "upsig");
}

function unique(list) {
  return list.filter((v, i) => v && list.indexOf(v) === i);
}

function buvid() {
  if (args.Buvid) return args.Buvid;
  let v = $persistentStore.read(KEY_BUVID);
  if (!v) {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    v = "YF";
    for (let i = 0; i < 42; i++) v += chars[Math.floor(Math.random() * chars.length)];
    $persistentStore.write(v, KEY_BUVID);
  }
  return v;
}

// CNHK 只接受 http。tvOS 客户端的地址还要补 buvid / build（签名覆盖的参数不能动），
// 而 Web 端（platform=pc）的地址补了反而 403，所以两种写法都探测，按 platform 记住能用的那种。
function buildCNHKURL(akamURL, host, variant) {
  const signed = signedParams(akamURL);
  let url = withHost(akamURL, "http:", host);
  if (variant === "raw") return url;
  if (signed.indexOf("buvid") < 0 && !getParam(url, "buvid")) url = setParam(url, "buvid", buvid());
  const build = getParam(url, "build");
  if (signed.indexOf("build") < 0 && (!build || build === "0")) url = setParam(url, "build", TVOS_BUILD);
  return url;
}

function userAgent() {
  const h = $request.headers || {};
  for (const k of Object.keys(h)) if (k.toLowerCase() === "user-agent") return h[k];
  return "Bilibili Freedoooooom/MarkII";
}

// ---------- Akamai 签名地址：按后台线路排名排列 ----------

// 候选的 key 只描述“用哪条线路”，同一份排名可以套用到所有清晰度、音频和后续视频
function candidateURL(key, ctx) {
  if (key === "akam") return ctx.akam;
  if (key === "ov") return ctx.ov;
  if (key.indexOf("cnhk:") === 0) return ctx.variant ? buildCNHKURL(ctx.akam, key.slice(5), ctx.variant) : "";
  if (key.indexOf("upos:") === 0) return ctx.ov ? withHost(ctx.ov, "https:", key.slice(5)) : "";
  return "";
}

let routeInfo = null;

function routeOrder(akamURL) {
  if (routeInfo) return routeInfo;
  const platform = getParam(akamURL, "platform");
  const cached = readJSON(KEY_CHOICE);
  if (cached && cached.order && cached.platform === platform && Date.now() - cached.time < MAX_AGE_MIN * 60000) {
    routeInfo = { order: cached.order, variant: cached.variant || null, source: "测速排名" };
  } else {
    // 没有（或过期的）排名：Akamai 优先，其次海外 ov；CNHK 写法未知时不放进去
    const variant = cached && cached.platform === platform ? cached.variant || null : null;
    const order = ["akam", "ov"].concat(variant ? CNHK_POOL.map((h) => "cnhk:" + h) : []);
    routeInfo = { order, variant, source: "默认顺序（还没有测速排名）" };
  }
  return routeInfo;
}

function akamaiPlan(akamURL, all) {
  const { order, variant } = routeOrder(akamURL);
  const ctx = { akam: akamURL, ov: all.filter((u) => OV_HOSTS.indexOf(hostOf(u)) >= 0)[0] || "", variant };
  const urls = unique(order.map((k) => candidateURL(k, ctx)));
  if (!urls.length) return null;
  return { primary: urls[0], backups: unique(urls.slice(1).concat(all)).filter((u) => u !== urls[0]) };
}

function uposPlan(url, all) {
  const best = readJSON(KEY_BEST);
  if (!best || !best.host || best.mode !== "throughput" || Date.now() - best.time > MAX_AGE_MIN * 60000) return null;
  if (hostOf(url) === best.host) return null;
  const primary = withHost(url, "https:", best.host);
  return { primary, backups: unique(all).filter((u) => u !== primary) };
}

let sampled = false;

function rememberSample(all) {
  if (sampled) return;
  const ua = userAgent();
  const akam = all.filter(isAkamaiSigned)[0];
  const upos = all.filter(isUposSigned)[0];
  const ov = all.filter((u) => OV_HOSTS.indexOf(hostOf(u)) >= 0)[0] || "";
  if (akam) writeJSON(KEY_SAMPLE_AKAM, { url: akam, ov, ua, deadline: Number(getParam(akam, "deadline")) || 0, time: Date.now() });
  if (upos) writeJSON(KEY_SAMPLE, { url: upos, ua, deadline: Number(getParam(upos, "deadline")) || 0, time: Date.now() });
  sampled = !!(akam || upos);
}

function planFor(primary, backups) {
  const all = unique([primary].concat(backups || [])).filter((u) => /^https?:\/\//.test(u));
  if (!all.length) return null;
  rememberSample(all);
  const akam = all.filter(isAkamaiSigned)[0];
  if (akam) return akamaiPlan(akam, all);
  // 已经是 CNHK（比如上一次改写过的）就不再动
  if (isCNHKHost(hostOf(all[0]))) return null;
  const upos = all.filter(isUposSigned)[0];
  return upos ? uposPlan(upos, all) : null;
}

function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---------- JSON playurl ----------

async function rewriteJSON(node) {
  let count = 0;
  if (Array.isArray(node)) {
    for (const item of node) count += await rewriteJSON(item);
    return count;
  }
  if (!node || typeof node !== "object") return 0;
  const mainKey = ["base_url", "baseUrl", "url"].filter((k) => typeof node[k] === "string" && /^https?:\/\//.test(node[k]))[0];
  if (mainKey) {
    const backupKeys = ["backup_url", "backupUrl", "backup_urls", "backupUrls"].filter((k) => Array.isArray(node[k]));
    const backups = [].concat.apply([], backupKeys.map((k) => node[k]));
    const plan = planFor(node[mainKey], backups);
    if (plan && plan.primary) {
      if (plan.primary !== node[mainKey]) noteChange(node[mainKey], plan.primary);
      for (const k of ["base_url", "baseUrl", "url"]) {
        if (typeof node[k] === "string" && node[k] !== plan.primary) {
          node[k] = plan.primary;
          count++;
        }
      }
      if (!backupKeys.length) backupKeys.push(mainKey === "base_url" ? "backup_url" : "backupUrl");
      for (const k of backupKeys) {
        if (!Array.isArray(node[k]) || !sameList(node[k], plan.backups)) {
          node[k] = plan.backups;
          count++;
        }
      }
    }
  }
  for (const k of Object.keys(node)) {
    if (node[k] && typeof node[k] === "object") count += await rewriteJSON(node[k]);
  }
  return count;
}

// ---------- gRPC / protobuf：只改 URL 字段，其他字节原样保留 ----------

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  let b;
  do {
    if (pos >= buf.length) throw new Error("varint overflow");
    b = buf[pos++];
    result += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (b & 0x80);
  return [result, pos];
}

function writeVarint(n, out) {
  while (n > 127) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
}

function parseFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const start = pos;
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const no = Math.floor(tag / 8);
    const wt = tag % 8;
    let valStart = pos;
    if (wt === 0) [, pos] = readVarint(buf, pos);
    else if (wt === 1) pos += 8;
    else if (wt === 5) pos += 4;
    else if (wt === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      valStart = pos;
      pos += len;
    } else throw new Error("unsupported wire type " + wt);
    if (pos > buf.length || no === 0) throw new Error("truncated message");
    fields.push({ no, wt, start, valStart, end: pos });
  }
  return fields;
}

function utf8Decode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += "%" + ("0" + bytes[i].toString(16)).slice(-2);
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return null;
  }
}

function utf8Encode(str) {
  const bin = unescape(encodeURIComponent(str));
  const out = new Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function lengthDelimited(no, bytes, out) {
  writeVarint(no * 8 + 2, out);
  writeVarint(bytes.length, out);
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
}

function concatParts(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// 消息结构（bilibili.playershared / playerunite.v1）：只列出到 URL 字段的路径
const URL_ITEM_DASH = { url: 1, backup: 2 }; // DashVideo / DashItem
const URL_ITEM_SEGMENT = { url: 4, backup: 5 }; // ResponseUrl
const SCHEMA = {};
SCHEMA.Reply = { 1: "VodInfo", 10: "FragmentVideo" };
SCHEMA.FragmentVideo = { 1: "FragmentVideoInfo" };
SCHEMA.FragmentVideoInfo = { 2: "VodInfo" };
SCHEMA.VodInfo = { 5: "Stream", 6: "DashItem" };
SCHEMA.Stream = { 2: "DashVideo", 3: "SegmentVideo" };
SCHEMA.SegmentVideo = { 1: "ResponseUrl" };

let pbCount = 0;

async function rewriteUrlItem(buf, spec) {
  const fields = parseFields(buf);
  const urlField = fields.filter((f) => f.no === spec.url && f.wt === 2)[0];
  if (!urlField) return buf;
  const primary = utf8Decode(buf.subarray(urlField.valStart, urlField.end));
  if (!primary || !/^https?:\/\//.test(primary)) return buf;
  const backups = fields.filter((f) => f.no === spec.backup && f.wt === 2).map((f) => utf8Decode(buf.subarray(f.valStart, f.end))).filter(Boolean);
  const plan = planFor(primary, backups);
  if (!plan || !plan.primary || (plan.primary === primary && sameList(plan.backups, backups))) return buf;
  pbCount++;
  if (plan.primary !== primary) noteChange(primary, plan.primary);
  const parts = [];
  let backupsWritten = false;
  const emitBackups = () => {
    const out = [];
    for (const b of plan.backups) lengthDelimited(spec.backup, utf8Encode(b), out);
    parts.push(new Uint8Array(out));
    backupsWritten = true;
  };
  for (const f of fields) {
    if (f === urlField) {
      const out = [];
      lengthDelimited(spec.url, utf8Encode(plan.primary), out);
      parts.push(new Uint8Array(out));
    } else if (f.no === spec.backup && f.wt === 2) {
      if (!backupsWritten) emitBackups();
    } else {
      parts.push(buf.subarray(f.start, f.end));
    }
  }
  if (!backupsWritten) emitBackups();
  return concatParts(parts);
}

async function rewriteMessage(buf, type) {
  if (type === "DashVideo" || type === "DashItem") return rewriteUrlItem(buf, URL_ITEM_DASH);
  if (type === "ResponseUrl") return rewriteUrlItem(buf, URL_ITEM_SEGMENT);
  const schema = SCHEMA[type];
  let fields;
  try {
    fields = parseFields(buf);
  } catch (e) {
    return buf; // 结构和预期不符时原样保留
  }
  let changed = false;
  const parts = [];
  for (const f of fields) {
    const sub = schema[f.no];
    if (!sub || f.wt !== 2) {
      parts.push(buf.subarray(f.start, f.end));
      continue;
    }
    const inner = buf.subarray(f.valStart, f.end);
    let next = inner;
    try {
      next = await rewriteMessage(inner, sub);
    } catch (e) {
      next = inner;
    }
    if (next === inner) {
      parts.push(buf.subarray(f.start, f.end));
    } else {
      changed = true;
      const head = [];
      writeVarint(f.no * 8 + 2, head);
      writeVarint(next.length, head);
      parts.push(new Uint8Array(head), next);
    }
  }
  return changed ? concatParts(parts) : buf;
}

// gRPC 帧：1 字节压缩标志 + 4 字节长度 + protobuf
function grpcDecode(bytes) {
  const flag = bytes[0];
  let body = bytes.subarray(5);
  if (flag === 1) body = $utils.ungzip(body);
  return body;
}

function grpcEncode(body) {
  const out = new Uint8Array(5 + body.length);
  out[0] = 0;
  out[1] = (body.length >>> 24) & 0xff;
  out[2] = (body.length >>> 16) & 0xff;
  out[3] = (body.length >>> 8) & 0xff;
  out[4] = body.length & 0xff;
  out.set(body, 5);
  return out;
}

function deleteHeader(headers, name) {
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name) delete headers[k];
}

// 诊断：记下每条流原来和改写后的主地址主机，最后汇总成一行日志
const changes = {};

function noteChange(from, to) {
  const k = hostOf(from).replace(".bilivideo.com", "") + " → " + hostOf(to).replace(".bilivideo.com", "");
  changes[k] = (changes[k] || 0) + 1;
}

function summary() {
  const parts = Object.keys(changes).map((k) => k + " ×" + changes[k]);
  return (parts.join("，") || "无") + (routeInfo ? "；Akamai 线路：" + routeInfo.source + " " + routeInfo.order.slice(0, 3).join(" > ") : "");
}

const started = Date.now();
const apiName = ($request.url.match(/\/([^/?]+)(\?|$)/) || [])[1] || "";

function log(msg) {
  console.log("[BiliCDN] " + apiName + " " + msg + "（" + (Date.now() - started) + "ms）");
}

(async () => {
  const headers = Object.assign({}, $response.headers);
  let ctype = "";
  for (const k of Object.keys(headers)) if (k.toLowerCase() === "content-type") ctype = String(headers[k]).split(";")[0].trim();

  if (/grpc/.test(ctype)) {
    const raw = $response.body instanceof Uint8Array ? $response.body : new Uint8Array($response.body || []);
    if (raw.length < 5) return log("gRPC 响应为空，未改写"), $done({});
    const body = grpcDecode(raw);
    const next = await rewriteMessage(body, "Reply");
    if (next === body) return log("gRPC " + raw.length + "B（压缩=" + raw[0] + "），没有可改写的地址"), $done({});
    log("gRPC 改写 " + pbCount + " 条流：" + summary());
    deleteHeader(headers, "content-length");
    // 改写后统一不压缩，同时去掉压缩声明
    deleteHeader(headers, "grpc-encoding");
    return $done({ body: grpcEncode(next), headers });
  }

  if (/json/.test(ctype) || /^\s*\{/.test($response.body || "")) {
    const json = JSON.parse($response.body || "{}");
    const count = await rewriteJSON(json);
    if (!count) return log("JSON（code=" + json.code + "），没有可改写的地址"), $done({});
    log("JSON 改写 " + count + " 处：" + summary());
    deleteHeader(headers, "content-length");
    return $done({ body: JSON.stringify(json), headers });
  }
  log("未识别的响应类型 " + (ctype || "(无)") + "，未改写");
  $done({});
})().catch((e) => {
  log("出错，已放行原响应：" + e);
  $done({});
});

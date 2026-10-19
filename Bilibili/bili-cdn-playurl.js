/*
 * BiliBili CDN Speed — 播放地址改写脚本 (type=http-response)
 *
 * 在 playurl (JSON) / PlayViewUnite (gRPC) 返回时就把视频地址换成最快的 CDN，
 * 之后播放器直接请求目标主机，视频分片不再经过 MitM 和脚本（Apple TV 卡顿的主要原因）。
 *
 * 两种地址分开处理（CNHK 规则移植自 OctoLeft/BiliBili-Redirect-tvOS）：
 * - Akamai 签名地址（upos-hz-mirrorakam，os=akam + hdnts，tvOS 常见）：CNHK 各主机、
 *   海外 ov 地址、Akamai 原地址、后台测出的最快 upos 主机一起下载 256KB 赛跑，最快的做主地址，
 *   其余按速度放进 backup_url；StickyMin 分钟内固定这个排名。CNHK 只接受 http，原样保留签名
 *   query；tvOS 地址需补 buvid/build，Web 地址补了反而 403，所以先探测用哪种写法。
 * - 其他 upos 签名地址：换成 bili-cdn-speedtest.js 测出的最快主机，原地址放进 backup_url。
 * 同时把签名地址存为测速样本，供后台测速用真实分片测吞吐。
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
const PROBE_RANGE = "bytes=0-262143";
const PROBE_BYTES = 262144;

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
const STICKY_MIN = Number(args.StickyMin || 30);
const PROBE_TIMEOUT_MS = Number(args.ProbeTimeout || 3) * 1000;
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

// ---------- 测速 ----------

function userAgent() {
  const h = $request.headers || {};
  for (const k of Object.keys(h)) if (k.toLowerCase() === "user-agent") return h[k];
  return "Bilibili Freedoooooom/MarkII";
}

function probe(url, index, range) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const finish = (r) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    $httpClient.get(
      {
        url,
        timeout: Math.ceil(PROBE_TIMEOUT_MS / 1000) + 1,
        "binary-mode": true,
        "auto-redirect": false,
        headers: { Accept: "application/octet-stream", Range: range || PROBE_RANGE, "User-Agent": userAgent(), Referer: "https://www.bilibili.com" },
      },
      (err, resp) => {
        if (err || !resp || resp.status !== 206) return finish(null);
        const ms = Math.max(Date.now() - start, 1);
        const bytes = range ? 1024 : PROBE_BYTES;
        finish({ host: hostOf(url), index, bps: (bytes * 1000) / ms });
      }
    );
  });
}

// ---------- Akamai 签名地址：CNHK / ov / Akamai / 最快 upos 一起赛跑 ----------

// 用池里前两个主机快速判断 CNHK 接受哪种写法；都不行就说明这个视频不能走 CNHK
async function detectVariant(akamURL) {
  const tries = [];
  for (const variant of ["params", "raw"]) {
    for (const h of CNHK_POOL.slice(0, 2)) tries.push(probe(buildCNHKURL(akamURL, h, variant), 0, "bytes=0-1023").then((r) => (r ? variant : null)));
  }
  const ok = (await Promise.all(tries)).filter(Boolean);
  return ok.indexOf("params") >= 0 ? "params" : ok[0] || null;
}

// 候选的 key 只描述“用哪条线路”，这样同一次排名可以套用到其他清晰度和后续视频
function candidateURL(key, ctx) {
  if (key === "akam") return ctx.akam;
  if (key === "ov") return ctx.ov;
  if (key.indexOf("cnhk:") === 0) return ctx.variant ? buildCNHKURL(ctx.akam, key.slice(5), ctx.variant) : "";
  if (key.indexOf("upos:") === 0) return ctx.ov ? withHost(ctx.ov, "https:", key.slice(5)) : "";
  return "";
}

let choicePromise = null;

// 同一次脚本里只测一次；StickyMin 分钟内直接复用上次排名，避免分片之间换线路。
// 返回 { order, variant }，让同一响应里的其他流（其他清晰度、音频）套用同一结果
function rankRoutes(ctx) {
  if (choicePromise) return choicePromise;
  choicePromise = (async () => {
    const platform = getParam(ctx.akam, "platform");
    const cached = readJSON(KEY_CHOICE);
    if (cached && cached.order && cached.platform === platform && Date.now() - cached.time < STICKY_MIN * 60000) {
      return { order: cached.order, variant: cached.variant || null };
    }
    ctx.variant = await detectVariant(ctx.akam);
    const keys = ["akam"];
    if (ctx.ov) keys.push("ov");
    if (ctx.variant) CNHK_POOL.forEach((h) => keys.push("cnhk:" + h));
    const best = readJSON(KEY_BEST);
    if (ctx.ov && best && best.host && best.mode === "throughput" && Date.now() - best.time < MAX_AGE_MIN * 60000 && best.host !== hostOf(ctx.ov) && !isCNHKHost(best.host)) {
      keys.push("upos:" + best.host);
    }
    const results = await Promise.all(keys.map((k, i) => probe(candidateURL(k, ctx), i).then((r) => (r ? { key: k, index: i, bps: r.bps } : null))));
    const ok = results.filter(Boolean).sort((a, b) => (Math.abs(a.bps - b.bps) <= 1024 ? a.index - b.index : b.bps - a.bps));
    const order = ok.map((r) => r.key).concat(keys.filter((k) => !ok.some((r) => r.key === k)));
    writeJSON(KEY_CHOICE, { order, variant: ctx.variant, platform, bps: ok.length ? ok[0].bps : 0, time: Date.now() });
    console.log("[BiliCDN] 线路测速：" + (ok.map((r) => r.key.replace(".bilivideo.com", "") + "@" + ((r.bps * 8) / 1e6).toFixed(1) + "Mbps").join(", ") || "全部超时，保留原地址"));
    return { order: ok.length ? order : ["akam"].concat(order.filter((k) => k !== "akam")), variant: ctx.variant };
  })();
  return choicePromise;
}

async function akamaiPlan(akamURL, all) {
  const ctx = { akam: akamURL, ov: all.filter((u) => OV_HOSTS.indexOf(hostOf(u)) >= 0)[0] || "", variant: null };
  const { order, variant } = await rankRoutes(ctx);
  ctx.variant = variant;
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
  if (akam) writeJSON(KEY_SAMPLE_AKAM, { url: akam, ua, deadline: Number(getParam(akam, "deadline")) || 0, time: Date.now() });
  if (upos) writeJSON(KEY_SAMPLE, { url: upos, ua, deadline: Number(getParam(upos, "deadline")) || 0, time: Date.now() });
  sampled = !!(akam || upos);
}

async function planFor(primary, backups) {
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
    const plan = await planFor(node[mainKey], backups);
    if (plan && plan.primary) {
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
  const plan = await planFor(primary, backups);
  if (!plan || !plan.primary || (plan.primary === primary && sameList(plan.backups, backups))) return buf;
  pbCount++;
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

(async () => {
  const headers = Object.assign({}, $response.headers);
  let ctype = "";
  for (const k of Object.keys(headers)) if (k.toLowerCase() === "content-type") ctype = String(headers[k]).split(";")[0].trim();

  if (/grpc/.test(ctype)) {
    const raw = $response.body instanceof Uint8Array ? $response.body : new Uint8Array($response.body || []);
    if (raw.length < 5) return $done({});
    const body = grpcDecode(raw);
    const next = await rewriteMessage(body, "Reply");
    if (next === body) return $done({});
    console.log("[BiliCDN] PlayViewUnite 改写 " + pbCount + " 条地址");
    deleteHeader(headers, "content-length");
    // 改写后统一不压缩，同时去掉压缩声明
    deleteHeader(headers, "grpc-encoding");
    return $done({ body: grpcEncode(next), headers });
  }

  if (/json/.test(ctype) || /^\s*\{/.test($response.body || "")) {
    const json = JSON.parse($response.body || "{}");
    const count = await rewriteJSON(json);
    if (!count) return $done({});
    console.log("[BiliCDN] playurl 改写 " + count + " 处");
    deleteHeader(headers, "content-length");
    return $done({ body: JSON.stringify(json), headers });
  }
  $done({});
})().catch((e) => {
  console.log("[BiliCDN] playurl error: " + e);
  $done({});
});

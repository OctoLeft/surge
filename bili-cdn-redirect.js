/*
 * BiliBili CDN Speed — 视频流重定向脚本 (type=http-request)
 *
 * 把海外/港澳台/国际版/PCDN/MCDN 的 upgcxcode 视频请求改写到测速得出的最快 CDN。
 * - 最快主机来自 $persistentStore 的 bili_cdn_best（由 bili-cdn-speedtest.js 写入）
 * - 没有结果或结果过期时，用当前请求对候选主机做一次快速竞速（适用于不跑 cron 的 Apple TV）
 * - 每次顺便记录一条带签名的原始 URL，供测速脚本做真实吞吐测试
 */

const KEY_BEST = "bili_cdn_best";
const KEY_SAMPLE = "bili_cdn_sample";
const KEY_LOCK = "bili_cdn_race_lock";

const DEFAULT_CANDIDATES = [
  "upos-sz-mirrorali.bilivideo.com",
  "upos-sz-mirrorcos.bilivideo.com",
  "upos-sz-mirrorhw.bilivideo.com",
  "upos-sz-mirrorhwo1.bilivideo.com",
  "upos-sz-mirror08c.bilivideo.com",
  "upos-sz-mirroraliov.bilivideo.com",
  "upos-sz-mirrorcosov.bilivideo.com",
  "upos-sz-mirrorhwov.bilivideo.com",
  "cn-hk-eq-01-01.bilivideo.com",
  "cn-hk-eq-01-03.bilivideo.com",
  "cn-hk-eq-01-09.bilivideo.com",
  "cn-hk-eq-01-10.bilivideo.com",
  "cn-hk-eq-01-12.bilivideo.com",
  "cn-hk-eq-01-13.bilivideo.com",
  "cn-hk-eq-01-14.bilivideo.com",
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

const args = parseArgs(typeof $argument === "undefined" ? "" : $argument);
const FALLBACK = args.Fallback || "upos-sz-mirrorcosov.bilivideo.com";
const MAX_AGE_MIN = Number(args.MaxAge || 120);
const RACE_TIMEOUT = Number(args.RaceTimeout || 2.5);
const REWRITE_MAINLAND = args.RewriteMainland !== "false";
const CANDIDATES = args.Candidates
  ? args.Candidates.split(/[,|]/).map((s) => s.trim()).filter(Boolean)
  : DEFAULT_CANDIDATES;

// 拆 URL（Surge 的 JSC 没有 URL 类时也能用）
function splitUrl(url) {
  const m = url.match(/^(https?):\/\/([^/:?#]+)(?::(\d+))?(\/[^?#]*)?(\?[^#]*)?/i);
  if (!m) return null;
  return { scheme: m[1].toLowerCase(), host: m[2].toLowerCase(), port: m[3] || "", path: m[4] || "/", query: m[5] || "" };
}

function getParam(query, name) {
  const m = query.match(new RegExp("[?&]" + name + "=([^&]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}

// 是否是需要接管的视频流主机
function shouldRewrite(u) {
  const h = u.host;
  if (!u.path.startsWith("/upgcxcode/")) return false;
  if (/^upos-(sz|hz|bstar1)-mirrorakam\.akamaized\.net$/.test(h)) return true;
  if (/^cn-hk-eq-[a-z0-9-]+\.bilivideo\.com$/.test(h)) return true;
  if (/^upos-sz-mirror[a-z0-9-]*(ov|bstar1)\.bilivideo\.com$/.test(h)) return true;
  if (/\.mcdn\.bilivideo\.cn$/.test(h)) return true; // MCDN 上的 upgcxcode 路径
  if (u.port === "4480") return true; // PCDN
  if (REWRITE_MAINLAND && /^upos-[a-z0-9-]*mirror[a-z0-9-]*\.bilivideo\.com$/.test(h)) return true;
  return false;
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === lower) return headers[k];
  return undefined;
}

function rebuild(u, host) {
  return "https://" + host + u.path + u.query;
}

// 对当前请求竞速：并发请求前 64KB，第一个成功返回的主机胜出
function race(u, headers) {
  return new Promise((resolve) => {
    let pending = CANDIDATES.length;
    let done = false;
    const finish = (host) => {
      if (done) return;
      if (host || --pending === 0) {
        done = true;
        resolve(host || null);
      }
    };
    const ua = headerValue(headers, "User-Agent");
    for (const host of CANDIDATES) {
      $httpClient.get(
        {
          url: rebuild(u, host),
          timeout: RACE_TIMEOUT,
          headers: Object.assign({ Range: "bytes=0-65535", "X-BiliCDN-Probe": "1", Referer: "https://www.bilibili.com/" }, ua ? { "User-Agent": ua } : {}),
          "binary-mode": true,
        },
        (err, resp) => finish(!err && resp && (resp.status === 200 || resp.status === 206) ? host : null)
      );
    }
    setTimeout(() => finish(null), (RACE_TIMEOUT + 0.5) * 1000);
  });
}

(async () => {
  const u = splitUrl($request.url);
  // 测速/竞速自己发出的请求带这个头，不再改写，防止递归
  if (!u || headerValue($request.headers, "X-BiliCDN-Probe") || !shouldRewrite(u)) return $done({});

  // 记录样本 URL（带签名）给测速脚本；deadline 是签名过期的 unix 秒
  if (!u.host.endsWith(".mcdn.bilivideo.cn") && u.port !== "4480") {
    $persistentStore.write(
      JSON.stringify({
        url: $request.url,
        ua: headerValue($request.headers, "User-Agent") || "",
        deadline: Number(getParam(u.query, "deadline")) || 0,
        time: Date.now(),
      }),
      KEY_SAMPLE
    );
  }

  let best = readJSON(KEY_BEST);
  const stale = !best || !best.host || Date.now() - (best.time || 0) > MAX_AGE_MIN * 60000;
  let host = best && best.host ? best.host : FALLBACK;

  // 同一时间只让一个请求去竞速，其他请求先用旧结果，避免一次起播触发几十次竞速
  const lock = Number($persistentStore.read(KEY_LOCK) || 0);
  if (stale && args.InlineRace !== "false" && Date.now() - lock > (RACE_TIMEOUT + 2) * 1000) {
    $persistentStore.write(String(Date.now()), KEY_LOCK);
    const winner = await race(u, $request.headers);
    if (winner) host = winner;
    // 全部失败也记下时间，免得后续每个请求都重新竞速
    $persistentStore.write(JSON.stringify({ host, mode: winner ? "race" : "race-failed", time: Date.now() }), KEY_BEST);
  }

  if (host === u.host && !u.port) return $done({});

  const headers = Object.assign({}, $request.headers);
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "host" || k === ":authority") headers[k] = host;
  }
  $done({ url: rebuild(u, host), headers });
})().catch((e) => {
  console.log("[BiliCDN] redirect error: " + e);
  $done({});
});

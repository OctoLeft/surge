/*
 * BiliBili CDN Speed — 测速脚本 (cron / generic 面板)
 *
 * 阶段 1：所有候选并发请求一小段，测首包延迟，淘汰不可用的主机
 * 阶段 2：延迟最低的前 N 个逐个下载 SampleKB，测真实吞吐（逐个跑，避免互相抢带宽）
 * 有最近一次播放记录下的带签名 URL 时用它测真实视频分片；没有则只测延迟
 * 结果写入 bili_cdn_best，由 bili-cdn-redirect.js 使用
 *
 * 作为面板时：普通刷新只显示上次结果；点按面板按钮才重新测速
 */

const KEY_BEST = "bili_cdn_best";
const KEY_RANK = "bili_cdn_rank";
const KEY_SAMPLE = "bili_cdn_sample";

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
const CANDIDATES = args.Candidates
  ? args.Candidates.split(/[,|]/).map((s) => s.trim()).filter(Boolean)
  : DEFAULT_CANDIDATES;
const TOP_N = Number(args.TopN || 5);
const SAMPLE_KB = Number(args.SampleKB || 2048);
const TIMEOUT = Number(args.Timeout || 6);
const NOTIFY = args.Notify !== "false";
const UA = "Bilibili Freedoooooom/MarkII";

function get(url, headers, timeout) {
  return new Promise((resolve) => {
    const start = Date.now();
    $httpClient.get(
      { url, headers: Object.assign({ "X-BiliCDN-Probe": "1" }, headers), timeout, "binary-mode": true },
      (err, resp, data) => {
        const ms = Date.now() - start;
        const ok = !err && resp && (resp.status === 200 || resp.status === 206);
        const bytes = data ? data.byteLength || data.length || 0 : 0;
        resolve({ ok, ms, bytes, status: resp ? resp.status : 0, err: err ? String(err) : "" });
      }
    );
  });
}

// 有可用签名 URL 就返回 { path+query, ua }，否则 null
function usableSample() {
  const s = readJSON(KEY_SAMPLE);
  if (!s || !s.url) return null;
  const nowSec = Date.now() / 1000;
  // 签名过期前至少留 2 分钟；没有 deadline 字段时按 2 小时有效估算
  if (s.deadline ? s.deadline - nowSec < 120 : Date.now() - s.time > 2 * 3600 * 1000) return null;
  const m = s.url.match(/^https?:\/\/[^/]+(\/.*)$/);
  return m ? { pathQuery: m[1], ua: s.ua || UA } : null;
}

function fmtSpeed(bps) {
  if (!bps) return "-";
  const mbps = (bps * 8) / 1e6;
  return mbps >= 1 ? mbps.toFixed(1) + " Mbps" : ((bps * 8) / 1e3).toFixed(0) + " Kbps";
}

function shortName(host) {
  return host.replace(/\.bilivideo\.com$/, "").replace(/^upos-sz-mirror/, "");
}

async function speedTest() {
  const sample = usableSample();
  const baseHeaders = { Referer: "https://www.bilibili.com/", "User-Agent": sample ? sample.ua : UA };
  const urlFor = (host) => "https://" + host + (sample ? sample.pathQuery : "/");

  // 阶段 1：并发测延迟
  const latency = await Promise.all(
    CANDIDATES.map(async (host) => {
      const r = await get(urlFor(host), Object.assign({ Range: "bytes=0-1023" }, baseHeaders), Math.min(TIMEOUT, 4));
      // 没有样本时请求的是 "/"，任何 HTTP 响应都说明主机可达
      const reachable = sample ? r.ok : r.status > 0;
      return { host, latency: reachable ? r.ms : Infinity };
    })
  );
  const alive = latency.filter((x) => x.latency !== Infinity).sort((a, b) => a.latency - b.latency);
  if (!alive.length) throw new Error("所有候选 CDN 都不可达");

  let ranked;
  if (sample) {
    // 阶段 2：前 N 名逐个测吞吐
    const top = alive.slice(0, TOP_N);
    const end = SAMPLE_KB * 1024 - 1;
    for (const item of top) {
      const r = await get(urlFor(item.host), Object.assign({ Range: "bytes=0-" + end }, baseHeaders), TIMEOUT);
      item.speed = r.ok && r.bytes ? (r.bytes * 1000) / Math.max(r.ms, 1) : 0;
    }
    ranked = top.sort((a, b) => b.speed - a.speed || a.latency - b.latency);
    if (!ranked[0].speed) ranked = alive; // 吞吐全失败（比如签名刚失效），退回延迟排名
  } else {
    ranked = alive;
  }

  const best = { host: ranked[0].host, mode: sample ? "throughput" : "latency", speed: ranked[0].speed || 0, latency: ranked[0].latency, time: Date.now() };
  $persistentStore.write(JSON.stringify(best), KEY_BEST);
  $persistentStore.write(JSON.stringify(ranked.slice(0, 5)), KEY_RANK);
  return { best, ranked };
}

function summary(best, ranked) {
  const lines = (ranked || []).slice(0, 5).map(
    (r, i) => `${i + 1}. ${shortName(r.host)}  ${r.speed ? fmtSpeed(r.speed) + " · " : ""}${Math.round(r.latency)}ms`
  );
  const when = new Date(best.time);
  const hhmm = ("0" + when.getHours()).slice(-2) + ":" + ("0" + when.getMinutes()).slice(-2);
  const mode = best.mode === "throughput" ? "吞吐" : best.mode === "latency" ? "仅延迟（先播一个视频可测吞吐）" : "播放时竞速";
  return { head: `最快：${shortName(best.host)}`, body: [`${hhmm} · ${mode}`].concat(lines).join("\n") };
}

(async () => {
  const isPanel = typeof $script !== "undefined" && $script.type === "generic";
  const isButton = typeof $trigger !== "undefined" && $trigger === "button";

  if (isPanel && !isButton) {
    const best = readJSON(KEY_BEST);
    if (!best) return $done({ title: "B站 CDN 测速", content: "还没有结果，点按右侧按钮测速", icon: "play.tv" });
    const s = summary(best, readJSON(KEY_RANK) || [{ host: best.host, latency: best.latency || 0, speed: best.speed }]);
    return $done({ title: "B站 CDN · " + s.head.replace("最快：", ""), content: s.body, icon: "play.tv" });
  }

  const { best, ranked } = await speedTest();
  const s = summary(best, ranked);
  console.log("[BiliCDN] " + s.head + "\n" + s.body);
  if (NOTIFY && !isPanel) $notification.post("B站 CDN 测速", s.head, s.body);
  $done(isPanel ? { title: "B站 CDN · " + shortName(best.host), content: s.body, icon: "play.tv" } : {});
})().catch((e) => {
  console.log("[BiliCDN] speedtest error: " + e);
  $done(typeof $script !== "undefined" && $script.type === "generic" ? { title: "B站 CDN 测速", content: "失败：" + e.message, icon: "exclamationmark.triangle" } : {});
});

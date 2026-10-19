/*
 * BiliBili CDN Speed — 测速脚本 (cron / generic 面板)
 *
 * 阶段 1：所有候选并发请求一小段，测首包延迟，淘汰不可用的主机
 * 阶段 2：延迟最低的前 N 个逐个下载 SampleKB，测真实吞吐（逐个跑，避免互相抢带宽）
 * 样本是 bili-cdn-playurl.js 在 playurl 返回时记下的 upos 签名地址；没有样本时只测延迟
 * 结果写入 bili_cdn_best，供 playurl 脚本改写 upos 地址、并作为 Akamai 线路赛跑的候选之一
 *
 * 作为面板时：普通刷新只显示上次结果；点按面板按钮才重新测速
 */

const KEY_BEST = "bili_cdn_best";
const KEY_RANK = "bili_cdn_rank";
const KEY_SAMPLE = "bili_cdn_sample";
const KEY_CHOICE = "bili_cdn_choice";

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

function writeJSON(key, value) {
  $persistentStore.write(JSON.stringify(value), key);
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
      { url, headers: headers, timeout, "binary-mode": true },
      (err, resp, data) => {
        const ms = Date.now() - start;
        const ok = !err && resp && (resp.status === 200 || resp.status === 206);
        const bytes = data ? data.byteLength || data.length || 0 : 0;
        resolve({ ok, ms, bytes, status: resp ? resp.status : 0, err: err ? String(err) : "" });
      }
    );
  });
}

// 签名样本还有效就返回，否则 null（过期前至少留 2 分钟；没有 deadline 时按 2 小时估算）
function usableSample(key) {
  const s = readJSON(key);
  if (!s || !s.url) return null;
  const nowSec = Date.now() / 1000;
  if (s.deadline ? s.deadline - nowSec < 120 : Date.now() - s.time > 2 * 3600 * 1000) return null;
  return { url: s.url, ua: s.ua || UA };
}

// 阶段 1 并发测延迟，阶段 2 对前 N 名逐个测吞吐；hasSample=false 时只测延迟
async function rank(candidates, urlFor, ua, hasSample) {
  const headers = { Referer: "https://www.bilibili.com/", "User-Agent": ua };
  const latency = await Promise.all(
    candidates.map(async (host) => {
      const r = await get(urlFor(host), Object.assign({ Range: "bytes=0-1023" }, headers), Math.min(TIMEOUT, 4));
      // 没有样本时请求的是 "/"，任何 HTTP 响应都说明主机可达
      const reachable = hasSample ? r.ok : r.status > 0;
      return { host, latency: reachable ? r.ms : Infinity };
    })
  );
  const alive = latency.filter((x) => x.latency !== Infinity).sort((a, b) => a.latency - b.latency);
  if (!alive.length || !hasSample) return alive;
  const top = alive.slice(0, TOP_N);
  const end = SAMPLE_KB * 1024 - 1;
  for (const item of top) {
    const r = await get(urlFor(item.host), Object.assign({ Range: "bytes=0-" + end }, headers), TIMEOUT);
    item.speed = r.ok && r.bytes ? (r.bytes * 1000) / Math.max(r.ms, 1) : 0;
  }
  const ranked = top.sort((a, b) => b.speed - a.speed || a.latency - b.latency);
  return ranked[0].speed ? ranked : alive; // 吞吐全失败（比如签名刚失效），退回延迟排名
}

async function speedTest() {
  const sample = usableSample(KEY_SAMPLE);
  const pathQuery = sample ? sample.url.replace(/^https?:\/\/[^/]+/, "") : "/";
  const ranked = await rank(CANDIDATES, (h) => "https://" + h + pathQuery, sample ? sample.ua : UA, !!sample);
  if (!ranked.length) throw new Error("所有候选 CDN 都不可达");
  writeJSON(KEY_BEST, { host: ranked[0].host, mode: sample ? "throughput" : "latency", speed: ranked[0].speed || 0, latency: ranked[0].latency, time: Date.now() });
  writeJSON(KEY_RANK, ranked.slice(0, 5));
}

function hhmm(t) {
  const d = new Date(t);
  return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
}

// 面板/通知内容：Akamai 线路赛跑结果（播放时测）和 upos 测速结果各一段
function summary() {
  const best = readJSON(KEY_BEST);
  const ranked = readJSON(KEY_RANK) || [];
  const choice = readJSON(KEY_CHOICE);
  const lines = [];
  let head = "还没有结果";
  if (choice && choice.order && choice.order.length) {
    const route = (k) => shortName(k.replace(/^(cnhk|upos):/, ""));
    head = "线路 " + route(choice.order[0]);
    lines.push(`Akamai 线路 · ${hhmm(choice.time)} · ${choice.bps ? fmtSpeed(choice.bps) : "-"}：` + choice.order.slice(0, 3).map(route).join(" > "));
  }
  if (best && best.host) {
    const mode = best.mode === "throughput" ? "吞吐" : "仅延迟（先播一个视频可测吞吐）";
    if (!choice) head = "最快 " + shortName(best.host);
    lines.push(`upos · ${hhmm(best.time)} · ${mode}`);
    ranked.slice(0, 5).forEach((r, i) => lines.push(`${i + 1}. ${shortName(r.host)}  ${r.speed ? fmtSpeed(r.speed) + " · " : ""}${Math.round(r.latency)}ms`));
  }
  return { head, body: lines.join("\n") || "点按右侧按钮测速" };
}

(async () => {
  const isPanel = typeof $script !== "undefined" && $script.type === "generic";
  const isButton = typeof $trigger !== "undefined" && $trigger === "button";

  if (!isPanel || isButton) await speedTest();
  const s = summary();
  if (!isPanel) {
    console.log("[BiliCDN] " + s.head + "\n" + s.body);
    if (NOTIFY) $notification.post("B站 CDN 测速", s.head, s.body);
    return $done({});
  }
  $done({ title: "B站 CDN · " + s.head, content: s.body, icon: "play.tv" });
})().catch((e) => {
  console.log("[BiliCDN] speedtest error: " + e);
  $done(typeof $script !== "undefined" && $script.type === "generic" ? { title: "B站 CDN 测速", content: "失败：" + e.message, icon: "exclamationmark.triangle" } : {});
});

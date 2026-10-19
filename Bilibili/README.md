# 📺 BiliBili: ⚡ CDN Speed（Surge 模块）

用来替代 Biliverse Redirect。Redirect 把视频地址固定改写到一个主机；这个模块会测速，然后在 **playurl 返回时**就把地址换成最快的线路。之后播放器直接请求目标主机，视频分片不再经过 MitM 和脚本。

模块地址：`https://raw.githubusercontent.com/OctoLeft/surge/main/Bilibili/BiliBili.CDNSpeed.sgmodule`

## 工作方式
| 文件 | 作用 |
|---|---|
| `BiliBili.CDNSpeed.sgmodule` | 模块：只对 B 站 API 域名做 MitM，不碰视频域名 |
| `bili-cdn-playurl.js` | 改写 playurl (JSON) 和 PlayViewUnite (gRPC) 响应里的视频地址，并记录测速样本 |
| `bili-cdn-speedtest.js` | 后台 cron / 面板：用样本对 15 个 upos 主机测吞吐，写入 `bili_cdn_best` |

`bili-cdn-playurl.js` 不发任何网络请求，只读后台测好的结果，所以 playurl 响应只多几毫秒。之前在这里现场赛跑，会拖住响应约 6 秒，Apple TV 上因此完全播不动。

- **Akamai 签名地址**（`upos-hz-mirrorakam`，带 `os=akam` 和 `hdnts`，tvOS 上常见）
  - 按后台赛跑的排名排列，第一名做主地址，其余放进 `backup_url`。参加赛跑的有：Akamai 原地址、海外 ov、CNHK 各主机、最快的 upos 主机，每条下载 1 MB。
  - 还没有排名时用默认顺序，Akamai 优先。
- **其他 upos 签名地址**：换成后台测出的最快主机，原地址放进 `backup_url`。

`bili-cdn-speedtest.js`（cron / 面板按钮）用播放时记下的签名地址测速：
- Akamai 线路赛跑，结果写入 `bili_cdn_choice`。
- 15 个 upos 主机测吞吐，结果写入 `bili_cdn_best`。

CNHK 的规则来自 [BiliBili-Redirect-tvOS](https://github.com/OctoLeft/BiliBili-Redirect-tvOS)：
- 只接受 http，签名 query 必须原样保留。
- tvOS 客户端的地址要补 `buvid` 和 `build`；Web 端（`platform=pc`）的地址补了反而返回 403。所以脚本会先探测哪种写法能用，并按 `platform` 记住结果。

在澳大利亚实测（2026-10-19，下载 8 MB）：Akamai 15–67 Mbps，海外 ov 只有 0.6–3.8 Mbps，CNHK 不到 1 Mbps。B 站有时会把 ov 地址放在主地址、Akamai 放在备用，这就是卡顿的来源。不同网络的结果差别很大，所以脚本靠赛跑决定，不预设优先哪条线路。

## 安装
1. **iOS**：Surge → 模块 → 安装新模块 → 填入上面的地址。**Apple TV**：Surge → 模块 → 从 URL 安装。
2. **停用 Biliverse Redirect 和 BiliBili Redirect tvOS**，否则会重复改写。
3. 开启 MitM 和脚本，并信任 Surge 证书。Apple TV 需要用 Apple Configurator 安装证书，然后在“设置 → 通用 → 关于本机 → 证书信任设置”里打开完全信任。

`$persistentStore` 不跨设备同步，iPhone 和 Apple TV 各自测速、各自保存结果。

## 参数
- `CNHKPool`：自定义 CNHK 主机，用 `|` 分隔。
- `Build` / `Buvid`：CNHK 地址补的参数。`Buvid` 留空时自动生成。
- `MaxAge`：后台测速结果的有效期（分钟），默认 120。过期后 upos 地址不改写，Akamai 地址改用默认顺序。
- `Cron` / `TopN` / `SampleKB` / `Notify` / `Candidates`：后台 upos 测速设置。

## 排查
- 每次 playurl 都会在日志里留一行 `[BiliCDN]`，写明改写了几条流、主地址从哪个主机换到哪个主机、用的是测速排名还是默认顺序，以及耗时。没有这行日志，说明脚本没有被触发：检查 MitM、证书和模块是否启用。
- 后台测速的日志是 `[BiliCDN] Akamai 线路赛跑：…`。
- 面板会显示当前的 Akamai 线路排名和 upos 测速结果。
- 想立刻重新测速，点面板上的按钮。

## 维护
改了脚本后，记得把模块里 `script-path` 末尾的 `?v=` 改成新的值。Surge 更新模块时只比较模块文件；脚本地址变了，才会重新下载脚本。

## Apple TV 卡在第一个连接
Apple TV 的播放器会优先用 QUIC（HTTP/3，走 UDP）连 `upos-hz-mirrorakam.akamaized.net`。在 Surge Dashboard 里能看到，这条 QUIC 连接经过 Surge 转发后，几分钟只下载了 15–17 KB，播放器就一直卡在这条连接上。手机走的是 TCP 分片，所以不受影响。

模块里的 `[Rule]` 会拒绝发往 `akamaized.net`、`bilivideo.com`、`bilivideo.cn` 的 QUIC，播放器随即退回 TCP/HTTPS。Apple TV 实测：QUIC 被 REJECT 后，同一个视频走 HTTPS，17 秒下载了 16.8 MB。

**更新模块后要在 Surge 里重新加载配置**，新加的规则才会生效。脚本改动靠 `?v=` 就能生效，规则改动不行。

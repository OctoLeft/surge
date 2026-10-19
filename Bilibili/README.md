# 📺 BiliBili: ⚡ CDN Speed（Surge 模块）

用来替代 Biliverse Redirect。Redirect 把视频地址固定改写到一个主机；这个模块会测速，然后在 **playurl 返回时**就把地址换成最快的线路。之后播放器直接请求目标主机，视频分片不再经过 MitM 和脚本。

模块地址：`https://raw.githubusercontent.com/OctoLeft/surge/main/Bilibili/BiliBili.CDNSpeed.sgmodule`

## 工作方式
| 文件 | 作用 |
|---|---|
| `BiliBili.CDNSpeed.sgmodule` | 模块：只对 B 站 API 域名做 MitM，不碰视频域名 |
| `bili-cdn-playurl.js` | 改写 playurl (JSON) 和 PlayViewUnite (gRPC) 响应里的视频地址，并记录测速样本 |
| `bili-cdn-speedtest.js` | 后台 cron / 面板：用样本对 15 个 upos 主机测吞吐，写入 `bili_cdn_best` |

`bili-cdn-playurl.js` 分两种地址处理：

- **Akamai 签名地址**（`upos-hz-mirrorakam`，带 `os=akam` 和 `hdnts`，tvOS 上常见）
  - 下面这些线路一起下载 1 MB 赛跑：CNHK 各主机、海外 ov 地址、Akamai 原地址、后台测出的最快 upos 主机。
  - 最快的做主地址，其余按速度放进 `backup_url`。
  - 排名在 `StickyMin` 分钟内固定，避免分片之间切换线路。
- **其他 upos 签名地址**：换成后台测出的最快主机，原地址放进 `backup_url`。

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
- `StickyMin`：Akamai 线路排名固定多少分钟，默认 30。过期后，下一次打开视频时会重新赛跑。
- `ProbeTimeout`：赛跑时每条线路最多等几秒，默认 4。
- `CNHKPool`：自定义 CNHK 主机，用 `|` 分隔。
- `Build` / `Buvid`：CNHK 地址补的参数。`Buvid` 留空时自动生成。
- `MaxAge`：upos 测速结果的有效期（分钟）。
- `Cron` / `TopN` / `SampleKB` / `Notify` / `Candidates`：后台 upos 测速设置。

## 排查
- 在脚本日志里搜索 `[BiliCDN]`，能看到线路赛跑结果（`线路测速：…`）和每次改写了多少处。
- 面板会显示当前的 Akamai 线路排名和 upos 测速结果。
- 想立刻重新赛跑，删除持久化数据里的 `bili_cdn_choice`。

## 维护
改了脚本后，记得把模块里 `script-path` 末尾的 `?v=` 改成新的值。Surge 更新模块时只比较模块文件；脚本地址变了，才会重新下载脚本。

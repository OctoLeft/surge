# 📺 BiliBili: ⚡ CDN Speed（Surge 模块）

用来替代 Biliverse Redirect。Redirect 会把视频流固定改写到一个主机名；这个模块会自动测速，然后改写到当前最快的 CDN。

## 工作方式
| 文件 | 作用 |
|---|---|
| `BiliBili.CDNSpeed.sgmodule` | 模块：MITM、force-http-engine、脚本、面板 |
| `bili-cdn-redirect.js` | 把 `upgcxcode` 视频请求（海外 ov / cn-hk-eq / Akamai / 国际版 / PCDN / MCDN / 大陆 upos）改写到最快主机，同时记录一条带签名的 URL 作为测速样本 |
| `bili-cdn-speedtest.js` | 15 个候选主机一起测延迟，再对延迟最低的前 5 个逐个下载 2 MB 测吞吐，把结果写入 `bili_cdn_best` |

测速有三种触发方式：
1. **cron**：默认每 30 分钟一次（iOS）。
2. **面板**：点按面板按钮会立刻测速（iOS）。
3. **播放时竞速**：结果不存在或超过 `MaxAge` 分钟时，第一个视频请求会把当前分片同时发给所有候选主机，谁先返回就用谁。这一步会让起播慢 1–3 秒。Apple TV 不跑 cron 时主要靠这种方式。

在 iOS 上没播过视频时只能测延迟（面板会显示“仅延迟”）。看一次视频后，下一轮测速就能用真实分片测吞吐。

## 安装
1. 模块地址：`https://raw.githubusercontent.com/OctoLeft/surge/main/Bilibili/BiliBili.CDNSpeed.sgmodule`（脚本用的是同一仓库的 raw 绝对地址）
2. **iOS**：Surge → 首页 → 模块 → 安装新模块 → 填入 `.sgmodule` 的 URL。
   **Apple TV**：Surge → 模块 → 从 URL 安装，填同一个 URL。
3. **停用 Biliverse Redirect**，否则两个模块会抢着改写。Enhanced / Global / ADBlock 可以继续用。
4. 确认 MITM 已开启，并且证书已经信任。

注意：`$persistentStore` 不会在设备之间同步，所以 iPhone 和 Apple TV 各自测速、各自保存结果。

## 参数（模块 → 编辑参数）
- `Fallback`：还没有结果时使用的主机，默认 `upos-sz-mirrorcosov.bilivideo.com`
- `Cron`：测速频率
- `MaxAge`：结果多少分钟后过期，过期后会在播放时竞速，默认 120
- `TopN` / `SampleKB`：参与吞吐测试的主机数、每个主机下载的大小
- `Notify`：后台测速完成后是否通知
- `InlineRace`：是否允许播放时竞速
- `RewriteMainland`：是否也接管大陆 `upos-sz-mirror*` 主机
- `Candidates`：自定义候选主机，用 `|` 分隔

## 排查
- Surge 的脚本日志里搜索 `[BiliCDN]`，可以看到排名和改写目标。
- 想清空结果重新测，删除持久化数据里的 `bili_cdn_best`，或者直接点面板。

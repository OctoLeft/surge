# Surge

Surge 模块、脚本和规则，统一用 URL 引用，这样 iOS、Apple TV 和 Mac 都能读到同一份。

| 目录 | 内容 | 引用地址 |
|---|---|---|
| [`Bilibili/`](Bilibili) | ⚡ CDN Speed：自动测速并把 B 站视频流改写到最快的 CDN | `https://raw.githubusercontent.com/OctoLeft/surge/main/Bilibili/BiliBili.CDNSpeed.sgmodule` |
| [`Nord/`](Nord) | NordVPN WireGuard 槽位选择脚本（由 Surge-Nord `tools/migrate.py` 写入配置） | `https://raw.githubusercontent.com/OctoLeft/surge/main/Nord/nord.js` |

这个仓库不放任何密钥：
- NordVPN token 只在 Mac 上用一次，用来换取私钥。
- 私钥只写在 iCloud 里的私有配置文件中。

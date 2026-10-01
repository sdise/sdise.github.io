# sdise 的博客

> Cloudflare Workers 开源项目笔记 · 纯前端在线网络工具
>
> 站点：<https://sdise.github.io>

## 快速跳转

| 页面 | 地址 | 说明 |
| --- | --- | --- |
| 博客首页 | <https://sdise.github.io/index.html> | 开源项目介绍、部署与踩坑笔记，以及文章归档 |
| 网络测速 | <https://sdise.github.io/speed.html> | 纯浏览器端的延迟 / 抖动 / 下载 / 上传测速与链路诊断，打开即用 |
| VPNGate 节点检测 | <https://vpngate-test.edgeoneai.cc.cd/> | 在线检测 VPNGate 节点是否可用，并把节点转成 vless 链接（vpngate-test 的在线实例） |
| 归档 | <https://sdise.github.io/archives> | 全部文章列表 |
| 项目 | <https://sdise.github.io/projects/> | 开源项目索引 |

## 开源项目

- **cf-b2-worker** — Cloudflare Workers ⇄ Backblaze B2 一体化网关：自带 AWS SigV4 实现与网页文件管理器，读写闭环、预签名直传、分片上传；匿名只读 `/share/` 公开目录、下载强制经 Worker；CF 与 B2 同属带宽联盟，回源与出网双向免流量费。
  项目页 <https://sdise.github.io/projects/cf-b2-worker/> ｜ 在线预览 <https://b2.edgeoneai.cc.cd/share/> ｜ 源码 <https://github.com/sdise/cf-b2>
- **cf-vpngate** — 前端 VLESS over WebSocket / XHTTP，后端可走 SSTP（VPN Gate 公共节点）、ProxyIP、socks5、http(s) 或 TXT 记录随机落地；SSTP 分支在 Worker 内完成 PPP 协商并手工封装 IPv4/TCP。
  <https://sdise.github.io/projects/cf-vpngate/>
- **vpngate** — VPNGate 节点自动采集与订阅生成：每小时从官方 API 增量入库，每天用 xray 内核逐条实测连通性，只把实测有效的节点输出成 v2rayN / Clash 两种订阅。
  <https://sdise.github.io/projects/vpngate/>
- **vpngate-test** — VPNGate 节点在线检测 + VLESS 链接转换：粘贴节点或整段 `vpngate.csv`，在 Cloudflare 边缘节点直连做完整 SSTP 握手（LCP / PAP / IPCP）挑出有效节点，再一键转成 `vless://` 链接（UUID / ENTRY_HOST / ENTRY_PORT / Host-SNI / ws-xhttp / global 均可自定义）。单文件 Worker，自带 Web 界面与 HTTP API。
  项目页 <https://sdise.github.io/projects/vpngate-test/> ｜ 在线预览 <https://vpngate-test.edgeoneai.cc.cd/> ｜ 源码 <https://github.com/sdise/vpngate-test>

- **javascript-store** — 暂无描述
  <https://github.com/sdise/javascript-store>
- **proxypool** — 暂无描述
  <https://github.com/sdise/proxypool>
- **web_speed** — 暂无描述
  <https://github.com/sdise/web_speed>
- **cf-b2** — Cloudflare Workers ⇄ Backblaze B2 一体化网关：单文件、零依赖，自带 AWS Signature V4 实现和网页文件管理器
  <https://github.com/sdise/cf-b2>

- **js-store** — 自用脚本合集
  <https://github.com/sdise/js-store>

## 网络测速仪

<https://sdise.github.io/speed.html>

- HTTPS 延迟与抖动探测（自定义目标、次数、超时、并发、协议）
- 多并发下载 / 上传带宽测速，实时速度曲线、峰值 / 均值 / 首字节统计
- DNS / TLS / 协议链路诊断与公网 IP、ASN、地区等环境信息
- 结果可复制、导出 CSV，历史记录保存在浏览器 `localStorage`
- 纯前端实现，测速数据不出本机

## 关于本仓库

本仓库是 <https://sdise.github.io> 的站点源码（Hexo 生成的静态文件，由 GitHub Pages 发布）：

```text
index.html      博客首页
speed.html      网络测速仪
projects/       开源项目页面
archives/       文章归档
2024/           按日期归档的文章
css/ js/ fancybox/   静态资源
atom.xml        RSS 订阅
sitemap.xml    站点地图
robots.txt     爬虫规则
```

## 许可

文章内容与代码的版权归作者所有，转载请注明出处。

# MusicFreeDesktop-WJL Changelog

Upstream base: `maotoumao/MusicFreeDesktop@f3b526a6c1ea9313b277810a8e12003605a98982`

## v0.3.0

### v0.1.0 — Download UX
- 每次点击下载可直接选择 low / standard / high / super 四档音质。
- 单曲下载图标与批量右键下载均支持音质选择。
- 新增客户端全局最大歌曲时长过滤，单位分钟，`0` 表示不限制。

### v0.2.0 — Cotton / format compatibility
- 插件媒体源协议新增可选 `extension` 字段。
- 下载器优先尊重插件声明的真实扩展名，避免 CDN URL / m4s 后缀误判。
- 不把有损音源伪装成 FLAC；格式由音源插件明确声明。

### v0.3.0 — Download task management
- 下载页增加暂停、继续、取消、失败重试。
- 暂停使用 AbortController 中断连接；继续优先通过 HTTP Range 从断点恢复。
- 服务器不支持 Range 时自动从 0 安全重下，避免文件拼接损坏。
- 新增全局速度限制（KB/s），`0` 表示不限速；修改设置会同步到正在下载/暂停的任务。
- 取消任务会删除未完成文件。

## Current limitation
- 暂停/继续目前是当前应用会话内的任务管理；尚未实现退出应用后自动恢复任务队列。
- 不支持 HTTP Range 的源在恢复时会从头重新下载。

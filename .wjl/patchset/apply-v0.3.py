from __future__ import annotations

import argparse
import json
from pathlib import Path

UPSTREAM_SHA = "f3b526a6c1ea9313b277810a8e12003605a98982"
WJL_VERSION = "0.3.0"


def replace_once(root: Path, rel: str, old: str, new: str) -> None:
    path = root / rel
    text = path.read_text(encoding="utf-8")
    if old not in text:
        raise RuntimeError(f"Expected block not found in {rel}: {old[:100]!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip() + "\n", encoding="utf-8")


def patch_package(root: Path) -> None:
    path = root / "package.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["productName"] = "MusicFree WJL"
    data["version"] = WJL_VERSION
    data["description"] = "MusicFreeDesktop WJL enhanced build with advanced download management"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def patch_config(root: Path) -> None:
    replace_once(
        root,
        "src/types/app-config.d.ts",
        '    /** 最多同时下载 */\n    "download.concurrency": number;\n',
        '    /** 最多同时下载 */\n    "download.concurrency": number;\n'
        '    /** 最大允许下载时长（分钟），0 = 不限制 */\n    "download.maxDurationMinutes": number;\n'
        '    /** 全局下载速度限制（KB/s），0 = 不限速 */\n    "download.speedLimitKbps": number;\n',
    )
    replace_once(
        root,
        "src/shared/app-config/default-app-config.ts",
        '    "download.concurrency": 5,\n',
        '    "download.concurrency": 5,\n'
        '    "download.maxDurationMinutes": 0,\n'
        '    "download.speedLimitKbps": 0,\n',
    )
    replace_once(
        root,
        "src/types/plugin.d.ts",
        '    /** 音质 */\n    quality?: IMusic.IQualityKey;\n',
        '    /** 音质 */\n    quality?: IMusic.IQualityKey;\n'
        '    /** 下载文件扩展名提示（不含点），避免 CDN URL 后缀误判 */\n'
        '    extension?: string;\n',
    )
    replace_once(
        root,
        "src/common/constant.ts",
        '    /** 下载中 */\n    DOWNLOADING = "DOWNLOADING",\n    /** 失败 */\n    ERROR = "ERROR",\n    /** 下载完成 */\n    DONE = "DONE",\n',
        '    /** 下载中 */\n    DOWNLOADING = "DOWNLOADING",\n'
        '    /** 已暂停，可继续 */\n    PAUSED = "PAUSED",\n'
        '    /** 失败 */\n    ERROR = "ERROR",\n'
        '    /** 已取消 */\n    CANCELLED = "CANCELLED",\n'
        '    /** 下载完成 */\n    DONE = "DONE",\n',
    )


def patch_quality_menu(root: Path) -> None:
    replace_once(
        root,
        "src/renderer/components/MusicList/index.tsx",
        '            onClick() {\n                Downloader.startDownload(musicItems);\n            },\n',
        '            subMenu: [\n'
        '                { title: "省流（low）", onClick() { Downloader.startDownload(musicItems, "low"); } },\n'
        '                { title: "标准（standard）", onClick() { Downloader.startDownload(musicItems, "standard"); } },\n'
        '                { title: "高音质（high）", onClick() { Downloader.startDownload(musicItems, "high"); } },\n'
        '                { title: "最高 / 无损优先（super）", onClick() { Downloader.startDownload(musicItems, "super"); } },\n'
        '            ],\n',
    )


def patch_download_table(root: Path) -> None:
    path = root / "src/renderer/pages/main-page/views/download-view/components/Downloading/index.tsx"
    text = path.read_text(encoding="utf-8")
    text = text.replace(
        'import DownloadStatus from "./DownloadStatus";\n',
        'import DownloadStatus from "./DownloadStatus";\nimport DownloadActions from "./DownloadActions";\n',
        1,
    )
    marker = '    columnHelper.accessor("platform", {\n        header: () => t("media.media_platform"),\n'
    if marker not in text:
        raise RuntimeError("Downloading table platform column marker not found")
    actions = (
        '    columnHelper.display({\n'
        '        header: () => "任务控制",\n'
        '        size: 160,\n'
        '        id: "actions",\n'
        '        cell: (info) => <DownloadActions musicItem={info.row.original}></DownloadActions>,\n'
        '    }),\n'
    )
    path.write_text(text.replace(marker, actions + marker, 1), encoding="utf-8")


def patch_docs(root: Path) -> None:
    original = (root / "README.md").read_text(encoding="utf-8")
    banner = (
        f'# MusicFreeDesktop-WJL v{WJL_VERSION}\n\n'
        '> 基于 `maotoumao/MusicFreeDesktop` 的个人增强版。当前重点：每次下载选四档音质、全局时长过滤、Cotton/格式扩展名提示、下载暂停/恢复/取消/重试与速度限制。\n'
        f'> 上游基线：`{UPSTREAM_SHA}`。详细改动见 [`WJL_CHANGELOG.md`](./WJL_CHANGELOG.md)。\n\n---\n\n'
    )
    (root / "README.md").write_text(banner + original, encoding="utf-8")

    write(
        root,
        "WJL_CHANGELOG.md",
        f'''# MusicFreeDesktop-WJL Changelog

Upstream base: `maotoumao/MusicFreeDesktop@{UPSTREAM_SHA}`

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
''',
    )
    write(
        root,
        ".wjl/upstream.json",
        json.dumps(
            {
                "repository": "maotoumao/MusicFreeDesktop",
                "branch": "master",
                "base_commit": UPSTREAM_SHA,
                "wjl_version": WJL_VERSION,
            },
            ensure_ascii=False,
            indent=2,
        ),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=".")
    args = parser.parse_args()
    root = Path(args.repo).resolve()

    patch_package(root)
    patch_config(root)
    patch_quality_menu(root)
    patch_download_table(root)
    patch_docs(root)
    print(f"Applied WJL v{WJL_VERSION} metadata and patches on {UPSTREAM_SHA}")


if __name__ == "__main__":
    main()

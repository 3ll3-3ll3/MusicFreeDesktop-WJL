import { isSameMedia } from "@/common/media-util";
import SvgAsset, { SvgAssetIconNames } from "@/renderer/components/SvgAsset";
import { memo } from "react";
import "./index.scss";
import { DownloadState, localPluginName } from "@/common/constant";
import Downloader from "@/renderer/core/downloader";
import { useTranslation } from "react-i18next";
import { showContextMenu } from "../ContextMenu";

interface IMusicDownloadedProps {
    musicItem: IMusic.IMusicItem;
    size?: number;
}

function MusicDownloaded(props: IMusicDownloadedProps) {
    const { musicItem, size = 18 } = props;
    const downloadState = Downloader.useDownloadState(musicItem);
    const { t } = useTranslation();
    const isDownloadedOrLocal =
        downloadState === DownloadState.DONE || musicItem?.platform === localPluginName;

    let iconName: SvgAssetIconNames = "array-download-tray";
    if (isDownloadedOrLocal) {
        iconName = "check-circle";
    } else if (
        downloadState !== DownloadState.NONE &&
        downloadState !== DownloadState.ERROR &&
        downloadState !== DownloadState.CANCELLED
    ) {
        iconName = downloadState === DownloadState.PAUSED ? "motion-play" : "rolling-1s";
    }

    return (
        <div
            className={`music-download-base ${
                isDownloadedOrLocal ? "music-downloaded" : "music-can-download"
            }`}
            title={isDownloadedOrLocal ? t("common.downloaded") : "下载（选择音质）"}
            onClick={(evt) => {
                if (
                    musicItem &&
                    (downloadState === DownloadState.NONE ||
                        downloadState === DownloadState.ERROR ||
                        downloadState === DownloadState.CANCELLED)
                ) {
                    evt.stopPropagation();
                    showContextMenu({
                        x: evt.clientX,
                        y: evt.clientY,
                        menuItems: [
                            { title: "省流（low）", onClick: () => Downloader.startDownload(musicItem, "low") },
                            { title: "标准（standard）", onClick: () => Downloader.startDownload(musicItem, "standard") },
                            { title: "高音质（high）", onClick: () => Downloader.startDownload(musicItem, "high") },
                            { title: "最高 / 无损优先（super）", onClick: () => Downloader.startDownload(musicItem, "super") },
                        ],
                    });
                }
            }}
        >
            <SvgAsset iconName={iconName} size={size}></SvgAsset>
        </div>
    );
}

export default memo(MusicDownloaded, (prev, curr) =>
    isSameMedia(prev.musicItem, curr.musicItem),
);

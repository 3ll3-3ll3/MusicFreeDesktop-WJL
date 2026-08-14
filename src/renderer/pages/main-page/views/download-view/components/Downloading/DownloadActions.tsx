import { DownloadState } from "@/common/constant";
import Downloader from "@/renderer/core/downloader";

export default function DownloadActions({ musicItem }: { musicItem: IMusic.IMusicItem }) {
    const status = Downloader.useDownloadStatus(musicItem);
    const buttonStyle = {
        marginRight: 6,
        padding: "2px 8px",
        cursor: "pointer",
    } as const;

    if (!status) return null;

    return (
        <div style={{ display: "flex", alignItems: "center" }}>
            {status.state === DownloadState.DOWNLOADING ? (
                <button style={buttonStyle} onClick={() => Downloader.pauseDownload(musicItem)}>
                    暂停
                </button>
            ) : null}
            {status.state === DownloadState.PAUSED ? (
                <button style={buttonStyle} onClick={() => Downloader.resumeDownload(musicItem)}>
                    继续
                </button>
            ) : null}
            {status.state === DownloadState.ERROR ? (
                <button style={buttonStyle} onClick={() => Downloader.retryDownload(musicItem)}>
                    重试
                </button>
            ) : null}
            {status.state !== DownloadState.DONE ? (
                <button style={buttonStyle} onClick={() => Downloader.cancelDownload(musicItem)}>
                    取消
                </button>
            ) : null}
        </div>
    );
}

import {
    getMediaPrimaryKey,
    getQualityOrder,
    isSameMedia,
    setInternalData,
} from "@/common/media-util";
import * as Comlink from "comlink";
import { DownloadState, localPluginName } from "@/common/constant";
import PQueue from "p-queue";
import {
    addDownloadedMusicToList,
    isDownloaded,
    removeDownloadedMusic,
    setupDownloadedMusicList,
    useDownloaded,
    useDownloadedMusicList,
} from "./downloaded-sheet";
import { getGlobalContext } from "@/shared/global-context/renderer";
import Store from "@/common/store";
import { useEffect, useState } from "react";
import { DownloadEvts, ee } from "./ee";
import AppConfig from "@shared/app-config/renderer";
import PluginManager from "@shared/plugin-manager/renderer";

export interface IDownloadStatus {
    state: DownloadState;
    downloaded?: number;
    total?: number;
    msg?: string;
}

const downloadingMusicStore = new Store<Array<IMusic.IMusicItem>>([]);
const downloadingProgress = new Map<string, IDownloadStatus>();

type ProxyMarkedFunction<T extends (...args: any) => void> = T & Comlink.ProxyMarked;
type IOnStateChangeFunc = (data: IDownloadStatus) => void;

interface IDownloaderWorker {
    downloadFile: (
        mediaSource: IMusic.IMusicSource,
        filePath: string,
        onStateChange: ProxyMarkedFunction<IOnStateChangeFunc>,
        taskId: string,
        speedLimitKbps?: number,
    ) => Promise<void>;
    pauseDownload: (taskId: string) => Promise<void>;
    resumeDownload: (taskId: string) => Promise<void>;
    cancelDownload: (taskId: string) => Promise<void>;
    setDownloadSpeedLimit: (taskId: string, speedLimitKbps: number) => Promise<void>;
}

let downloaderWorker: IDownloaderWorker;

async function setupDownloader() {
    setupDownloaderWorker();
    setupDownloadedMusicList();
}

function setupDownloaderWorker() {
    const downloaderWorkerPath = getGlobalContext().workersPath.downloader;
    if (downloaderWorkerPath) {
        const worker = new Worker(downloaderWorkerPath);
        downloaderWorker = Comlink.wrap(worker);
    }
    setDownloadingConcurrency(Number(AppConfig.getConfig("download.concurrency")));
}

const concurrencyLimit = 20;
const downloadingQueue = new PQueue({ concurrency: 5 });

function setDownloadingConcurrency(concurrency: number) {
    if (isNaN(concurrency)) return;
    downloadingQueue.concurrency = Math.min(concurrency < 1 ? 1 : concurrency, concurrencyLimit);
}

function passesDurationLimit(item: IMusic.IMusicItem) {
    const maxMinutes = Number(AppConfig.getConfig("download.maxDurationMinutes") ?? 0);
    const duration = Number(item?.duration ?? 0);
    return maxMinutes <= 0 || duration <= 0 || duration <= maxMinutes * 60;
}

async function startDownload(
    musicItems: IMusic.IMusicItem | IMusic.IMusicItem[],
    requestedQuality?: IMusic.IQualityKey,
) {
    if (!downloaderWorker) setupDownloaderWorker();

    const _musicItems = Array.isArray(musicItems) ? musicItems : [musicItems];
    const _validMusicItems = _musicItems.filter(
        (it) =>
            !isDownloaded(it) &&
            it.platform !== localPluginName &&
            !downloadingProgress.has(getMediaPrimaryKey(it)) &&
            passesDurationLimit(it),
    );

    const skippedByDuration = _musicItems.length - _musicItems.filter(passesDurationLimit).length;
    if (skippedByDuration > 0) {
        console.warn(`[WJL Downloader] 已按时长上限跳过 ${skippedByDuration} 首音频`);
    }

    const downloadCallbacks = _validMusicItems.map((it) => {
        const pk = getMediaPrimaryKey(it);
        downloadingProgress.set(pk, { state: DownloadState.WAITING });

        return async () => {
            if (!downloadingProgress.has(pk)) return;

            downloadingProgress.set(pk, { state: DownloadState.DOWNLOADING });
            const fileName = `${it.title}-${it.artist}`.replace(/[/|\\?*"<>:]/g, "_");

            await new Promise<void>((resolve) => {
                downloadMusicImpl(
                    it,
                    fileName,
                    (stateData) => {
                        downloadingProgress.set(pk, stateData);
                        ee.emit(DownloadEvts.DownloadStatusUpdated, it, stateData);

                        if (stateData.state === DownloadState.DONE) {
                            downloadingMusicStore.setValue((prev) =>
                                prev.filter((di) => !isSameMedia(it, di)),
                            );
                            downloadingProgress.delete(pk);
                            resolve();
                        } else if (stateData.state === DownloadState.CANCELLED) {
                            downloadingMusicStore.setValue((prev) =>
                                prev.filter((di) => !isSameMedia(it, di)),
                            );
                            downloadingProgress.delete(pk);
                            resolve();
                        } else if (stateData.state === DownloadState.ERROR) {
                            resolve();
                        }
                    },
                    requestedQuality,
                );
            });
        };
    });

    downloadingMusicStore.setValue((prev) => [...prev, ..._validMusicItems]);
    downloadingQueue.addAll(downloadCallbacks);
}

function getSafeExtension(mediaSource: IPlugin.IMediaSourceResult) {
    const hinted = String(mediaSource.extension ?? "").replace(/^\./, "").trim();
    if (hinted && /^[a-zA-Z0-9]{1,8}$/.test(hinted)) return hinted.toLowerCase();
    return mediaSource.url?.match(/.*\/.+\.([^./?#]+)/)?.[1]?.toLowerCase() ?? "mp3";
}

async function downloadMusicImpl(
    musicItem: IMusic.IMusicItem,
    fileName: string,
    onStateChange: IOnStateChangeFunc,
    requestedQuality?: IMusic.IQualityKey,
) {
    const [defaultQuality, whenQualityMissing] = [
        AppConfig.getConfig("download.defaultQuality"),
        AppConfig.getConfig("download.whenQualityMissing"),
    ];
    const qualityOrder = getQualityOrder(
        requestedQuality ?? defaultQuality,
        whenQualityMissing,
    );

    let mediaSource: IPlugin.IMediaSourceResult | null = null;
    let realQuality: IMusic.IQualityKey = qualityOrder[0];

    for (const quality of qualityOrder) {
        try {
            mediaSource = await PluginManager.callPluginDelegateMethod(
                musicItem,
                "getMediaSource",
                musicItem,
                quality,
            );
            if (!mediaSource?.url) continue;
            realQuality = quality;
            break;
        } catch {}
    }

    try {
        if (!mediaSource?.url) throw new Error("Invalid Source");

        const ext = getSafeExtension(mediaSource);
        const downloadBasePath =
            AppConfig.getConfig("download.path") ?? getGlobalContext().appPath.downloads;
        const downloadPath = window.path.resolve(downloadBasePath, `./${fileName}.${ext}`);
        const taskId = getMediaPrimaryKey(musicItem);
        const speedLimitKbps = Number(AppConfig.getConfig("download.speedLimitKbps") ?? 0);

        downloaderWorker.downloadFile(
            mediaSource,
            downloadPath,
            Comlink.proxy((dataState) => {
                onStateChange(dataState);
                if (dataState.state === DownloadState.DONE) {
                    addDownloadedMusicToList(
                        setInternalData<IMusic.IMusicItemInternalData>(
                            musicItem as any,
                            "downloadData",
                            { path: downloadPath, quality: realQuality },
                            true,
                        ) as IMusic.IMusicItem,
                    );
                }
            }),
            taskId,
            speedLimitKbps,
        );
    } catch (e) {
        console.log(e, "ERROR");
        onStateChange({
            state: DownloadState.ERROR,
            msg: e instanceof Error ? e.message : String(e),
        });
    }
}

function pauseDownload(musicItem: IMusic.IMusicItem) {
    const pk = getMediaPrimaryKey(musicItem);
    if (downloadingProgress.get(pk)?.state === DownloadState.DOWNLOADING) {
        downloaderWorker?.pauseDownload(pk);
    }
}

function resumeDownload(musicItem: IMusic.IMusicItem) {
    const pk = getMediaPrimaryKey(musicItem);
    if (downloadingProgress.get(pk)?.state === DownloadState.PAUSED) {
        downloaderWorker?.resumeDownload(pk);
    }
}

function cancelDownload(musicItem: IMusic.IMusicItem) {
    const pk = getMediaPrimaryKey(musicItem);
    const status = downloadingProgress.get(pk);
    if (!status) return;

    if (status.state === DownloadState.WAITING || status.state === DownloadState.ERROR) {
        downloadingProgress.delete(pk);
        downloadingMusicStore.setValue((prev) =>
            prev.filter((di) => !isSameMedia(musicItem, di)),
        );
        ee.emit(DownloadEvts.DownloadStatusUpdated, musicItem, {
            state: DownloadState.CANCELLED,
        });
        return;
    }
    downloaderWorker?.cancelDownload(pk);
}

function retryDownload(musicItem: IMusic.IMusicItem) {
    cancelDownload(musicItem);
    startDownload(musicItem);
}

function setGlobalSpeedLimit(speedLimitKbps: number) {
    const normalized = Math.max(0, Number(speedLimitKbps) || 0);
    if (!downloaderWorker) return;
    for (const musicItem of downloadingMusicStore.getValue()) {
        const pk = getMediaPrimaryKey(musicItem);
        const state = downloadingProgress.get(pk)?.state;
        if (state === DownloadState.DOWNLOADING || state === DownloadState.PAUSED) {
            downloaderWorker.setDownloadSpeedLimit(pk, normalized);
        }
    }
}

function useDownloadStatus(musicItem: IMusic.IMusicItem) {
    const [downloadStatus, setDownloadStatus] = useState<IDownloadStatus | null>(null);

    useEffect(() => {
        setDownloadStatus(downloadingProgress.get(getMediaPrimaryKey(musicItem)) || null);

        const updateFn = (mi: IMusic.IMusicItem, stateData: IDownloadStatus) => {
            if (isSameMedia(mi, musicItem)) setDownloadStatus(stateData);
        };
        ee.on(DownloadEvts.DownloadStatusUpdated, updateFn);
        return () => ee.off(DownloadEvts.DownloadStatusUpdated, updateFn);
    }, [musicItem]);

    return downloadStatus;
}

function useDownloadState(musicItem: IMusic.IMusicItem) {
    const musicStatus = useDownloadStatus(musicItem);
    const downloaded = useDownloaded(musicItem);
    return musicStatus?.state || (downloaded ? DownloadState.DONE : DownloadState.NONE);
}

const Downloader = {
    setupDownloader,
    startDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    retryDownload,
    setGlobalSpeedLimit,
    useDownloadStatus,
    useDownloadingMusicList: downloadingMusicStore.useValue,
    useDownloaded,
    isDownloaded,
    useDownloadedMusicList,
    removeDownloadedMusic,
    setDownloadingConcurrency,
    useDownloadState,
};
export default Downloader;

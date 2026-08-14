import * as Comlink from "comlink";
import fs from "fs";
import fsPromises from "fs/promises";
import type { FileHandle } from "fs/promises";
import { encodeUrlHeaders } from "@/common/normalize-util";
import { DownloadState } from "@/common/constant";
import { rimraf } from "rimraf";

async function cleanFile(filePath: string) {
    try {
        if ((await fsPromises.stat(filePath)).isFile()) await rimraf(filePath);
        return true;
    } catch {
        return false;
    }
}

type IOnStateChangeFunc = (data: {
    state: DownloadState;
    downloaded?: number;
    total?: number;
    msg?: string;
}) => void;

interface ITaskControl {
    paused: boolean;
    cancelled: boolean;
    controller?: AbortController;
    resumeWaiters: Array<() => void>;
    speedLimitKbps: number;
    onStateChange: IOnStateChangeFunc;
    downloaded: number;
    total: number;
    filePath: string;
}

const tasks = new Map<string, ITaskControl>();
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function delayInterruptible(ms: number, task: ITaskControl) {
    let remaining = ms;
    while (remaining > 0 && !task.paused && !task.cancelled) {
        const part = Math.min(100, remaining);
        await delay(part);
        remaining -= part;
    }
}

function waitForResume(task: ITaskControl) {
    if (!task.paused || task.cancelled) return Promise.resolve();
    return new Promise<void>((resolve) => task.resumeWaiters.push(resolve));
}

function releaseResumeWaiters(task: ITaskControl) {
    for (const resolve of task.resumeWaiters.splice(0)) resolve();
}

function parseTotalSize(res: Response, alreadyDownloaded: number) {
    const contentRange = res.headers.get("content-range");
    const rangeMatch = contentRange?.match(/\/(\d+)$/);
    if (rangeMatch) return Number(rangeMatch[1]);
    const contentLength = Number(res.headers.get("content-length") || 0);
    if (!contentLength) return 0;
    return res.status === 206 ? alreadyDownloaded + contentLength : contentLength;
}

async function fetchSource(
    mediaSource: IMusic.IMusicSource,
    headers: Record<string, string>,
    controller: AbortController,
) {
    const urlObj = new URL(mediaSource.url);
    if (urlObj.username && urlObj.password) {
        headers["Authorization"] = `Basic ${btoa(
            `${decodeURIComponent(urlObj.username)}:${decodeURIComponent(urlObj.password)}`,
        )}`;
        urlObj.username = "";
        urlObj.password = "";
        return fetch(urlObj.toString(), { headers, signal: controller.signal });
    }
    return fetch(encodeUrlHeaders(mediaSource.url, headers), {
        headers,
        signal: controller.signal,
    });
}

async function downloadFile(
    mediaSource: IMusic.IMusicSource,
    filePath: string,
    onStateChange: IOnStateChangeFunc,
    taskId: string = filePath,
    speedLimitKbps: number = 0,
) {
    await cleanFile(filePath);

    const task: ITaskControl = {
        paused: false,
        cancelled: false,
        resumeWaiters: [],
        speedLimitKbps: Math.max(0, Number(speedLimitKbps) || 0),
        onStateChange,
        downloaded: 0,
        total: 0,
        filePath,
    };
    tasks.set(taskId, task);

    try {
        while (!task.cancelled) {
            if (task.paused) {
                onStateChange({
                    state: DownloadState.PAUSED,
                    downloaded: task.downloaded,
                    total: task.total,
                });
                await waitForResume(task);
                continue;
            }

            if (task.total > 0 && task.downloaded >= task.total) break;

            const headers: Record<string, string> = {
                ...(mediaSource.headers ?? {}),
                "user-agent": mediaSource.userAgent,
            };
            if (task.downloaded > 0) headers.Range = `bytes=${task.downloaded}-`;

            const controller = new AbortController();
            task.controller = controller;
            let handle: FileHandle | undefined;
            let streamCompleted = false;

            try {
                const res = await fetchSource(mediaSource, headers, controller);
                if (!res.ok && res.status !== 206) {
                    throw new Error(`HTTP ${res.status} ${res.statusText}`);
                }

                if (task.downloaded > 0 && res.status !== 206) {
                    task.downloaded = 0;
                    task.total = 0;
                    await cleanFile(filePath);
                }

                task.total = parseTotalSize(res, task.downloaded);
                onStateChange({
                    state: DownloadState.DOWNLOADING,
                    downloaded: task.downloaded,
                    total: task.total,
                });

                const reader = res.body?.getReader();
                if (!reader) throw new Error("Empty response body");
                handle = await fsPromises.open(filePath, task.downloaded > 0 ? "a" : "w");

                while (!task.paused && !task.cancelled) {
                    const readStarted = Date.now();
                    const result = await reader.read();
                    if (result.done) {
                        streamCompleted = true;
                        break;
                    }

                    const chunk = Buffer.from(result.value);
                    await handle.write(chunk);
                    task.downloaded += chunk.byteLength;

                    onStateChange({
                        state: DownloadState.DOWNLOADING,
                        downloaded: task.downloaded,
                        total: task.total,
                    });

                    const limit = Math.max(0, Number(task.speedLimitKbps) || 0);
                    if (limit > 0) {
                        const targetMs = (chunk.byteLength / (limit * 1024)) * 1000;
                        const spentMs = Date.now() - readStarted;
                        if (targetMs > spentMs) {
                            await delayInterruptible(targetMs - spentMs, task);
                        }
                    }
                }

                if (task.paused || task.cancelled) controller.abort();
            } catch (e) {
                if (!task.paused && !task.cancelled && (e as Error)?.name !== "AbortError") {
                    throw e;
                }
            } finally {
                await handle?.close();
                task.controller = undefined;
            }

            if (streamCompleted && !task.paused && !task.cancelled) break;
        }

        if (task.cancelled) {
            await cleanFile(filePath);
            onStateChange({ state: DownloadState.CANCELLED });
            return;
        }

        onStateChange({ state: DownloadState.DONE });
    } catch (e) {
        await cleanFile(filePath);
        onStateChange({
            state: DownloadState.ERROR,
            msg: e instanceof Error ? e.message : String(e),
        });
    } finally {
        tasks.delete(taskId);
    }
}

async function pauseDownload(taskId: string) {
    const task = tasks.get(taskId);
    if (!task || task.cancelled || task.paused) return;
    task.paused = true;
    task.controller?.abort();
    task.onStateChange({
        state: DownloadState.PAUSED,
        downloaded: task.downloaded,
        total: task.total,
    });
}

async function resumeDownload(taskId: string) {
    const task = tasks.get(taskId);
    if (!task || task.cancelled || !task.paused) return;
    task.paused = false;
    releaseResumeWaiters(task);
    task.onStateChange({
        state: DownloadState.DOWNLOADING,
        downloaded: task.downloaded,
        total: task.total,
    });
}

async function cancelDownload(taskId: string) {
    const task = tasks.get(taskId);
    if (!task) return;
    task.cancelled = true;
    task.paused = false;
    task.controller?.abort();
    releaseResumeWaiters(task);
}

async function setDownloadSpeedLimit(taskId: string, speedLimitKbps: number) {
    const task = tasks.get(taskId);
    if (!task) return;
    task.speedLimitKbps = Math.max(0, Number(speedLimitKbps) || 0);
}

interface IOptions {
    onProgress?: (progress: ICommon.IDownloadFileSize) => Promise<void>;
    onEnded?: () => Promise<void>;
    onError?: (reason: Error) => Promise<void>;
}

async function downloadFileNew(
    mediaSource: IMusic.IMusicSource,
    filePath: string,
    options?: IOptions,
) {
    const taskId = `compat:${filePath}:${Date.now()}`;
    await downloadFile(
        mediaSource,
        filePath,
        (state) => {
            if (state.state === DownloadState.DOWNLOADING) {
                options?.onProgress?.({
                    currentSize: state.downloaded ?? 0,
                    totalSize: state.total ?? 0,
                });
            } else if (state.state === DownloadState.DONE) {
                options?.onEnded?.();
            } else if (state.state === DownloadState.ERROR) {
                options?.onError?.(new Error(state.msg || "Download failed"));
            }
        },
        taskId,
        0,
    );
}

Comlink.expose({
    downloadFile,
    downloadFileNew,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    setDownloadSpeedLimit,
});

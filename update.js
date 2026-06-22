/** 与 manifest.json version 保持同步 */
export const EXT_VERSION = '1.3.0';

/** @type {number | null} */
let backgroundTimer = null;

/**
 * @returns {string}
 */
export function getExtensionFolderName() {
    try {
        const url = decodeURIComponent(import.meta.url);
        const match = url.match(/\/extensions\/third-party\/([^/]+)\//);
        if (match?.[1]) return match[1];
    } catch {
        // ignore
    }
    return 'SillyTavern-Dummy';
}

/**
 * @param {object} context SillyTavern getContext() 返回值
 * @param {string} extensionName
 * @param {boolean} global
 */
async function fetchExtensionVersion(context, extensionName, global = false) {
    const response = await fetch('/api/extensions/version', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ extensionName, global }),
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(text || response.statusText || `HTTP ${response.status}`);
    }
    return response.json();
}

/**
 * @param {object} context SillyTavern getContext() 返回值
 * @param {string} extensionName
 * @param {boolean} global
 */
async function fetchExtensionUpdate(context, extensionName, global = false) {
    const response = await fetch('/api/extensions/update', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ extensionName, global }),
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(text || response.statusText || `HTTP ${response.status}`);
    }
    return response.json();
}

/**
 * @param {object} context SillyTavern getContext()
 * @param {string} extensionName
 */
async function resolveExtensionTarget(context, extensionName) {
    const candidates = [
        { name: extensionName, global: false },
        { name: `/${extensionName}`, global: false },
        { name: extensionName, global: true },
    ];
    for (const candidate of candidates) {
        try {
            const data = await fetchExtensionVersion(context, candidate.name, candidate.global);
            if (data && typeof data === 'object') {
                return { ...candidate, data };
            }
        } catch {
            // try next candidate
        }
    }
    throw new Error('无法定位 Dummy 扩展安装目录（请确认已通过 Git 安装）');
}

/**
 * @param {object} settings
 * @param {(text: string) => void} [setUpdateStatus]
 * @param {{ manual?: boolean, quiet?: boolean }} [options]
 */
export async function checkAndUpdateExtension(context, settings, saveSettings, setUpdateStatus, options = {}) {
    const { manual = false, quiet = false } = options;
    const extensionName = getExtensionFolderName();
    const notify = (message, severity = 'info') => {
        if (quiet && severity === 'info') return;
        const fn = globalThis.toastr?.[severity];
        if (typeof fn === 'function') fn.call(globalThis.toastr, message);
    };

    if (setUpdateStatus) setUpdateStatus('正在检查更新…');

    try {
        const target = await resolveExtensionTarget(context, extensionName);
        settings.lastUpdateCheckAt = Date.now();
        saveSettings();

        if (target.data.isUpToDate) {
            const branch = target.data.currentBranchName ? ` · ${target.data.currentBranchName}` : '';
            const hash = target.data.currentCommitHash?.slice(0, 7) || '';
            const msg = `已是最新版本（${hash}${branch}）`;
            if (setUpdateStatus) setUpdateStatus(msg);
            if (manual || !quiet) notify(msg, 'success');
            return { updated: false, isUpToDate: true, data: target.data };
        }

        if (!settings.updateAutoInstall && !manual) {
            const msg = '发现新版本，等待手动更新';
            if (setUpdateStatus) setUpdateStatus(msg);
            if (!quiet) notify(msg, 'warning');
            return { updated: false, isUpToDate: false, data: target.data };
        }

        if (setUpdateStatus) setUpdateStatus('正在拉取更新…');
        const result = await fetchExtensionUpdate(context, target.name, target.global);

        if (result.isUpToDate) {
            const msg = '已是最新版本';
            if (setUpdateStatus) setUpdateStatus(msg);
            if (manual || !quiet) notify(msg, 'success');
            return { updated: false, isUpToDate: true, data: result };
        }

        const msg = `已更新至 ${result.shortCommitHash || '最新'}，即将刷新页面…`;
        if (setUpdateStatus) setUpdateStatus(msg);
        notify(msg, 'success');

        if (settings.updateAutoReload !== false) {
            await new Promise((r) => setTimeout(r, 1200));
            location.reload();
        }

        return { updated: true, isUpToDate: false, data: result };
    } catch (err) {
        const msg = `更新检查失败：${err?.message || err}`;
        console.error('[Dummy] update failed', err);
        if (setUpdateStatus) setUpdateStatus(msg);
        if (manual || !quiet) notify(msg, 'error');
        return { updated: false, error: err };
    }
}

/**
 * @param {object} context
 * @param {object} settings
 * @param {() => void} saveSettings
 * @param {(text: string) => void} setUpdateStatus
 */
export function restartBackgroundUpdateChecker(context, settings, saveSettings, setUpdateStatus) {
    if (backgroundTimer != null) {
        clearInterval(backgroundTimer);
        backgroundTimer = null;
    }

    if (!settings.updateCheckEnabled) return;

    const intervalMs = Math.max(15, Number(settings.updateCheckIntervalMinutes) || 360) * 60 * 1000;

    const tick = async () => {
        const last = Number(settings.lastUpdateCheckAt) || 0;
        if (Date.now() - last < intervalMs) return;
        await checkAndUpdateExtension(context, settings, saveSettings, setUpdateStatus, {
            manual: false,
            quiet: true,
        });
    };

    backgroundTimer = window.setInterval(() => {
        void tick();
    }, Math.min(intervalMs, 5 * 60 * 1000));

    window.setTimeout(() => void tick(), 45_000);
}

export function stopBackgroundUpdateChecker() {
    if (backgroundTimer != null) {
        clearInterval(backgroundTimer);
        backgroundTimer = null;
    }
}

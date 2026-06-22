import {
    acquireRetryLock,
    releaseRetryLock,
    shouldDeferRegenToExternal,
} from './retry-coordinator.js';

/** @type {StreamRetryDeps | null} */
let deps = null;

/**
 * @typedef {object} StreamRetryDeps
 * @property {() => object} getSettings
 * @property {(reason: string, opts?: { kind?: string }) => Promise<boolean>} runRegenerate
 * @property {() => boolean} isRetryInFlight
 * @property {(v: boolean) => void} setRetryInFlight
 * @property {(text: string) => void} updateStatus
 * @property {(message: string, severity?: string) => void} notify
 */

const runtime = {
    gotStreamToken: false,
    isDryRun: false,
    userStopped: false,
    currentGenerationType: '',
    lastMessageType: '',
    isSwipeGeneration: false,
    lastRequestText: '',
    timeoutTimer: null,
};

/**
 * @param {StreamRetryDeps} d
 */
export function initStreamRetry(d) {
    deps = d;
}

export function resetStreamState() {
    runtime.gotStreamToken = false;
    runtime.isDryRun = false;
    runtime.userStopped = false;
    runtime.currentGenerationType = '';
    runtime.lastMessageType = '';
    runtime.isSwipeGeneration = false;
    runtime.lastRequestText = '';
    clearTimeoutTimer();
}

function clearTimeoutTimer() {
    if (runtime.timeoutTimer != null) {
        clearTimeout(runtime.timeoutTimer);
        runtime.timeoutTimer = null;
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSwipeContext() {
    return runtime.isSwipeGeneration
        || runtime.currentGenerationType === 'swipe'
        || runtime.lastMessageType === 'swipe';
}

function normalizeLooseTailText(text) {
    return String(text ?? '').replace(/[\s\u3000]+/g, '').trim();
}

/**
 * @param {object} settings
 */
function checkApiRequestTail(settings) {
    if (!settings.apiTailEnabled || !settings.apiTailPattern) return true;
    const normalizedRequest = normalizeLooseTailText(runtime.lastRequestText);
    const normalizedPattern = normalizeLooseTailText(settings.apiTailPattern);
    if (!normalizedPattern) return true;
    return normalizedRequest.endsWith(normalizedPattern);
}

/**
 * @param {string} text
 * @param {object} settings
 */
export function shouldSkipMessageForRetry(text, settings) {
    if (settings.skipUpdateVariableTag && /<UpdateVariable>/i.test(text)) {
        return true;
    }
    return false;
}

function promptPartToText(part) {
    if (part === null || part === undefined) return '';
    if (typeof part === 'string') return part;
    if (Array.isArray(part)) {
        return part.map((item) => {
            if (!item) return '';
            if (typeof item === 'string') return item;
            if (item.type === 'text') return item.text || '';
            if (item.type === 'image_url') return '[image]';
            if (item.type === 'video_url') return '[video]';
            return '';
        }).join('');
    }
    if (typeof part === 'object') {
        if ('content' in part) return promptPartToText(part.content);
        return JSON.stringify(part);
    }
    return String(part);
}

function captureRequestText(text) {
    runtime.lastRequestText = String(text ?? '');
}

function isGenerating() {
    return document.body?.dataset?.generating === 'true';
}

function startTimeoutTimer(context) {
    clearTimeoutTimer();
    if (!deps) return;

    const settings = deps.getSettings();
    if (!settings.streamRetryEnabled || settings.requestTimeoutMs <= 0) return;
    if (runtime.isDryRun || runtime.userStopped || isSwipeContext()) return;
    if (shouldDeferRegenToExternal(settings)) return;

    const timeoutMs = Math.max(1000, Number(settings.requestTimeoutMs) || 0);
    runtime.timeoutTimer = window.setTimeout(() => {
        runtime.timeoutTimer = null;
        void handleGenerationTimeout(context);
    }, timeoutMs);
}

/**
 * @param {object} context
 */
async function handleGenerationTimeout(context) {
    if (!deps) return;
    const settings = deps.getSettings();
    if (!settings.streamRetryEnabled || deps.isRetryInFlight()) return;
    if (runtime.isDryRun || runtime.userStopped || isSwipeContext()) return;
    if (shouldDeferRegenToExternal(settings)) return;
    if (!checkApiRequestTail(settings)) return;
    if (!isGenerating()) return;

    try {
        context.stopGeneration?.();
    } catch (err) {
        console.warn('[Dummy] stopGeneration on timeout failed', err);
    }

    const seconds = Math.round((settings.requestTimeoutMs || 0) / 1000);
    await deps.runRegenerate(`生成超时 (${seconds}秒)`, { kind: 'stream' });
}

/**
 * @param {object} context
 */
export async function handleNoTokenGenerationEnded(context) {
    if (!deps) return false;
    const settings = deps.getSettings();
    if (!settings.streamRetryEnabled) return false;
    if (runtime.gotStreamToken || runtime.isDryRun || runtime.userStopped || deps.isRetryInFlight()) {
        return false;
    }
    if (isSwipeContext()) return false;
    if (shouldDeferRegenToExternal(settings)) return false;
    if (!checkApiRequestTail(settings)) return false;
    if (isGenerating()) return false;

    const deferMs = Math.max(0, Number(settings.noTokenCheckDelayMs) || 300);
    await delay(deferMs);

    if (runtime.gotStreamToken || runtime.userStopped || deps.isRetryInFlight()) return false;
    if (isSwipeContext()) return false;
    if (isGenerating()) return false;

    return deps.runRegenerate('未收到回复', { kind: 'stream' });
}

/**
 * @param {object} context
 */
export function bindStreamRetryEvents(context) {
    const { eventSource, eventTypes } = context;

    eventSource.on(eventTypes.GENERATE_AFTER_DATA, (generateData, dryRun) => {
        try {
            if (!generateData) return;
            if (Array.isArray(generateData.prompt)) {
                const text = generateData.prompt.map((msg) => {
                    if (!msg) return '';
                    const role = msg.role ? `[${msg.role}] ` : '';
                    return role + promptPartToText(msg.content);
                }).join('\n');
                captureRequestText(text);
                return;
            }
            if (typeof generateData.prompt === 'string') {
                captureRequestText(generateData.prompt);
            }
        } catch (err) {
            console.debug('[Dummy] capture request text failed', err);
        }
        void dryRun;
    });

    eventSource.on(eventTypes.GENERATION_STARTED, (type, _params, dryRun) => {
        runtime.gotStreamToken = false;
        runtime.isDryRun = !!dryRun;
        runtime.userStopped = false;
        runtime.currentGenerationType = type || '';
        runtime.isSwipeGeneration = type === 'swipe';
        startTimeoutTimer(context);
    });

    eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, () => {
        runtime.gotStreamToken = true;
        clearTimeoutTimer();
    });

    eventSource.on(eventTypes.MESSAGE_RECEIVED, (_id, type) => {
        runtime.lastMessageType = type || '';
        runtime.gotStreamToken = true;
        clearTimeoutTimer();
    });

    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        runtime.userStopped = true;
        runtime.gotStreamToken = true;
        clearTimeoutTimer();
    });

    eventSource.on(eventTypes.GENERATION_ENDED, () => {
        clearTimeoutTimer();
    });
}

export function isSwipeGenerationContext() {
    return isSwipeContext();
}

export function isDryRunGeneration() {
    return runtime.isDryRun;
}

export function wasUserStopped() {
    return runtime.userStopped;
}

export { checkApiRequestTail, isSwipeContext };

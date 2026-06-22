const COORD_KEY = '__dummyRetryCoordinator';
const EXTERNAL_STORAGE_KEY = 'auto_regen_settings_single_tail';

/**
 * @returns {{ owner: string | null, until: number }}
 */
function coord() {
    if (!globalThis[COORD_KEY]) {
        globalThis[COORD_KEY] = { owner: null, until: 0 };
    }
    return globalThis[COORD_KEY];
}

/**
 * @param {string} owner
 * @param {number} [ttlMs]
 */
export function acquireRetryLock(owner, ttlMs = 45000) {
    const c = coord();
    const now = Date.now();
    if (c.owner && c.until > now && c.owner !== owner) return false;
    c.owner = owner;
    c.until = now + ttlMs;
    return true;
}

/**
 * @param {string} owner
 */
export function releaseRetryLock(owner) {
    const c = coord();
    if (c.owner === owner) {
        c.owner = null;
        c.until = 0;
    }
}

/**
 * @returns {{ isEnabled: boolean, minTokenLength: number, requestTimeout: number } | null}
 */
export function readExternalAutoRetrySettings() {
    try {
        const raw = localStorage.getItem(EXTERNAL_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed?.isEnabled) return null;
        return {
            isEnabled: true,
            minTokenLength: Math.max(0, Number(parsed.minTokenLength) || 0),
            requestTimeout: Math.max(0, Number(parsed.requestTimeout) || 0),
        };
    } catch {
        return null;
    }
}

/**
 * @param {{ coexistAutoRetry?: boolean }} settings
 */
export function shouldDeferRegenToExternal(settings) {
    if (!settings.coexistAutoRetry) return false;
    return !!readExternalAutoRetrySettings()?.isEnabled;
}

/**
 * @param {{ coexistAutoRetry?: boolean }} settings
 * @param {number} textLength
 */
export function externalWouldHandleShortReply(settings, textLength) {
    if (!shouldDeferRegenToExternal(settings)) return false;
    const ext = readExternalAutoRetrySettings();
    if (!ext || ext.minTokenLength <= 0) return false;
    return textLength < ext.minTokenLength;
}

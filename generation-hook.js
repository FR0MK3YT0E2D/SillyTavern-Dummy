/** @type {{ finishReason: string | null, at: number, stream?: boolean } | null} */
let lastGenerationMeta = null;
let hookInstalled = false;

const GENERATION_URL_RE = /\/api\/(?:backends\/|novelai\/|openai\/|chats\/)/i;
const GENERATION_ACTION_RE = /generate|chat\/completions|completions|stream/i;

/**
 * @param {string} url
 */
export function isGenerationFetchUrl(url) {
    if (typeof url !== 'string') return false;
    return GENERATION_URL_RE.test(url) && GENERATION_ACTION_RE.test(url);
}

/**
 * @param {unknown} data
 * @returns {string | null}
 */
export function extractFinishReason(data) {
    if (!data || typeof data !== 'object') return null;
    const choices = /** @type {any} */ (data).choices;
    if (Array.isArray(choices) && choices[0]) {
        const ch = choices[0];
        if (ch.finish_reason) return String(ch.finish_reason);
        if (ch.native_finish_reason) return String(ch.native_finish_reason);
    }
    const candidates = /** @type {any} */ (data).candidates;
    if (Array.isArray(candidates) && candidates[0]?.finishReason) {
        return String(candidates[0].finishReason);
    }
    const results = /** @type {any} */ (data).results;
    if (Array.isArray(results) && results[0]?.finish_reason) {
        return String(results[0].finish_reason);
    }
    return null;
}

/**
 * @param {string} sseText
 * @returns {string | null}
 */
export function sniffSseFinishReason(sseText) {
    let last = null;
    for (const line of sseText.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.replace(/^data:\s*/, '').trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            const parsed = JSON.parse(payload);
            const reason = extractFinishReason(parsed);
            if (reason) last = reason;
        } catch {
            // ignore partial SSE lines
        }
    }
    return last;
}

/**
 * @param {Response} response
 */
async function captureGenerationMeta(response) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        const data = await response.json();
        lastGenerationMeta = {
            finishReason: extractFinishReason(data),
            at: Date.now(),
        };
        return;
    }
    if (contentType.includes('text/event-stream')) {
        const text = await response.text();
        lastGenerationMeta = {
            finishReason: sniffSseFinishReason(text),
            at: Date.now(),
            stream: true,
        };
    }
}

export function getLastGenerationMeta() {
    return lastGenerationMeta;
}

export function clearLastGenerationMeta() {
    lastGenerationMeta = null;
}

export function installGenerationHook() {
    if (hookInstalled || typeof window === 'undefined' || !window.fetch) return;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
        const response = await nativeFetch(input, init);
        try {
            const url = typeof input === 'string' ? input : input?.url ?? '';
            if (response.ok && isGenerationFetchUrl(url)) {
                void captureGenerationMeta(response.clone()).catch((err) => {
                    console.debug('[Dummy] generation meta capture failed', err);
                });
            }
        } catch (err) {
            console.debug('[Dummy] generation hook skipped', err);
        }
        return response;
    };
    hookInstalled = true;
}

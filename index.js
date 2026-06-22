const MODULE_NAME = 'Dummy';

const defaultSettings = Object.freeze({
    enabled: true,
    maxRetries: 3,
    delayMs: 1500,
    unlockSettleMs: 100,
    minChars: 1,
    showToast: true,
    stripHtml: true,
});

/** @type {number} */
let consecutiveRetries = 0;
let retryInFlight = false;
let listenersBound = false;

function getContext() {
    return globalThis.SillyTavern?.getContext?.();
}

function getSettings(context) {
    const { extensionSettings, saveSettingsDebounced } = context;
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const s = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, key)) s[key] = structuredClone(defaultSettings[key]);
    }
    return { settings: s, saveSettingsDebounced };
}

function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
        else n.setAttribute(k, v);
    }
    for (const c of children) {
        if (typeof c === 'string') n.appendChild(document.createTextNode(c));
        else if (c) n.appendChild(c);
    }
    return n;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等酒馆把 is_send_press / generating 状态清掉（MESSAGE_RECEIVED 常比解锁更早） */
async function waitForGenerationUnlock(timeoutMs = 10000, intervalMs = 50) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (document.body?.dataset?.generating !== 'true') return;
        await delay(intervalMs);
    }
    throw new Error('等待生成解锁超时');
}

function getLastCharacterMessage(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (msg && !msg.is_user && !msg.is_system) {
            return { index: i, message: msg };
        }
    }
    return null;
}

/**
 * @param {object} message
 * @param {ReturnType<typeof getSettings>['settings']} settings
 */
function getMessageText(message, settings) {
    let text = String(message.mes ?? '');
    if (settings.stripHtml && text.includes('<')) {
        const tmp = document.createElement('div');
        tmp.innerHTML = text;
        text = tmp.textContent || tmp.innerText || '';
    }
    return text.trim();
}

function notify(settings, message, severity = 'warning') {
    if (!settings.showToast) return;
    const fn = globalThis.toastr?.[severity];
    if (typeof fn === 'function') fn.call(globalThis.toastr, message);
}

function updateStatus(text) {
    const el = document.getElementById('dummy_status');
    if (el) el.textContent = text;
}

async function onGenerationEnded() {
    const context = getContext();
    if (!context) return;

    const { settings } = getSettings(context);
    if (!settings.enabled) return;
    if (retryInFlight) return;

    const last = getLastCharacterMessage(context.chat);
    if (!last) return;

    const text = getMessageText(last.message, settings);
    if (text.length >= settings.minChars) {
        consecutiveRetries = 0;
        updateStatus('就绪');
        return;
    }

    if (consecutiveRetries >= settings.maxRetries) {
        notify(settings, `空回已达重试上限（${settings.maxRetries} 次），请手动重刷或检查 API。`);
        updateStatus(`已停止：连续空回 ${settings.maxRetries} 次`);
        consecutiveRetries = 0;
        return;
    }

    retryInFlight = true;
    consecutiveRetries += 1;
    const attempt = consecutiveRetries;
    const settleMs = Math.max(0, Number(settings.unlockSettleMs) || 0);
    const extraMs = Math.max(0, Number(settings.delayMs) || 0);
    updateStatus(`检测到空回，解锁后 ${settleMs + extraMs}ms 自动重刷（${attempt}/${settings.maxRetries}）…`);
    console.info(`[${MODULE_NAME}] Empty reply at #${last.index}, retry ${attempt}/${settings.maxRetries}`);

    try {
        await waitForGenerationUnlock();
        await delay(settleMs);
        if (extraMs > 0) await delay(extraMs);
        if (!settings.enabled) return;

        await context.executeSlashCommandsWithOptions('/regenerate await=true', { forceChatTrigger: false });
    } catch (err) {
        console.error(`[${MODULE_NAME}] regenerate failed`, err);
        notify(settings, `自动重刷失败：${err?.message || err}`, 'error');
        updateStatus(`错误：${err?.message || err}`);
        consecutiveRetries = 0;
    } finally {
        retryInFlight = false;
    }
}

function bindListeners() {
    if (listenersBound) return;
    const context = getContext();
    if (!context?.eventSource || !context?.eventTypes) return;

    const { eventSource, eventTypes } = context;

    eventSource.on(eventTypes.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        consecutiveRetries = 0;
        retryInFlight = false;
        updateStatus('就绪');
    });

    listenersBound = true;
}

function labeledNumber(label, id, initial, min, max, onChange) {
    const input = el('input', { type: 'number', class: 'text_pole wide30px', id, min: String(min), max: String(max) });
    input.value = String(initial);
    input.addEventListener('change', () => {
        let v = Number(input.value);
        if (Number.isNaN(v)) v = initial;
        v = Math.min(max, Math.max(min, v));
        input.value = String(v);
        onChange(v);
    });
    return el('div', { class: 'dummy-field' }, [el('label', { text: label }), input]);
}

async function mountUI() {
    const context = getContext();
    if (!context) {
        console.error(`[${MODULE_NAME}] SillyTavern.getContext 不可用`);
        return;
    }

    bindListeners();

    const { settings, saveSettingsDebounced } = getSettings(context);
    const root = document.getElementById('extensions_settings2');
    if (!root) {
        console.warn(`[${MODULE_NAME}] 找不到 #extensions_settings2，事件监听已启用但无设置面板`);
        return;
    }
    if (document.getElementById('dummy_root')) return;

    const wrap = el('div', { id: 'dummy_root', class: 'dummy-scope' });
    wrap.appendChild(
        el('div', { class: 'inline-drawer dummy-drawer' }, [
            el('div', { class: 'inline-drawer-toggle inline-drawer-header' }, [
                el('b', { text: 'Dummy — 空回自动重刷' }),
                el('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }),
            ]),
            el('div', { class: 'inline-drawer-content' }, [
                el('p', {
                    class: 'dummy-hint',
                    text: '当 AI 回复为空白（或低于最短字符数）时，自动执行 /regenerate 重刷。设有重试上限，避免无限循环。仅处理角色消息，不影响用户或系统消息。',
                }),
                el('label', { class: 'dummy-check' }, [
                    (() => {
                        const c = el('input', { type: 'checkbox' });
                        c.checked = settings.enabled;
                        c.addEventListener('change', () => {
                            settings.enabled = c.checked;
                            saveSettingsDebounced();
                        });
                        return c;
                    })(),
                    el('span', { text: '启用空回自动重刷' }),
                ]),
                el('div', { class: 'dummy-grid' }, [
                    labeledNumber('最多重试次数', 'dummy_max', settings.maxRetries, 1, 10, (v) => {
                        settings.maxRetries = v;
                        saveSettingsDebounced();
                    }),
                    labeledNumber('解锁后缓冲（毫秒）', 'dummy_settle', settings.unlockSettleMs, 0, 5000, (v) => {
                        settings.unlockSettleMs = v;
                        saveSettingsDebounced();
                    }),
                    labeledNumber('额外延迟（毫秒）', 'dummy_delay', settings.delayMs, 0, 30000, (v) => {
                        settings.delayMs = v;
                        saveSettingsDebounced();
                    }),
                    labeledNumber('最短有效字符数', 'dummy_min', settings.minChars, 1, 500, (v) => {
                        settings.minChars = v;
                        saveSettingsDebounced();
                    }),
                ]),
                el('label', { class: 'dummy-check' }, [
                    (() => {
                        const c = el('input', { type: 'checkbox' });
                        c.checked = settings.showToast;
                        c.addEventListener('change', () => {
                            settings.showToast = c.checked;
                            saveSettingsDebounced();
                        });
                        return c;
                    })(),
                    el('span', { text: '达上限时显示提示（toastr）' }),
                ]),
                el('label', { class: 'dummy-check' }, [
                    (() => {
                        const c = el('input', { type: 'checkbox' });
                        c.checked = settings.stripHtml;
                        c.addEventListener('change', () => {
                            settings.stripHtml = c.checked;
                            saveSettingsDebounced();
                        });
                        return c;
                    })(),
                    el('span', { text: '判断前剥除 HTML 标签（仅余空白视为空回）' }),
                ]),
                el('div', { class: 'dummy-status', id: 'dummy_status', text: '就绪' }),
            ]),
        ]),
    );

    const shell = el('div', { id: 'dummy_extension_container', class: 'extension_container' });
    shell.appendChild(wrap);
    root.appendChild(shell);

    $(wrap).find('.inline-drawer-toggle').on('click', function () {
        $(this).closest('.inline-drawer').toggleClass('open');
    });
}

export async function onActivate() {
    await mountUI();
}

function bootstrap() {
    mountUI().catch((err) => console.error(`[${MODULE_NAME}] mount failed`, err));
}

if (typeof jQuery !== 'undefined') {
    jQuery(bootstrap);
} else {
    bootstrap();
}

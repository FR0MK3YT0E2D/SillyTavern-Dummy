import {
    clearLastGenerationMeta,
    getLastGenerationMeta,
    installGenerationHook,
} from './generation-hook.js';
import {
    EXT_VERSION,
    checkAndUpdateExtension,
    restartBackgroundUpdateChecker,
} from './update.js';

const MODULE_NAME = 'Dummy';

const defaultSettings = Object.freeze({
    enabled: true,
    maxRetries: 3,
    delayMs: 1500,
    unlockSettleMs: 100,
    minChars: 1,
    showToast: true,
    stripHtml: true,
    continueEnabled: true,
    maxContinueRetries: 5,
    continueDelayMs: 800,
    minCharsToContinue: 8,
    continueOnLength: true,
    continueOnContentFilter: true,
    continueOnIncomplete: true,
    minIncompleteChars: 40,
    updateCheckEnabled: true,
    updateCheckIntervalMinutes: 360,
    updateAutoInstall: true,
    updateAutoReload: true,
    lastUpdateCheckAt: 0,
});

/** @type {number} */
let consecutiveRetries = 0;
/** @type {number} */
let consecutiveContinueRetries = 0;
let retryInFlight = false;
let listenersBound = false;

/** @type {{ type: 'regenerate' | 'continue', baselineLength: number, messageIndex: number } | null} */
let pendingAction = null;

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
        else if (v !== undefined && v !== null) n.setAttribute(k, v);
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
    const statusEl = document.getElementById('dummy_status');
    if (statusEl) statusEl.textContent = text;
}

function updateUpdateStatus(text) {
    const statusEl = document.getElementById('dummy_update_status');
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.remove('is-ok', 'is-warn', 'is-busy');
    if (/正在|检查/.test(text)) statusEl.classList.add('is-busy');
    else if (/已是最新|已更新/.test(text)) statusEl.classList.add('is-ok');
    else if (/发现|失败|等待/.test(text)) statusEl.classList.add('is-warn');
}

/**
 * @param {string | null | undefined} reason
 * @param {ReturnType<typeof getSettings>['settings']} settings
 */
function isTruncatedFinishReason(reason, settings) {
    if (!reason) return false;
    const r = String(reason).toLowerCase();
    if (settings.continueOnLength && (r === 'length' || r === 'max_tokens' || r.includes('max_tokens'))) {
        return true;
    }
    if (
        settings.continueOnContentFilter
        && (r.includes('content_filter')
            || r.includes('content')
            || r.includes('filter')
            || r.includes('safety')
            || r.includes('prohibited')
            || r.includes('recitation'))
    ) {
        return true;
    }
    return false;
}

/**
 * @param {string} text
 * @param {number} minLen
 */
function looksIncomplete(text, minLen) {
    const t = text.trim();
    if (t.length < minLen) return false;
    if (/[。！？…~」』】）)\]"'》〉]\s*$/u.test(t)) return false;
    if (/<\/\w+>\s*$/.test(t)) return false;
    if (/<[^/>][^>]*$/.test(t)) return true;
    if (/[，、：:；;,\-—]\s*$/.test(t)) return true;
    return true;
}

/**
 * @param {string} text
 * @param {ReturnType<typeof getSettings>['settings']} settings
 */
function isTruncatedResponse(text, settings) {
    const meta = getLastGenerationMeta();
    if (meta?.finishReason && isTruncatedFinishReason(meta.finishReason, settings)) {
        return { truncated: true, reason: `API:${meta.finishReason}` };
    }
    if (settings.continueOnIncomplete && looksIncomplete(text, settings.minIncompleteChars)) {
        return { truncated: true, reason: 'incomplete-ending' };
    }
    return { truncated: false, reason: '' };
}

function resetCounters() {
    consecutiveRetries = 0;
    consecutiveContinueRetries = 0;
    pendingAction = null;
}

async function runSlash(context, command, settings, settleMs, extraMs) {
    await waitForGenerationUnlock();
    await delay(settleMs);
    if (extraMs > 0) await delay(extraMs);
    if (!settings.enabled && command.includes('regenerate')) return;
    if (!settings.continueEnabled && command.includes('continue')) return;
    await context.executeSlashCommandsWithOptions(command, { forceChatTrigger: false });
}

async function onGenerationEnded() {
    const context = getContext();
    if (!context) return;
    if (retryInFlight) return;

    const { settings } = getSettings(context);
    const last = getLastCharacterMessage(context.chat);
    if (!last) return;

    const text = getMessageText(last.message, settings);
    const settleMs = Math.max(0, Number(settings.unlockSettleMs) || 0);

    if (pendingAction && pendingAction.messageIndex === last.index) {
        const grew = text.length > pendingAction.baselineLength;
        if (grew && text.length >= settings.minChars) {
            const stillTruncated = isTruncatedResponse(text, settings);
            if (!stillTruncated.truncated) {
                resetCounters();
                updateStatus('就绪');
                return;
            }
        }
    }

    if (text.length < settings.minChars) {
        consecutiveContinueRetries = 0;
        if (!settings.enabled) return;

        if (consecutiveRetries >= settings.maxRetries) {
            notify(settings, `空回已达重试上限（${settings.maxRetries} 次），请手动重刷或检查 API。`);
            updateStatus(`已停止：连续空回 ${settings.maxRetries} 次`);
            consecutiveRetries = 0;
            pendingAction = null;
            return;
        }

        retryInFlight = true;
        consecutiveRetries += 1;
        const attempt = consecutiveRetries;
        const extraMs = Math.max(0, Number(settings.delayMs) || 0);
        updateStatus(`检测到空回，解锁后 ${settleMs + extraMs}ms 自动重刷（${attempt}/${settings.maxRetries}）…`);
        pendingAction = { type: 'regenerate', baselineLength: text.length, messageIndex: last.index };

        try {
            await runSlash(context, '/regenerate await=true', settings, settleMs, extraMs);
        } catch (err) {
            console.error(`[${MODULE_NAME}] regenerate failed`, err);
            notify(settings, `自动重刷失败：${err?.message || err}`, 'error');
            updateStatus(`错误：${err?.message || err}`);
            resetCounters();
        } finally {
            retryInFlight = false;
        }
        return;
    }

    consecutiveRetries = 0;

    if (!settings.continueEnabled) {
        updateStatus('就绪');
        return;
    }

    const { truncated, reason } = isTruncatedResponse(text, settings);
    const stalledContinue = pendingAction?.type === 'continue'
        && pendingAction.messageIndex === last.index
        && text.length <= pendingAction.baselineLength;

    if (!truncated && !stalledContinue) {
        consecutiveContinueRetries = 0;
        pendingAction = null;
        updateStatus('就绪');
        return;
    }

    if (text.length < settings.minCharsToContinue && !stalledContinue) {
        updateStatus('就绪');
        return;
    }

    if (consecutiveContinueRetries >= settings.maxContinueRetries) {
        notify(settings, `截断续写已达上限（${settings.maxContinueRetries} 次），请手动 /continue 或检查 API。`);
        updateStatus(`已停止：截断续写 ${settings.maxContinueRetries} 次`);
        consecutiveContinueRetries = 0;
        pendingAction = null;
        return;
    }

    retryInFlight = true;
    consecutiveContinueRetries += 1;
    const attempt = consecutiveContinueRetries;
    const extraMs = Math.max(0, Number(settings.continueDelayMs) || 0);
    const label = stalledContinue ? '续写无增量' : (reason || '截断');
    updateStatus(`检测到${label}，解锁后 ${settleMs + extraMs}ms 自动 /continue（${attempt}/${settings.maxContinueRetries}）…`);
    console.info(`[${MODULE_NAME}] Truncated at #${last.index} (${label}), continue ${attempt}/${settings.maxContinueRetries}`);

    pendingAction = { type: 'continue', baselineLength: text.length, messageIndex: last.index };

    try {
        await runSlash(context, '/continue await=true', settings, settleMs, extraMs);
    } catch (err) {
        console.error(`[${MODULE_NAME}] continue failed`, err);
        notify(settings, `自动续写失败：${err?.message || err}`, 'error');
        updateStatus(`错误：${err?.message || err}`);
        resetCounters();
    } finally {
        retryInFlight = false;
    }
}

function bindListeners() {
    if (listenersBound) return;
    const context = getContext();
    if (!context?.eventSource || !context?.eventTypes) return;

    installGenerationHook();

    const { eventSource, eventTypes } = context;

    eventSource.on(eventTypes.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        resetCounters();
        retryInFlight = false;
        clearLastGenerationMeta();
        updateStatus('就绪');
    });

    listenersBound = true;
}

function labeledNumber(label, id, initial, min, max, onChange, hint = '') {
    const input = el('input', { type: 'number', class: 'text_pole wide30px', id, min: String(min), max: String(max) });
    input.value = String(initial);
    input.addEventListener('change', () => {
        let v = Number(input.value);
        if (Number.isNaN(v)) v = initial;
        v = Math.min(max, Math.max(min, v));
        input.value = String(v);
        onChange(v);
    });
    const labelRow = el('label', {}, [document.createTextNode(label)]);
    if (hint) {
        labelRow.appendChild(el('span', { class: 'dummy-hint-icon fa-solid fa-circle-info', title: hint }));
    }
    return el('div', { class: 'dummy-field' }, [labelRow, input]);
}

function labeledCheck(label, checked, onChange, hint = '') {
    const children = [
        (() => {
            const c = el('input', { type: 'checkbox' });
            c.checked = checked;
            c.addEventListener('change', () => onChange(c.checked));
            return c;
        })(),
        el('span', { text: label }),
    ];
    if (hint) {
        children.push(el('span', { class: 'dummy-hint-icon fa-solid fa-circle-info', title: hint }));
    }
    return el('label', { class: 'dummy-check' }, children);
}

function sectionCard(title, iconClass, children) {
    return el('div', { class: 'dummy-card' }, [
        el('div', { class: 'dummy-card-head' }, [
            el('i', { class: `dummy-card-icon fa-solid ${iconClass}` }),
            el('span', { class: 'dummy-card-title', text: title }),
        ]),
        el('div', { class: 'dummy-card-body' }, children),
    ]);
}

function featureToggleCard(iconClass, title, subtitle, checked, onChange) {
    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = checked;
    checkbox.addEventListener('change', () => onChange(checkbox.checked));

    return el('div', { class: 'dummy-feature-card' }, [
        el('i', { class: `dummy-feature-icon fa-solid ${iconClass}` }),
        el('div', { class: 'dummy-feature-text' }, [
            el('div', { class: 'dummy-feature-title', text: title }),
            el('div', { class: 'dummy-feature-sub', text: subtitle }),
        ]),
        el('label', { class: 'dummy-switch', title: checked ? '已启用' : '已关闭' }, [checkbox, el('span', { class: 'dummy-switch-track' })]),
    ]);
}

function tabBar(tabs) {
    return el('div', { class: 'dummy-tabs', role: 'tablist' }, tabs.map(({ id, label, icon }) => {
        const btn = el('button', {
            class: `dummy-tab${id === 'overview' ? ' active' : ''}`,
            type: 'button',
            role: 'tab',
            'data-tab': id,
            'aria-selected': id === 'overview' ? 'true' : 'false',
        });
        btn.appendChild(el('i', { class: `fa-solid ${icon}` }));
        btn.appendChild(document.createTextNode(label));
        return btn;
    }));
}

function tabPanel(id, active, children) {
    return el('div', {
        class: `dummy-tab-panel${active ? ' active' : ''}`,
        role: 'tabpanel',
        'data-panel': id,
        hidden: active ? undefined : 'hidden',
    }, children);
}

function bindTabs(root) {
    const tabs = root.querySelectorAll('.dummy-tab');
    const panels = root.querySelectorAll('.dummy-tab-panel');
    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const name = tab.dataset.tab;
            tabs.forEach((t) => {
                const on = t.dataset.tab === name;
                t.classList.toggle('active', on);
                t.setAttribute('aria-selected', on ? 'true' : 'false');
            });
            panels.forEach((p) => {
                const on = p.dataset.panel === name;
                p.classList.toggle('active', on);
                if (on) p.removeAttribute('hidden');
                else p.setAttribute('hidden', 'hidden');
            });
        });
    });
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

    const save = () => saveSettingsDebounced();

    const wrap = el('div', { id: 'dummy_root', class: 'dummy-scope' });
    wrap.appendChild(
        el('div', { class: 'inline-drawer dummy-drawer' }, [
            el('div', { class: 'inline-drawer-toggle inline-drawer-header dummy-drawer-head' }, [
                el('div', { class: 'dummy-head-title' }, [
                    el('b', { text: 'Dummy' }),
                    el('span', { class: 'dummy-badge', text: `v${EXT_VERSION}` }),
                ]),
                el('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }),
            ]),
            el('div', { class: 'inline-drawer-content dummy-panel' }, [
                tabBar([
                    { id: 'overview', label: '总览', icon: 'fa-gauge-high' },
                    { id: 'regen', label: '空回', icon: 'fa-rotate-right' },
                    { id: 'continue', label: '续写', icon: 'fa-scissors' },
                    { id: 'update', label: '更新', icon: 'fa-cloud-arrow-down' },
                ]),
                tabPanel('overview', true, [
                    el('p', { class: 'dummy-lead', text: '自动处理空回复与截断回复，无需手动点重刷或续写。' }),
                    featureToggleCard(
                        'fa-rotate-right',
                        '空回自动重刷',
                        '回复过短时执行 /regenerate',
                        settings.enabled,
                        (v) => { settings.enabled = v; save(); },
                    ),
                    featureToggleCard(
                        'fa-scissors',
                        '截断自动续写',
                        '检测到截断或未收束时执行 /continue',
                        settings.continueEnabled,
                        (v) => { settings.continueEnabled = v; save(); },
                    ),
                    el('div', { class: 'dummy-status-bar' }, [
                        el('i', { class: 'fa-solid fa-circle-dot dummy-status-dot' }),
                        el('span', { class: 'dummy-status', id: 'dummy_status', text: '就绪' }),
                    ]),
                ]),
                tabPanel('regen', false, [
                    sectionCard('重试参数', 'fa-sliders', [
                        el('div', { class: 'dummy-grid' }, [
                            labeledNumber('最多重试', 'dummy_max', settings.maxRetries, 1, 10, (v) => {
                                settings.maxRetries = v;
                                save();
                            }, '空回触发后最多尝试几次 /regenerate'),
                            labeledNumber('解锁缓冲 (ms)', 'dummy_settle', settings.unlockSettleMs, 0, 5000, (v) => {
                                settings.unlockSettleMs = v;
                                save();
                            }, '等待生成解锁后再操作的毫秒数'),
                            labeledNumber('额外延迟 (ms)', 'dummy_delay', settings.delayMs, 0, 30000, (v) => {
                                settings.delayMs = v;
                                save();
                            }),
                            labeledNumber('最短有效字数', 'dummy_min', settings.minChars, 1, 500, (v) => {
                                settings.minChars = v;
                                save();
                            }, '低于此字数视为空回'),
                        ]),
                    ]),
                    sectionCard('其他', 'fa-gear', [
                        labeledCheck('达上限时弹出提示', settings.showToast, (v) => {
                            settings.showToast = v;
                            save();
                        }),
                        labeledCheck('判断前剥除 HTML', settings.stripHtml, (v) => {
                            settings.stripHtml = v;
                            save();
                        }),
                    ]),
                ]),
                tabPanel('continue', false, [
                    sectionCard('续写参数', 'fa-sliders', [
                        el('div', { class: 'dummy-grid' }, [
                            labeledNumber('最多续写', 'dummy_cmax', settings.maxContinueRetries, 1, 15, (v) => {
                                settings.maxContinueRetries = v;
                                save();
                            }),
                            labeledNumber('续写延迟 (ms)', 'dummy_cdelay', settings.continueDelayMs, 0, 30000, (v) => {
                                settings.continueDelayMs = v;
                                save();
                            }),
                            labeledNumber('最短已有字数', 'dummy_cmin', settings.minCharsToContinue, 1, 500, (v) => {
                                settings.minCharsToContinue = v;
                                save();
                            }),
                            labeledNumber('启发式最短字数', 'dummy_imin', settings.minIncompleteChars, 10, 2000, (v) => {
                                settings.minIncompleteChars = v;
                                save();
                            }, '未收束检测仅对足够长的回复生效'),
                        ]),
                    ]),
                    sectionCard('触发条件', 'fa-bolt', [
                        labeledCheck('length / max_tokens 截断', settings.continueOnLength, (v) => {
                            settings.continueOnLength = v;
                            save();
                        }, 'API finish_reason 为 length 等'),
                        labeledCheck('内容审查 / safety 截断', settings.continueOnContentFilter, (v) => {
                            settings.continueOnContentFilter = v;
                            save();
                        }),
                        labeledCheck('回复未正常收束', settings.continueOnIncomplete, (v) => {
                            settings.continueOnIncomplete = v;
                            save();
                        }, '缺少句号、引号闭合等启发式判断'),
                    ]),
                ]),
                tabPanel('update', false, [
                    el('div', { class: 'dummy-update-hero' }, [
                        el('div', { class: 'dummy-update-version' }, [
                            el('span', { class: 'dummy-update-label', text: '当前版本' }),
                            el('span', { class: 'dummy-badge dummy-badge-lg', text: `v${EXT_VERSION}` }),
                        ]),
                        (() => {
                            const btn = el('button', {
                                class: 'menu_button dummy-update-btn',
                                type: 'button',
                                id: 'dummy_check_update',
                            });
                            btn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> 检查更新';
                            return btn;
                        })(),
                    ]),
                    el('div', { class: 'dummy-update-status', id: 'dummy_update_status', text: '尚未检查更新' }),
                    sectionCard('自动更新', 'fa-clock', [
                        labeledCheck('后台定期检查', settings.updateCheckEnabled, (v) => {
                            settings.updateCheckEnabled = v;
                            save();
                            restartBackgroundUpdateChecker(context, settings, save, updateUpdateStatus);
                        }),
                        el('div', { class: 'dummy-grid dummy-grid-single' }, [
                            labeledNumber('检查间隔 (分钟)', 'dummy_update_iv', settings.updateCheckIntervalMinutes, 15, 10080, (v) => {
                                settings.updateCheckIntervalMinutes = v;
                                save();
                                restartBackgroundUpdateChecker(context, settings, save, updateUpdateStatus);
                            }),
                        ]),
                        labeledCheck('发现更新后自动安装', settings.updateAutoInstall, (v) => {
                            settings.updateAutoInstall = v;
                            save();
                        }),
                        labeledCheck('安装后自动刷新页面', settings.updateAutoReload, (v) => {
                            settings.updateAutoReload = v;
                            save();
                        }),
                    ]),
                ]),
            ]),
        ]),
    );

    const shell = el('div', { id: 'dummy_extension_container', class: 'extension_container' });
    shell.appendChild(wrap);
    root.appendChild(shell);

    $(wrap).find('.inline-drawer-toggle').on('click', function () {
        $(this).closest('.inline-drawer').toggleClass('open');
    });

    bindTabs(wrap);

    const updateBtn = wrap.querySelector('#dummy_check_update');
    updateBtn?.addEventListener('click', async () => {
        updateBtn.disabled = true;
        try {
            await checkAndUpdateExtension(context, settings, save, updateUpdateStatus, { manual: true });
        } finally {
            updateBtn.disabled = false;
        }
    });

    restartBackgroundUpdateChecker(context, settings, save, updateUpdateStatus);
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

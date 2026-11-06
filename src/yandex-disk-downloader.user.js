// ==UserScript==
// @name         YaDLer — Пакетная загрузка с Яндекс Диска
// @namespace    https://disk.yandex.ru/
// @version      3
// @description  Скачать папку с Яндекс Диска целиком без ZIP-архива. Пакетная загрузка личных и публичных дисков с сохранением структуры папок, проверкой целостности SHA-256 и докачкой обрывов. Работает без авторизации OAuth. Бесплатно и приватно.
// @author       albertomazzoni
// @license      MIT
// @homepageURL  https://github.com/albertomazzoni/YaDLer
// @match        https://disk.yandex.ru/d/*
// @match        https://disk.yandex.ru/i/*
// @match        https://disk.yandex.com/d/*
// @match        https://disk.yandex.by/d/*
// @match        https://disk.yandex.kz/d/*
// @match        https://yadi.sk/d/*
// @match        https://yadi.sk/i/*
// @match        https://disk.yandex.ru/client/*
// @match        https://disk.yandex.com/client/*
// @match        https://disk.yandex.by/client/*
// @match        https://disk.yandex.kz/client/*
// @match        https://oauth.yandex.ru/verification_code*
// @match        https://oauth.yandex.com/verification_code*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @connect      cloud-api.yandex.net
// @connect      yandex.net
// @connect      yandex.ru
// @connect      yandex.com
// @connect      albertomazzoni.github.io
// @connect      downloader.disk.yandex.ru
// @updateURL    https://albertomazzoni.github.io/YaDLer/yandex-disk-downloader.user.js
// @downloadURL  https://albertomazzoni.github.io/YaDLer/yandex-disk-downloader.user.js
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    if (typeof GM_xmlhttpRequest === 'undefined' || typeof GM_setValue === 'undefined') {
                console.error("[YaDLer Security] Unauthorized execution detected. This script requires Tampermonkey/Violentmonkey.");
        return;
    }

    const validOrigins = [
        'https://disk.yandex.ru',
        'https://disk.yandex.com',
        'https://disk.yandex.by',
        'https://disk.yandex.kz',
        'https://yadi.sk',
        'https://oauth.yandex.ru',
        'https://oauth.yandex.com'
    ];
    const currentOrigin = window.location.origin;
    const isLocalDev = currentOrigin.includes('localhost') || currentOrigin.includes('127.0.0.1');

    if (!isLocalDev && !validOrigins.includes(currentOrigin)) {
        console.warn("[YaDLer Security] Running on unauthorized domain:", currentOrigin);
        return;
    }

    /* ================= КОНФИГ АВТОРА ================= */
    const CONFIG_URL = 'https://albertomazzoni.github.io/YaDLer/promo.json';
    let PROMO = null;
    function loadPromoConfig() {
        return new Promise((resolve) => {
            try {
                GM_xmlhttpRequest({
                    method: 'GET', url: CONFIG_URL + '?v=' + Date.now(), timeout: 8000,
                    onload: (r) => {
                        try {
                            const c = JSON.parse(r.responseText);
                            PROMO = { enabled: c.enabled !== false, album: typeof c.album === 'string' ? c.album : '', listen: Array.isArray(c.listen) ? c.listen : [], donate: Array.isArray(c.donate) ? c.donate : null, social: Array.isArray(c.social) ? c.social : [] };
                            if (!PROMO.listen.length && !PROMO.social.length && !PROMO.donate) PROMO = null;
                        } catch { PROMO = null; }
                        resolve();
                    },
                    onerror: () => { PROMO = null; resolve(); }, ontimeout: () => { PROMO = null; resolve(); }, onabort: () => { PROMO = null; resolve(); },
                });
            } catch { PROMO = null; resolve(); }
        });
    }
    const PROMO_READY = loadPromoConfig();
    const OAUTH_CLIENT_ID = ''; // Впиши Client ID для OAuth, если нужно
    const SCRIPT_VERSION = '3';
    const UPDATE_URL = 'https://albertomazzoni.github.io/YaDLer/yandex-disk-downloader.user.js'; // Ссылка на свежий файл для обновления
    const UPSTREAM_URL = UPDATE_URL;
    const TOKEN_RE = /^[\w.\-]{20,300}$/;

    if (/^oauth\.yandex\./.test(location.hostname)) { captureTokenPage(); return; }

    /* ================= УТИЛИТЫ ОБНОВЛЕНИЯ ================= */
    function verNewer(remote, current) {
        const a = String(remote).split('.').map(Number), b = String(current).split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            if ((a[i] || 0) > (b[i] || 0)) return true;
            if ((a[i] || 0) < (b[i] || 0)) return false;
        }
        return false;
    }

    function fetchRemoteVersion(url) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET', url: (url || UPDATE_URL) + '?v=' + Date.now(), timeout: 8000,
                onload: (r) => {
                    const m = /@version\s+([0-9.]+)/.exec(r.responseText || '');
                    resolve(m ? m[1] : null);
                },
                onerror: () => resolve(null), ontimeout: () => resolve(null), onabort: () => resolve(null)
            });
        });
    }

    let reloadArmed = false;
    function armReloadOnReturn() {
        if (reloadArmed) return;
        reloadArmed = true;
        const t0 = Date.now();
        const onVis = () => {
            if (document.visibilityState === 'visible' && Date.now() - t0 > 3500) {
                document.removeEventListener('visibilitychange', onVis);
                reloadArmed = false;
                log('Обновление установлено — перезагружаю страницу…', 'ok');
                location.reload();
            }
        };
        document.addEventListener('visibilitychange', onVis);
    }

    async function checkUpdate(manual, preopened) {
        if (!UPDATE_URL) {
            if (preopened) { try { preopened.close(); } catch { } }
            if (!manual) return;
            log('Ссылка на обновление не настроена.', 'err');
            return;
        }

        const rv = await fetchRemoteVersion();
        const closeBlank = () => { if (preopened) { try { preopened.close(); } catch { } } };

        if (!rv) {
            closeBlank();
            if (manual) log('Не удалось проверить обновления: сервер не ответил.', 'warn');
            return;
        }

        if (!verNewer(rv, SCRIPT_VERSION)) {
            S.newVer = '';
            closeBlank();
            if (ui.upd) { ui.upd.classList.remove('upd'); ui.upd.title = 'Проверить обновления'; }
            if (manual) log('У вас последняя версия (v' + SCRIPT_VERSION + ').', 'ok');
            return;
        }

        // Есть новая версия
        S.newVer = rv; syncUI();
        if (ui.upd) {
            ui.upd.classList.add('upd');
            ui.upd.title = `Доступно обновление v${rv} · нажмите, чтобы установить`;
        }

        if (!manual) {
            closeBlank();
            log(`Доступно обновление v${rv}. Нажмите ↻ в шапке.`, 'warn');
            return;
        }

        const dest = UPDATE_URL + '?v=' + Date.now();
        let ok = false;
        if (preopened) {
            try { preopened.location.replace(dest); ok = true; } catch { ok = false; }
        }
        if (!ok) {
            try { const w2 = window.open(dest, '_blank', 'noopener'); ok = !!w2; } catch { ok = false; }
        }

        if (!ok) {
            log('Браузер заблокировал новую вкладку. Разрешите попапы или обновите через меню Tampermonkey.', 'warn');
            return;
        }

        log(`Открыл страницу установки v${rv}. Нажмите «Обновить», затем вернитесь сюда — страница перезагрузится сама.`);
        armReloadOnReturn();
    }

    /* ================= РЕЖИМЫ И КОНСТАНТЫ ================= */
    const MODES = {
        fast: { conc: 5, auto: false, name: 'Быстрый', desc: '5 потоков · от лёгких к тяжёлым · максимальная скорость' },
        balance: { conc: 3, auto: false, name: 'Баланс', desc: '3 потока · по порядку папок · ровно и предсказуемо' },
        safe: { conc: 3, auto: true, name: 'Бережный', desc: '1–3 потока авто · от тяжёлых к лёгким · бережно к лимитам' },
    };
    const MODE_ICON = { fast: '⚡', balance: '⚖', safe: '🐢' };

    const CFG = {
        MAX_ATTEMPTS: 3, DELAY_MIN: 100, DELAY_MAX: 400, REQ_TIMEOUT: 20000,
        FOLDER_MAX: 1.5 * 1024 ** 3, HASH_MAX: 256 * 1024 ** 2,
        SLOW_WINDOW: 10000, SLOW_MAX: 3, SLOW_NEAR_END_S: 5,
        AUTO_PASSES: 2, AUTO_DELAY_S: 60, RAISE_AFTER_MS: 60000, THROTTLE_GAP_MS: 10000,
        DIAG_CONC: 2, SAFE_RAISE_MS: 30000, PROBE_TIMEOUT: 8000,
        RETRY_UNAVAIL_DELAY_MS: 60 * 60 * 1000, // Таймер для недоступных (1 час)
    };

    const API = 'https://cloud-api.yandex.net/v1/disk/public/resources';
    const PRIV = 'https://cloud-api.yandex.net/v1/disk/resources';

    const ST = (() => {
        let v = {};
        try { v = JSON.parse(GM_getValue('settings3', '{}')) || {}; } catch { }
        const pick = (val, list, def) => (list.includes(val) ? val : def);
        return {
            subfolders: v.subfolders !== false, skipExisting: v.skipExisting !== false,
            conc: pick(v.conc, [1, 2, 3, 4, 5, 6], 5), auto: v.auto === true,
            stall: pick(v.stall, [20, 30, 60], 30), minSpeed: pick(v.minSpeed, [0, 100, 300, 1000], 100),
            autoRetry: v.autoRetry !== false, verify: v.verify !== false, fixPartial: v.fixPartial !== false,
            report: v.report !== false, autoScan: v.autoScan !== false, autoDiag: v.autoDiag !== false, rememberDir: v.rememberDir !== false,
            mode: pick(v.mode, ['fast', 'balance', 'safe', 'custom'], 'fast'),
            theme: pick(v.theme, ['auto', 'light', 'dark'], 'auto'),
            view: pick(v.view, ['simple', 'detail'], 'simple'),
            types: Object.assign({ images: true, video: true, audio: true, docs: true, archives: true, other: true }, v.types || {}),
            sound: v.sound !== false, fontSize: pick(v.fontSize, ['a', 'aa', 'aaa'], 'aa'),
            notify: v.notify !== false, // Новая настройка: уведомления браузера
        };
    })();

    const saveSettings = () => { try { GM_setValue('settings3', JSON.stringify(ST)); } catch { } };

    const S = {
        items: [], groups: [], treeOrder: [], mode: 'tree',
        key: '', link: '', busy: null, stop: false, dir: null, dirName: '', sk2: '',
        handles: new Set(), noStream: false,
        samples: [], runStart: 0, runMs: 0, tickId: 0,
        effConc: 3, cap: 3, lastRateLimit: 0, lastDown: 0, lastRaise: 0, lastProblem: 0, note: '',
        token: '', user: '', pm: 'public', pendingScan: false, logBuf: [], avgSpeed: 0,
        job: null, jobT0: 0, scanT0: 0, scanMs: 0, scanStats: null, screen: null,
        pause: false, scanDone: false, rootName: '',
        sess: { sk: '', cid: '' }, tpl: {}, calls: [], urlTpl: null, discP: null, urlFailUntil: 0, tplFail: 0,
        live: [], // Для прогресса скана
    };

    let hashQueue = Promise.resolve();
    S.namesMissing = [];
    const modeSafe = () => ST.mode === 'safe';

    /* ================= ЛИЧНЫЙ ДИСК: ПЕРЕХВАТ СЕССИИ ================= */
    function maskSecret(s) {
        return String(s || '')
            .replace(/("sk"\s*:\s*")[^"]+(")/g, '$1***$2')
            .replace(/("connection_id"\s*:\s*")[^"]+(")/g, '$1***$2')
            .replace(/(sk=)[^&\s"']+/g, '$1***')
            .replace(/(\/disk\/)[0-9a-f]{20,}(\/[0-9a-f]{4,}\/)[^?&\s"']+/gi, '$1***$2***')
            .replace(/https?:\/\/downloader\.disk\.yandex\.ru\/disk\/[^\s"']+/gi, 'https://downloader.disk.yandex.ru/disk/***');
    }

    function setPrivateSess(sk, cid, api, params) {
        if (!sk || !cid) return;
        if (S.sess.sk !== sk || S.sess.cid !== cid) {
            S.sess = { sk, cid };
            log('Личный диск: сессия страницы перехвачена.', 'ok');
        }
        if (api) {
            S.tpl[api] = Object.assign({}, S.tpl[api] || {}, params || {});
            const w = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
            try {
                w.__yadlerSess = { sk, cid };
                w.__yadlerTpl = S.tpl;
            } catch { }
        }
    }

    function isOwnHeaders() { return !!S.inOwn; }

    function captureModelsBody(str, own) {
        try {
            const b = JSON.parse(str);
            if (b && b.sk && b.connection_id) {
                setPrivateSess(b.sk, b.connection_id, own ? null : b.apiMethod, own ? null : b.requestParams);
                if (!own && b.apiMethod) {
                    S.calls.push({ api: b.apiMethod, params: JSON.parse(JSON.stringify(b.requestParams || {})), t: Date.now(), tried: false });
                    if (S.calls.length > 80) S.calls.shift();
                }
            }
        } catch { }
    }

    function installPrivateHook() {
        try {
            const w = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
            if (w.__yadlerPrivateHook) return;
            w.__yadlerPrivateHook = true;

            try {
                const XP = w.XMLHttpRequest && w.XMLHttpRequest.prototype;
                if (XP && !XP.__yadlerHooked) {
                    XP.__yadlerHooked = true;
                    const oOpen = XP.open, oSend = XP.send;
                    XP.open = function (m, u) { try { this.__yl = { m: String(m).toUpperCase(), u: String(u) }; } catch { } return oOpen.apply(this, arguments); };
                    XP.send = function (body) {
                        try { const i = this.__yl; if (i && i.m === 'POST' && /models-v2/.test(i.u) && typeof body === 'string') captureModelsBody(body, false); } catch { }
                        return oSend.apply(this, arguments);
                    };
                }
            } catch { }

            const origFetch = w.fetch;
            if (typeof origFetch !== 'function') return;
            w.fetch = async function (...args) {
                try {
                    const input = args[0];
                    const init = args[1] || {};
                    const url = typeof input === 'string' ? input : (input && input.url) || '';
                    const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
                    if (method === 'POST' && /models-v2/.test(url) && typeof init.body === 'string') {
                        captureModelsBody(init.body, isOwnHeaders(init.headers));
                    }
                } catch { }
                return origFetch.apply(this, args);
            };
        } catch { }
    }
    installPrivateHook();

    function isSkValue(v) { return typeof v === 'string' && /^[0-9a-f]{20,64}:\d+$/.test(v); }
    function isCidValue(v) { return typeof v === 'string' && /^\d{12,32}$/.test(v); }

    function findPrivateSessInFiber() {
        try {
            const el = document.body;
            const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
            if (!key) return null;
            const seen = new Set();
            const stack = [[el[key], 0]];
            let sk = '', cid = '';
            const scanObj = (o, d) => {
                if (!o || typeof o !== 'object' || d > 4 || seen.size > 30000) return;
                if (seen.has(o)) return;
                seen.add(o);
                for (const k of Object.keys(o)) {
                    const v = o[k];
                    if (!sk && isSkValue(v)) sk = v;
                    if (!cid && isCidValue(v)) cid = v;
                    if (v && typeof v === 'object' && d < 3) scanObj(v, d + 1);
                }
            };
            while (stack.length && (!sk || !cid)) {
                const [f, d] = stack.pop();
                if (!f || d > 60) continue;
                scanObj(f.memoizedProps, 0);
                scanObj(f.memoizedState, 0);
                if (f.child) stack.push([f.child, d + 1]);
                if (f.sibling) stack.push([f.sibling, d + 1]);
            }
            return sk && cid ? { sk, cid } : null;
        } catch { return null; }
    }

    async function getPrivateSess(timeoutMs) {
        if (S.sess.sk && S.sess.cid) return S.sess;
        const w = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
        try {
            const x = w.__yadlerSess;
            if (x && x.sk && x.cid) { S.sess = { sk: x.sk, cid: x.cid }; return S.sess; }
            if (w.__yadlerTpl) S.tpl = Object.assign(S.tpl, w.__yadlerTpl);
        } catch { }
        const fib = findPrivateSessInFiber();
        if (fib) { S.sess = fib; return S.sess; }
        const t0 = Date.now();
        while (Date.now() - t0 < (timeoutMs || 8000) && !S.stop) {
            try {
                const x = w.__yadlerSess;
                if (x && x.sk && x.cid) { S.sess = { sk: x.sk, cid: x.cid }; return S.sess; }
            } catch { }
            if (S.sess.sk && S.sess.cid) return S.sess;
            await sleep(300);
        }
        return S.sess;
    }

    function pageFetchJson(url, opts) {
        const w = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
        const f = w.fetch || fetch;
        if (typeof f !== 'function') return Promise.reject(new Error('fetch недоступен'));
        S.inOwn = true;
        let pr;
        try { pr = f.call(w, url, opts); } finally { S.inOwn = false; }
        return pr.then(async (r) => {
            const text = await r.text();
            if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status + ' ' + maskSecret(text.slice(0, 120))), { status: r.status });
            try { return JSON.parse(text); } catch { throw new Error('не JSON: ' + maskSecret(text.slice(0, 120))); }
        });
    }

    async function privateApi(api, params) {
        const sess = await getPrivateSess(8000);
        if (!sess.sk || !sess.cid) throw new Error('нет сессии страницы (sk/connection_id)');
        const body = JSON.stringify({ sk: sess.sk, connection_id: sess.cid, apiMethod: api, requestParams: params || {} });
        return pageFetchJson('/models-v2?m=' + encodeURIComponent(api), {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-Retpath-Y': location.href },
            body
        });
    }

    function deepList(o, d) {
        d = d || 0;
        if (!o || typeof o !== 'object' || d > 5) return null;
        if (Array.isArray(o)) {
            if (o.length && o[0] && typeof o[0] === 'object' && o[0].name && ('type' in o[0] || 'path' in o[0] || 'id' in o[0] || 'meta' in o[0] || 'size' in o[0])) return o;
            return null;
        }
        for (const k of Object.keys(o)) { const r = deepList(o[k], d + 1); if (r) return r; }
        return null;
    }

    function listShape(r) {
        const dl = deepList(r);
        if (dl) {
            let total = dl.length, explicit = false;
            for (const t of [r && r.total, r && r.count, r && r.resources && r.resources.total, r && r._embedded && r._embedded.total, r && r.data && r.data.total, r && r.result && r.result.total]) {
                if (typeof t === 'number' && t >= 0) { total = t; explicit = true; break; }
            }
            return { items: dl, total, explicit };
        }
        const arrs = [r && r.resources && r.resources.items, r && r._embedded && r._embedded.items, r && r.list, r && r.entries, r && r.items, r && r.data && r.data.items, r && r.result && r.result.items];
        for (const a of arrs) {
            if (Array.isArray(a)) {
                const totalCandidates = [r && r.resources && r.resources.total, r && r._embedded && r._embedded.total, r && r.total, r && r.count, r && r.properties && (r.properties.count || r.properties.total)];
                let total = a.length, explicit = false;
                for (const t of totalCandidates) { if (typeof t === 'number' && t >= 0) { total = t; explicit = true; break; } }
                return { items: a, total, explicit };
            }
        }
        return null;
    }

    function uniq(arr) { return [...new Set(arr.filter(Boolean))]; }

    function pathForms(p) {
        const s = String(p || '');
        let rel = /^disk:/i.test(s) ? s.replace(/^disk:\/*/i, '') : s.replace(/^\/*disk(\/+|$)/i, '');
        rel = rel.replace(/^\/+/, '');
        return { slash: rel ? '/disk/' + rel : '/disk', colon: 'disk:/' + rel, rel };
    }

    function detectPathParam(params) {
        for (const k of Object.keys(params || {})) {
            const v = params[k];
            const one = Array.isArray(v) ? v[0] : v;
            if (typeof one !== 'string') continue;
            if (/^\/disk(\/|$)/.test(one)) return { key: k, form: 'slash', arr: Array.isArray(v) };
            if (/^disk:\//i.test(one)) return { key: k, form: 'colon', arr: Array.isArray(v) };
        }
        return null;
    }

    function belongsTo(items, f) {
        const N = (s) => String(s).normalize('NFC');
        const pre1 = N(f.slash).replace(/\/+$/, '') + '/', pre2 = N(f.colon).replace(/\/+$/, '') + '/';
        const paths = items.map((e) => e.path || e.id).filter((x) => typeof x === 'string' && /^(\/disk|disk:)/i.test(x)).map(N);
        if (!paths.length) return true;
        const isSelf = (x) => { const t = x.replace(/\/+$/, ''); return t === N(f.slash) || t === N(f.colon).replace(/\/+$/, ''); };
        return paths.some((x) => x.startsWith(pre1) || x.startsWith(pre2)) || paths.every(isSelf);
    }

    async function tryPrivateList(path, offset) {
        const diag = [];
        const cands = [];
        const f = pathForms(path);
        const seenSig = new Set();
        const add = (api, params, tag) => {
            const sig = api + '|' + JSON.stringify(Object.keys(params).sort());
            if (seenSig.has(sig)) return; seenSig.add(sig);
            cands.push({ api, params, tag });
        };

        if (S.listWin) {
            const w = S.listWin, v = w.form === 'colon' ? f.colon : f.slash;
            const params = JSON.parse(JSON.stringify(w.params));
            params[w.key] = w.arr ? [v] : v;
            if ('limit' in params) params.limit = 100;
            if ('amount' in params) params.amount = 100;
            if ('offset' in params) params.offset = offset;
            cands.push({ api: w.api, params, tag: 'кэш' });
        }

        for (const c of S.calls.slice().reverse()) {
            if (/url|download|log|stat|notif|counter|setting|config|user|space|search/i.test(c.api)) continue;
            const pp = detectPathParam(c.params);
            const hasPaging = ['limit', 'offset', 'amount', 'page'].some((k) => k in c.params);
            if (!pp && !hasPaging) continue;
            // ВАЖНО: пропускаем запросы страницы, которые относятся к ДРУГОМУ пути.
            // Иначе tryPrivateList возьмёт шаблон от соседней папки и вернёт
            // список «не тех» файлов (это и было причиной бага).
            if (pp) {
                const origPath = Array.isArray(c.params[pp.key]) ? c.params[pp.key][0] : c.params[pp.key];
                if (typeof origPath === 'string' && origPath !== f.slash && origPath !== f.colon) {
                    continue; // чужой путь — этот шаблон нам не подходит
                }
            }
            const params = JSON.parse(JSON.stringify(c.params));
            if (pp) params[pp.key] = pp.arr ? [pp.form === 'colon' ? f.colon : f.slash] : (pp.form === 'colon' ? f.colon : f.slash);
            if ('limit' in params) params.limit = 100;
            if ('amount' in params) params.amount = 100;
            if ('offset' in params) params.offset = offset;
            add(c.api, params, 'страница');
        }

        const known = uniq(Object.keys(S.tpl).filter((k) => /list|folder|children|resources|browse/i.test(k)));
        for (const api of uniq([...known, 'resources', 'mpfs/list', 'mpfs/folder-list', 'mpfs/children', 'mpfs/resources', 'mpfs/browse', 'list'])) {
            const base = JSON.parse(JSON.stringify(S.tpl[api] || {}));
            const oldPp = detectPathParam(base);
            if (oldPp) delete base[oldPp.key];
            for (const key of ['path', 'id', 'folder', 'dir']) {
                for (const val of (key === 'id' || key === 'path') ? [f.slash, f.colon] : [f.slash]) {
                    add(api, Object.assign({}, base, { [key]: val, limit: 100, offset }), 'догадка');
                }
            }
        }

        for (const c of cands) {
            if (S.stop) throw stopErr();
            try {
                const r = await privateApi(c.api, c.params);
                const shape = listShape(r);
                if (shape && c.tag === 'догадка' && !belongsTo(shape.items, f)) { diag.push(c.api + ':чужая папка'); continue; }
                if (shape && (shape.items.length > 0 || (shape.explicit && shape.total === 0))) {
                    const pw = detectPathParam(c.params);
                    if (pw) S.listWin = { api: c.api, params: c.params, key: pw.key, form: pw.form, arr: pw.arr };
                    if (!S.listOk) { S.listOk = c.api; log('Личный диск: список получен запросом «' + c.api + '».', 'ok'); }
                    return shape;
                }
                diag.push(c.api + ':' + (shape ? 'пусто' : 'нет списка'));
            } catch (e) {
                if (e.stopped) throw e;
                diag.push(c.api + ':' + (e.status || 'ошибка'));
            }
        }
        const names = uniq(S.calls.map((c) => c.api)).slice(0, 15).join(', ') || 'нет';
        const msg = 'перепробовано ' + cands.length + ' вариантов [' + diag.slice(0, 12).join('; ') + ']. Запросы, замеченные у страницы: ' + names + (S.calls.length ? '' : ' — обновите страницу (F5), подождите загрузки папки и повторите');
        throw Object.assign(new Error(msg), { diag: true });
    }

    function fiberFileItems() {
        const out = [];
        try {
            const el = document.body;
            const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
            if (!key) return out;
            const seen = new Set();
            const stack = [[el[key], 0]];
            const scanObj = (o, d) => {
                if (!o || typeof o !== 'object' || d > 4 || seen.size > 30000) return;
                if (seen.has(o)) return;
                seen.add(o);
                for (const k of Object.keys(o)) {
                    const v = o[k];
                    if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && 'name' in v[0] && ('type' in v[0] || 'meta' in v[0] || 'size' in v[0])) {
                        for (const e of v) { if (e && typeof e === 'object' && e.name) out.push(e); }
                    } else if (v && typeof v === 'object' && d < 3) { scanObj(v, d + 1); }
                }
            };
            while (stack.length) {
                const [f, d] = stack.pop();
                if (!f || d > 60) continue;
                scanObj(f.memoizedProps, 0);
                scanObj(f.memoizedState, 0);
                if (f.child) stack.push([f.child, d + 1]);
                if (f.sibling) stack.push([f.sibling, d + 1]);
            }
        } catch { }
        const byPath = new Map();
        for (const e of out) { const p = e.path || e.id || ''; if (p && !byPath.has(p)) byPath.set(p, e); }
        return [...byPath.values()];
    }

    function itemFromPrivate(e) {
        const p = e.path || e.id || '';
        const rel = p.replace(/^\/disk\//, '').replace(/^disk:\//, '');
        const name = rel || e.name || '';
        const size = e.meta && e.meta.size != null ? Number(e.meta.size) : (e.size != null ? Number(e.size) : null);
        const sha = e.sha256 || (e.meta && e.meta.sha256) || '';
        return newItem(name, name, size, p, sha, 'psession', p);
    }

    async function walkPrivateSession(path, cleanParts, origParts, out, visited) {
        visited = visited || new Set();
        if (S.job) S.job.cur = path;
        if (visited.has(path)) return;
        visited.add(path);
        let offset = 0;
        for (; ;) {
            await pauseGate();
            const { items, total } = await tryPrivateList(path, offset);
            for (const e of items) {
                const name = e.name || '';
                if (!name) continue;
                const type = String(e.type || e.file_type || '').toLowerCase();
                const childPath = e.path || e.id || (path.replace(/\/+$/, '') + '/' + name);
                if (type === 'dir' || type === 'directory') {
                    if (S.job) S.job.dirs++;
                    await walkPrivateSession(childPath, [...cleanParts, cleanSeg(name)], [...origParts, name], out, visited);
                } else {
                    out.push(itemFromPrivate(Object.assign({}, e, { path: childPath })));
                }
            }
            offset += items.length;
            if (S.job) S.job.done = out.length;
            if (!items.length || offset >= total) break;
        }
    }

    function collectFiberCurrent() {
        const items = fiberFileItems();
        const out = [];
        for (const e of items) {
            const type = String(e.type || '').toLowerCase();
            if (type === 'dir' || type === 'directory') continue;
            const it = itemFromPrivate(e);
            if (it.orig) out.push(it);
        }
        return out;
    }

    /* ================= ЧАСЫ НА WEB WORKER ================= */
    let CLOCK = null;
    (function initClock() {
        try {
            const w = new Worker(URL.createObjectURL(new Blob(['setInterval(function(){postMessage(1)},200);'], { type: 'application/javascript' })));
            const q = [];
            w.onmessage = () => { const r = q.shift(); if (r) r(); };
            CLOCK = () => new Promise((r) => q.push(r));
        } catch { CLOCK = null; }
    })();
    const tickWait = () => (CLOCK ? CLOCK() : new Promise((r) => setTimeout(r, 200)));

    /* ================= УТИЛИТЫ ================= */
    const stopErr = () => Object.assign(new Error('остановлено'), { stopped: true });
    const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
    async function sleep(ms) { const end = Date.now() + ms; while (Date.now() < end && !S.stop) await tickWait(); }
    async function pauseGate() {
        while (S.pause && !S.stop) await sleep(250);
        if (S.stop) throw stopErr();
    }

    function togglePause() {
        if (!S.busy) return;
        S.pause = !S.pause;
        if (S.pause) log('Пауза. Нажмите «Продолжить», чтобы вернуть в работу.', 'warn');
        else log('Продолжаю…', 'ok');
        syncUI();
    }
    function fmtSize(n) { if (n == null) return '?'; const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(1) : Math.round(n)) + ' ' + u[i]; }
    function fmtClock(ms) { const s = Math.floor(ms / 1000), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60; const p = (n) => String(n).padStart(2, '0'); return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`; }
    function fmtTime(ms) { const s = Math.floor(ms / 1000), m = Math.floor(s / 60); return m ? `${m} мин ${s % 60} с` : `${s} с`; }
    function cleanSeg(s) {
        s = String(s).normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').replace(/^\.+/, '_');
        if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
        if (s.length > 120) { const m = s.match(/(\.[^.]{1,10})$/); const ext = m ? m[1] : ''; s = s.slice(0, 120 - ext.length) + ext; }
        return s || '_';
    }
    const baseName = (p) => p.split('/').pop();
    const dirName = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
    const extOf = (n) => { const m = baseName(n).match(/\.([^.]+)$/); return m ? m[1].toLowerCase() : ''; };
    const withSuffix = (name, n) => { const m = name.match(/^(.*?)(\.[^.]{1,10})?$/); return `${m[1]} (${n})${m[2] || ''}`; };
    function parseHere() { const m = location.pathname.match(/^\/(d|i)\/([^/]+)(\/.*)?$/); if (!m) return null; let sub = ''; try { if (m[3]) sub = decodeURIComponent(m[3]).replace(/\/+$/, ''); } catch { return null; } return { key: `${location.origin}/${m[1]}/${m[2]}`, sub }; }
    function normalizeDiskPath(s) { const p = String(s || '').trim().replace(/^disk:/i, '').replace(/\\/g, '/'); return 'disk:/' + p.split('/').filter(Boolean).join('/'); }
    function privatePathFromUrl() { const m = location.pathname.match(/^\/client\/disk(\/.*)?$/); if (!m) return null; try { return normalizeDiskPath((m[1] || '').split('/').filter(Boolean).map(decodeURIComponent).join('/')); } catch { return null; } }
    function detectSource() {
        const pub = parseHere();
        if (pub) return { kind: 'public', key: pub.key, sub: pub.sub };
        const typed = ui.pathInput ? ui.pathInput.value.trim() : '';
        const path = typed ? normalizeDiskPath(typed) : privatePathFromUrl();
        return path ? { kind: 'private', path } : null;
    }
    function isYandexHttps(href) { try { const u = new URL(href); return u.protocol === 'https:' && /(^|\.)yandex\.(ru|net|com|by|kz|uz|com\.tr)$/.test(u.hostname); } catch { return false; } }
    const isRateLimit = (e) => e && (e.status === 429 || /429|слишком много/i.test(e.message || ''));

    /* ================= КЛАССИФИКАЦИЯ ОШИБОК ================= */
    const CLS_TEXT = {
        limit: 'лимит Яндекса / нет доступа к файлу', gone: 'файл недоступен на сервере (удалён или повреждён)',
        corrupt: 'скачан с повреждением', net: 'ошибка сети', slow: 'слишком медленно', stop: 'остановлено', other: 'прочая ошибка',
    };
    function classify(e) {
        if (!e) return 'other';
        if (e.stopped) return 'stop';
        if (e.slow) return 'slow';
        if (e.sha) return 'corrupt';
        if (e.status === 404) return 'gone';
        if (e.status === 403 || e.status === 429) return 'limit';
        if (/размер не совпал|получено .* вместо|контрольная сумма/i.test(e.message || '')) return 'corrupt';
        if (e.stalled || /сетевая|таймаут/i.test(e.message || '')) return 'net';
        return 'other';
    }

    /* ================= ТИПЫ ФАЙЛОВ ================= */
    const TYPES = {
        images: 'jpg jpeg png gif webp bmp tif tiff heic svg raw cr2 nef arw',
        video: 'mp4 mkv avi mov wmv flv webm m4v mpg mpeg 3gp',
        audio: 'mp3 wav flac aac ogg m4a wma',
        docs: 'pdf doc docx xls xlsx ppt pptx txt rtf odt ods odp csv md epub fb2 djvu',
        archives: 'zip rar 7z tar gz bz2 xz iso',
    };
    const TYPE_SETS = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, new Set(v.split(' '))]));
    const TYPE_RU = { images: 'Фото', video: 'Видео', audio: 'Аудио', docs: 'Документы', archives: 'Архивы', other: 'Другие' };
    function groupOf(ext) { for (const k of ['images', 'video', 'audio', 'docs', 'archives']) if (TYPE_SETS[k].has(ext)) return k; return 'other'; }

    /* ================= ИНДИКАТОР ФОНОВЫХ ПРОЦЕССОВ ================= */
    function startJob(label, total) { S.job = { label, done: 0, dirs: 0, total }; S.jobT0 = Date.now(); }
    function jobTick() {
        if (!S.busy || S.busy === 'run' || !S.job) return;
        const j = S.job, elapsed = Date.now() - S.jobT0;
        if (ui.guide) {
            let txt;
            if (j.total) {
                const pct = j.done >= j.total ? 100 : Math.min(99, Math.round((j.done / j.total) * 100));
                txt = `${j.label}: ${j.done}/${j.total} (${pct}%) · ${fmtClock(elapsed)}`;
            } else {
                // Эвристика прогресса скана: папки считаются как "работа", файлы как "результат"
                // Примерный прогресс = (найденные файлы + обнаруженные папки * 5) / ожидаемое общее
                // Так как общего нет, показываем просто счетчики
                txt = `${j.label}: найдено файлов ${j.done}, папок ${j.dirs} · ${fmtClock(elapsed)}`;
            }
            ui.guide.textContent = txt;
            ui.guide.className = 'guide';
        }
        renderScanScreen();
    }
    function liveItems() { return (S.busy === 'scan' && !S.items.length && S.live) ? S.live : S.items; }
    function computeScanStats() {
        const isLive = (S.busy === 'scan' && !S.items.length && S.live);
        const LI = liveItems();
        const st = { dirs: 0, files: LI.length, bytes: 0, types: { images: 0, video: 0, audio: 0, docs: 0, archives: 0, other: 0 }, noaccess: 0, errs: 0, ms: S.scanMs };
        const dirs = new Set();
        for (const it of LI) {
            st.bytes += it.size || 0;
            st.types[groupOf(extOf(it.orig))]++;
            if (it.dir) dirs.add(it.dir);
            if (it.diag === 'noaccess') st.noaccess++;
            else if (it.diag === 'err') st.errs++;
        }
        st.dirs = isLive ? Math.max(dirs.size, (S.job && S.job.dirs) || 0) : dirs.size;
        return st;
    }

    /* ================= ПАМЯТЬ ПАПКИ (IndexedDB) ================= */
    function idbOpen() { return new Promise((res, rej) => { const rq = indexedDB.open('yadler', 1); rq.onupgradeneeded = () => { rq.result.createObjectStore('kv'); }; rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); }
    async function idbGet(k) { try { const db = await idbOpen(); return await new Promise((res) => { const tx = db.transaction('kv', 'readonly').objectStore('kv').get(k); tx.onsuccess = () => res(tx.result || null); tx.onerror = () => res(null); }); } catch { return null; } }
    async function idbSet(k, v) { try { const db = await idbOpen(); await new Promise((res) => { const tx = db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = res; tx.onabort = res; }); } catch { } }
    async function idbDel(k) { try { const db = await idbOpen(); await new Promise((res) => { const tx = db.transaction('kv', 'readwrite').objectStore('kv').delete(k); tx.oncomplete = res; tx.onerror = res; tx.onabort = res; }); } catch { } }

    /* ================= СОХРАНЕНИЕ СПИСКА (Seamless Restore) ================= */
    const SAVE_KEY = 'lastScanData_v3';
    async function saveScanToStorage(items, sourceLink) {
        try {
            const minimal = items.map(i => ({
                name: i.name,
                orig: i.orig,
                size: i.size,
                path: i.path,
                sha256: i.sha256,
                mode: i.mode,
                pid: i.pid,
                sel: i.sel,
                diag: i.diag,
                diagMsg: i.diagMsg
            }));

            GM_setValue(SAVE_KEY, JSON.stringify({
                v: SCRIPT_VERSION,
                t: Date.now(),
                link: sourceLink,
                key: S.key,
                pm: S.pm,
                rootName: S.rootName,
                items: minimal
            }));
        } catch (e) {
            console.warn('YaDLer: Не удалось сохранить сеанс', e);
        }
    }

    async function loadScanFromStorage() {
        try {
            const raw = GM_getValue(SAVE_KEY);
            if (!raw) return null;

            const data = JSON.parse(raw);

            if (!data || data.v !== SCRIPT_VERSION) {
                try { GM_deleteValue(SAVE_KEY); } catch { /* ignore */ }
                return null;
            }

            if (Date.now() - data.t > 24 * 60 * 60 * 1000) {
                try { GM_deleteValue(SAVE_KEY); } catch { /* ignore */ }
                return null;
            }

            return data;
        } catch {
            return null;
        }
    }

    function restoreScan(data) {
        if (!data || !data.items || !data.items.length) return false;

        S.items = data.items.map(i => newItem(i.name, i.orig, i.size, i.path, i.sha256, i.mode, i.pid));
        S.items.forEach((it, idx) => {
            const src = data.items[idx] || {};
            it.sel = src.sel !== false;
            it.diag = src.diag || '';
            it.diagMsg = src.diagMsg || '';
        });

        S.link = data.link || 'Восстановленный сеанс';
        S.key = data.key || '';
        S.pm = data.pm || ((S.items[0] && S.items[0].mode === 'psession') ? 'private' : 'public');

        const rootCandidates = [...new Set(S.items.map((i) => (i.name.includes('/') ? i.name.split('/')[0] : '')).filter(Boolean))];
        S.rootName = data.rootName || (rootCandidates.length === 1 ? rootCandidates[0] : '');

        S.scanDone = true;
        S.screen = 'scan';
        S.busy = null;
        S.job = null;
        S.live = null;

        buildList();
        applySort('tree');
        if (ui.sort) ui.sort.value = 'tree';

        S.scanStats = computeScanStats();
        syncUI();

        log(`Сеанс восстановлен: ${S.items.length} файлов из прошлой сессии.`, 'ok');
        return true;
    }

    /* ================= АВТОПОДБОР ПОТОКОВ ================= */
    function throttleDown(why) {
        const now = Date.now();
        S.lastRateLimit = now; S.lastProblem = now;
        if (modeSafe()) { if (S.effConc > 1) { S.effConc--; log(`Яндекс просит притормозить (${why}): потоков теперь ${S.effConc}`, 'warn'); } return; }
        if (!ST.auto || !S.busy || S.effConc <= 1 || now - S.lastDown < CFG.THROTTLE_GAP_MS) return;
        S.effConc--; S.lastDown = now;
        log(`Яндекс просит притормозить (${why}): потоков теперь ${S.effConc}`, 'warn');
    }

    /* ================= СЕТЬ (API) ================= */
    function gmJson(url, auth) {
        return new Promise((resolve, reject) => {
            if (S.stop) return reject(stopErr());
            if (auth) {
                if (!S.token) return reject(Object.assign(new Error('нет входа в личный диск'), { status: 401, authNeeded: true }));
                if (!url.startsWith('https://cloud-api.yandex.net/')) return reject(new Error('токен нельзя отправлять на этот адрес'));
            }
            const hnd = {};
            const done = (fn, v) => { S.handles.delete(hnd); fn(v); };
            const req = GM_xmlhttpRequest({
                method: 'GET', url, timeout: CFG.REQ_TIMEOUT, ...(auth ? { headers: { Authorization: 'OAuth ' + S.token } } : {}),
                onload: (r) => {
                    if (r.status >= 200 && r.status < 300) { try { done(resolve, JSON.parse(r.responseText)); } catch { done(reject, new Error('некорректный ответ API')); } }
                    else {
                        if (r.status === 401 && auth) dropToken();
                        const msg = r.status === 401 ? 'сессия истекла: обновите страницу и войдите в Яндекс' : r.status === 404 ? 'не найдено (ссылка закрыта или файл удалён)' : r.status === 403 ? 'доступ запрещён / лимит скачиваний' : r.status === 429 ? 'слишком много запросов (429)' : 'HTTP ' + r.status;
                        done(reject, Object.assign(new Error(msg), { status: r.status, authNeeded: r.status === 401 }));
                    }
                },
                onerror: () => done(reject, new Error('сетевая ошибка')),
                ontimeout: () => done(reject, new Error('таймаут запроса')),
                onabort: () => done(reject, stopErr()),
            });
            hnd.abort = () => { try { req.abort(); } catch { } };
            S.handles.add(hnd);
        });
    }
    async function apiGet(url, auth) {
        let last;
        for (let i = 0; i < 3; i++) {
            try { return await gmJson(url, auth); }
            catch (e) {
                if (e.stopped) throw e;
                if (e.status === 429) throttleDown('429');
                else if (e.status && e.status < 500) throw e;
                last = e;
                log(`API: ${e.message}, повтор ${i + 1}/3`, 'warn');
                await sleep(1500 * (i + 1));
                if (S.stop) throw stopErr();
            }
        }
        throw last;
    }

    /* ================= ЛИЧНЫЙ ДИСК БЕЗ OAUTH: СЕССИОННЫЙ РЕЖИМ ================= */
    function skFromPerformance() {
        try {
            const es = performance.getEntriesByType('resource');
            for (let i = es.length - 1; i >= 0; i--) {
                const m = String(es[i].name || '').match(/[?&]sk=([a-zA-Z0-9_-]{6,})/);
                if (m) return m[1];
            }
        } catch { }
        return '';
    }
    function skFromHtml() {
        try {
            const html = document.documentElement.innerHTML;
            const m = html.match(/[?&"]sk["'=:]+"?([a-zA-Z0-9_-]{6,})"/) || html.match(/"sk"\s*:\s*"([a-zA-Z0-9_-]{6,})"/);
            if (m) return m[1];
        } catch { }
        return '';
    }
    function findSk() { return skFromPerformance() || skFromHtml(); }
    async function waitSk(timeoutMs) {
        const t0 = Date.now();
        for (; ;) {
            const sk = findSk();
            if (sk) return sk;
            if (Date.now() - t0 > (timeoutMs || 4000)) return '';
            await new Promise((r) => setTimeout(r, 400));
        }
    }
    let LIST_TPL = null;
    function discoverListTemplate() {
        LIST_TPL = null;
        try {
            const es = performance.getEntriesByType('resource');
            const markers = ['list', 'folder', 'children', 'browse', 'contents', 'resources'];
            for (let i = es.length - 1; i >= 0; i--) {
                const u = String(es[i].name || '');
                if (!/[?&]sk=/.test(u)) continue;
                const low = u.toLowerCase();
                if (!markers.some((m) => low.includes(m))) continue;
                let pathKey = '';
                try {
                    const url = new URL(u);
                    for (const [k, v] of url.searchParams) {
                        if (/^(dir|path|folder|parent)$/i.test(k) && (v.startsWith('/') || v.startsWith('disk:') || v === '')) { pathKey = k; break; }
                    }
                    if (!pathKey) for (const [k] of url.searchParams) if (/(dir|path|folder)/i.test(k)) { pathKey = k; break; }
                } catch { }
                LIST_TPL = { url: u, pathKey: pathKey || 'dir' };
                return;
            }
        } catch { }
    }
    function getSessCookies() { try { return document.cookie; } catch { return ''; } }

    function sessGet(url) {
        return new Promise((resolve, reject) => {
            if (S.stop) return reject(stopErr());
            const cookie = getSessCookies();
            GM_xmlhttpRequest({
                method: 'GET', url, timeout: CFG.REQ_TIMEOUT,
                headers: { Cookie: cookie, Accept: 'application/json' },
                onload: (r) => {
                    if (r.status >= 200 && r.status < 300) {
                        try { resolve(JSON.parse(r.responseText)); }
                        catch { reject(new Error('JSON parse error')); }
                    } else {
                        reject(Object.assign(new Error(`HTTP ${r.status}: ${(r.statusText || '').slice(0, 50)}`), { status: r.status }));
                    }
                },
                onerror: () => reject(new Error('Network error')),
                ontimeout: () => reject(new Error('Timeout')),
            });
        });
    }
    function sessPost(url, body) {
        return new Promise((resolve, reject) => {
            if (S.stop) return reject(stopErr());
            const cookie = getSessCookies();
            GM_xmlhttpRequest({
                method: 'POST', url, timeout: CFG.REQ_TIMEOUT,
                headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
                data: JSON.stringify(body),
                onload: (r) => {
                    if (r.status >= 200 && r.status < 300) {
                        try { resolve(JSON.parse(r.responseText)); }
                        catch { reject(new Error('JSON parse error')); }
                    } else {
                        reject(Object.assign(new Error(`HTTP ${r.status}: ${(r.statusText || '').slice(0, 50)}`), { status: r.status }));
                    }
                },
                onerror: () => reject(new Error('Network error')),
                ontimeout: () => reject(new Error('Timeout')),
            });
        });
    }
    function normItems(r) {
        const c = [r && r._embedded && r._embedded.items, r && r.list, r && r.entries, r && r.resources && r.resources.items, r && r.items, r && r.data && r.data.items];
        for (const arr of c) if (Array.isArray(arr) && arr.length) return arr;
        for (const arr of c) if (Array.isArray(arr)) return arr;
        return [];
    }
    function normTotal(r, n) {
        const c = [r && r._embedded && r._embedded.total, r && r.properties && (r.properties.count || r.properties.total), r && r.total, r && r.count];
        for (const v of c) if (typeof v === 'number' && v > 0) return v;
        return n;
    }
    async function sessList(path, offset) {
        const frag = (o) => { try { return String(JSON.stringify(o)).slice(0, 160); } catch { return '?'; } };
        if (LIST_TPL) {
            try {
                const url = new URL(LIST_TPL.url);
                url.searchParams.set(LIST_TPL.pathKey, path);
                url.searchParams.set('limit', '100');
                url.searchParams.set('offset', String(offset));
                url.searchParams.delete('cursor');
                const r = await sessGet(url.href);
                const items = normItems(r);
                if (items.length || offset > 0) return { items, total: normTotal(r, items.length) };
                throw new Error('tpl empty ' + frag(r));
            } catch (e) { if (e.stopped) throw e; }
        }
        const bases = [`https://disk.yandex.ru/models/list/?model=list&sk=${S.sk2}`, `https://disk.yandex.ru/models/browse/?model=browse&sk=${S.sk2}`];
        const keys = ['dir', 'path'];
        let lastErr = null;
        for (const b of bases) for (const k of keys) {
            try {
                const r = await sessGet(`${b}&${k}=${encodeURIComponent(path)}&limit=100&offset=${offset}`);
                const items = normItems(r);
                if (items.length) return { items, total: normTotal(r, items.length) };
                lastErr = new Error(`${k}@${b.split('?')[0]} → ${frag(r)}`);
            } catch (e) { if (e.stopped) throw e; lastErr = e; }
        }
        throw Object.assign(new Error('список пуст: ' + ((lastErr && lastErr.message) || 'нет данных')), { diag: true });
    }

    /* ===== v2.3.9+: ссылка на скачивание с личного диска ===== */
    function collectUrls(o, out, d) {
        d = d || 0;
        if (o == null || d > 7) return out;
        if (typeof o === 'string') {
            const s = o.startsWith('//') ? 'https:' + o : o;
            if (/^https:\/\/[^\s"']+$/.test(s) && isYandexHttps(s)) out.push(s);
        } else if (typeof o === 'object') {
            for (const k of Object.keys(o)) collectUrls(o[k], out, d + 1);
        }
        return out;
    }
    function isDownloadHref(h) {
        return /downloader\.disk\.yandex|[?&]disposition=|[?&]filename=/i.test(h) && !/\/preview|preview\.|thumb/i.test(h);
    }
    function pickHref(r) {
        const urls = collectUrls(r, []);
        return urls.find(isDownloadHref) || '';
    }
    async function tryTpl(t, p) {
        const f = pathForms(p);
        const params = JSON.parse(JSON.stringify(t.params || {}));
        const v = t.form === 'colon' ? f.colon : f.slash;
        params[t.key] = t.arr ? [v] : v;
        const r = await privateApi(t.api, params);
        const href = pickHref(r);
        if (!href) throw new Error(t.api + ': в ответе нет ссылки на скачивание');
        return href;
    }
    async function discoverUrlTpl(p) {
        const tried = new Set();
        const attempt = async (t) => {
            const sig = t.api + '|' + t.key + '|' + t.form + '|' + (t.arr ? 'a' : 's');
            if (tried.has(sig)) return false;
            tried.add(sig);
            try {
                await tryTpl(t, p);
                S.urlTpl = { api: t.api, params: t.params, key: t.key, form: t.form, arr: !!t.arr };
                log('Личный диск: найден рабочий запрос ссылки скачивания (' + t.api + ').', 'ok');
                return true;
            } catch (e) { if (e.stopped) throw e; return false; }
        };
        const fromCalls = async (nameRe) => {
            for (const c of S.calls.slice().reverse()) {
                if (nameRe && !nameRe.test(c.api)) continue;
                if (/list|folder|children|browse|tree|search|stat|log|notif|counter|setting|config|user|space/i.test(c.api) && !nameRe) continue;
                const pp = detectPathParam(c.params);
                if (!pp) continue;
                if (await attempt({ api: c.api, params: c.params, key: pp.key, form: pp.form, arr: pp.arr })) return true;
            }
            return false;
        };
        if (await fromCalls(/url|download|link|file/i)) return;
        const apis = ['do-get-resource-url', 'mpfs/url', 'mpfs/download-url', 'mpfs/get-url', 'mpfs/resource-url', 'resource-url', 'download-url'];
        for (const api of apis) for (const key of ['id', 'path']) for (const form of ['slash', 'colon']) {
            if (S.stop) throw stopErr();
            if (await attempt({ api, params: {}, key, form, arr: false })) return;
        }
        const t0 = Date.now();
        log('Личный диск: не удалось подобрать запрос ссылки автоматически. Нажмите в самом Яндекс Диске «Скачать» на ЛЮБОМ одном файле (один раз) — скрипт перехватит запрос и продолжит сам. Жду до 90 с…', 'warn');
        while (Date.now() - t0 < 90000 && !S.stop) {
            for (const c of S.calls) {
                if (c.t < t0 || c.tried) continue;
                c.tried = true;
                const pp = detectPathParam(c.params);
                if (!pp) continue;
                if (await attempt({ api: c.api, params: c.params, key: pp.key, form: pp.form, arr: pp.arr })) return;
            }
            await sleep(600);
        }
        if (S.stop) throw stopErr();
    }
    async function sessHref(pathOrId) {
        const p = String(pathOrId || '');
        const failMsg = 'не найден запрос ссылки скачивания личного диска: нажмите в Яндекс Диске родную «Скачать» на одном файле и повторите';
        if (!S.urlTpl && Date.now() < S.urlFailUntil) throw Object.assign(new Error(failMsg), { final: true });
        if (!S.urlTpl) {
            if (!S.discP) S.discP = discoverUrlTpl(p).finally(() => { S.discP = null; });
            await S.discP;
            if (!S.urlTpl) { S.urlFailUntil = Date.now() + 60000; throw Object.assign(new Error(failMsg), { final: true }); }
        }
        try {
            const href = await tryTpl(S.urlTpl, p);
            S.tplFail = 0;
            return href;
        } catch (e) {
            if (e.stopped) throw e;
            if (++S.tplFail >= 5) { S.urlTpl = null; S.tplFail = 0; }
            throw e;
        }
    }
    async function getLink(it) {
        if (it.mode === 'psession') return sessHref(it.pid || it.path);
        if (it.mode === 'private') {
            const d = await apiGet(`${PRIV}/download?${new URLSearchParams({ path: it.path })}`, true);
            if (!d.href || !isYandexHttps(d.href)) throw Object.assign(new Error('неожиданный адрес загрузки'), { final: true });
            return d.href;
        }
        const q = new URLSearchParams({ public_key: S.key });
        if (it.path) q.set('path', it.path);
        const d = await apiGet(`${API}/download?${q}`);
        if (!d.href || !isYandexHttps(d.href)) throw Object.assign(new Error('неожиданный адрес загрузки'), { final: true });
        return d.href;
    }

    /* ================= ГЛУБОКАЯ ПРОБА ХРАНИЛИЩА ================= */
    function probeOnce(href) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'HEAD', url: href, timeout: CFG.PROBE_TIMEOUT,
                onload: (r) => { if (r.status === 200 || r.status === 206 || r.status === 405 || r.status === 501) resolve('ok'); else if (r.status === 403 || r.status === 404 || r.status === 410 || r.status >= 500) resolve('dead'); else resolve('ok'); },
                onerror: () => resolve('err'), ontimeout: () => resolve('noresp'), onabort: () => resolve('err'),
            });
        });
    }
    async function probeCdn(href) { const r = await probeOnce(href); if (r === 'err' && !S.stop) { await sleep(1500); return probeOnce(href); } return r; }

    /* ================= СКАНИРОВАНИЕ + ДВУХСТУПЕНЧАТАЯ ПРОВЕРКА ================= */
    const newItem = (name, orig, size, path, sha, mode = 'public', pid = '') => ({
        mode, pid, local: '', name, orig, dir: dirName(orig), depth: dirName(orig) ? dirName(orig).split('/').length : 0,
        size: typeof size === 'number' ? size : null, path: path || null,
        sha256: typeof sha === 'string' && /^[0-9a-f]{64}$/i.test(sha) ? sha.toLowerCase() : '',
        sel: true, filtered: true, collapsedHide: false,
        status: 'queued', attempts: 0, slowRestarts: 0, error: '', notes: [], warn: '', noRetry: false,
        diag: '', diagMsg: '', cls: '',
        got: 0, total: typeof size === 'number' ? size : 0, t0: 0, last: 0, phase: '', winT: 0, winB: 0, skipped: false, ui: null,
    });
    async function walk(path, cleanParts, origParts, out) {
        if (S.job) S.job.cur = path || '/';
        let offset = 0;
        for (; ;) {
            await pauseGate();
            const q = new URLSearchParams({ public_key: S.key, limit: '100', offset: String(offset) });
            if (path) q.set('path', path);
            const r = await apiGet(`${API}?${q}`);
            const emb = r._embedded;
            if (!emb || !emb.items.length) break;
            for (const it of emb.items) {
                if (it.type === 'dir') { if (S.job) S.job.dirs++; await walk(it.path, [...cleanParts, cleanSeg(it.name)], [...origParts, it.name], out); }
                else out.push(newItem([...cleanParts, cleanSeg(it.name)].join('/'), [...origParts, it.name].join('/'), it.size, it.path, it.sha256));
            }
            offset += emb.items.length;
            if (S.job) S.job.done = out.length;
            if (offset >= emb.total) break;
        }
    }
    const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
    function cmpDirs(a, b) { const x = a ? a.split('/') : [], y = b ? b.split('/') : []; for (let i = 0; i < Math.min(x.length, y.length); i++) { const c = collator.compare(x[i], y[i]); if (c) return c; } return x.length - y.length; }
    async function walkPrivate(path, cleanParts, origParts, out) {
        let offset = 0;
        for (; ;) {
            await pauseGate();
            const q = new URLSearchParams({ path, limit: '100', offset: String(offset) });
            const r = await apiGet(`${PRIV}?${q}`, true);
            const emb = r._embedded;
            if (!emb || !emb.items.length) break;
            for (const it of emb.items) {
                if (it.type === 'dir') { if (S.job) S.job.dirs++; await walkPrivate(it.path, [...cleanParts, cleanSeg(it.name)], [...origParts, it.name], out); }
                else out.push(newItem([...cleanParts, cleanSeg(it.name)].join('/'), [...origParts, it.name].join('/'), it.size, it.path, it.sha256, 'private'));
            }
            offset += emb.items.length;
            if (S.job) S.job.done = out.length;
            if (offset >= emb.total) break;
        }
    }
    async function walkSession(pathWeb, cleanParts, origParts, out) {
        let offset = 0;
        for (; ;) {
            await pauseGate();
            const { items, total } = await sessList(pathWeb, offset);
            if (!items.length) break;
            for (const e of items) {
                const name = e.name || e.file_name || e.title || '';
                if (!name) continue;
                const t = String(e.type || e.file_type || '').toLowerCase();
                const isDir = t === 'dir' || t === 'directory' || e.isDir === true;
                const childWeb = pathWeb.replace(/\/+$/, '') + '/' + name;
                const id = e.id || e.file_id || e.public_id || '';
                const size = e.size != null ? Number(e.size) : (e.file_size != null ? Number(e.file_size) : null);
                const pth = e.path || e.file_path || childWeb;
                const sha = e.sha256 || '';
                if (isDir) { if (S.job) S.job.dirs++; await walkSession(childWeb, [...cleanParts, cleanSeg(name)], [...origParts, name], out); }
                else out.push(newItem([...cleanParts, cleanSeg(name)].join('/'), [...origParts, name].join('/'), size, pth, sha, 'psession', id));
            }
            offset += items.length;
            if (S.job) S.job.done = out.length;
            if (offset >= total) break;
        }
    }
    async function runDiag(todo) {
        let next = 0, ok = 0, noaccess = 0, errs = 0;
        const worker = async () => {
            while (!S.stop && next < todo.length) {
                await pauseGate();
                const it = todo[next++];
                it.phase = 'проверка доступности';
                try {
                    const href = await getLink(it);
                    const pr = await probeCdn(href);
                    if (pr === 'ok') { it.diag = 'ok'; it.diagMsg = ''; ok++; }
                    else if (pr === 'dead') { it.diag = 'noaccess'; it.diagMsg = 'мёртв на хранилище (ссылка есть, файл не отдают)'; noaccess++; }
                    else if (pr === 'noresp') { it.diag = 'noaccess'; it.diagMsg = 'хранилище не отвечает (таймаут)'; noaccess++; }
                    else { it.diag = 'err'; it.diagMsg = 'проба хранилища не удалась (сеть)'; errs++; }
                } catch (e) {
                    if (e.stopped) break;
                    if (e.status === 429) { it.diag = 'err'; it.diagMsg = 'слишком много запросов — повторите позже'; errs++; await sleep(10000); }
                    else { const c = classify(e); if (c === 'limit' || c === 'gone') { it.diag = 'noaccess'; it.diagMsg = CLS_TEXT[c]; noaccess++; } else { it.diag = 'err'; it.diagMsg = e.message; errs++; } }
                }
                if (S.job) S.job.done++;
                renderItem(it);
                await sleep(rand(150, 400));
            }
        };
        await Promise.all(Array.from({ length: CFG.DIAG_CONC }, worker));
        return { ok, noaccess, errs };
    }
    async function scan() {
        if (S.busy) return;
        const src = detectSource();
        if (!src) {
            log('Откройте публичную ссылку (disk.yandex.ru/d/…) или папку на своём Диске (раздел «Файлы»). Путь можно ввести вручную в «Личный диск».', 'err');
            return;
        }
        S.busy = 'scan';
        S.stop = false;
        S.pause = false;
        S.scanDone = false;
        S.rootName = '';
        S.scanT0 = Date.now();
        S.scanMs = 0;
        S.scanStats = null;
        S.screen = 'scan';
        S.live = [];
        startJob('Сканирование', null);
        syncUI();
        S.pm = src.kind;
        S.key = src.kind === 'public' ? src.key : '';
        S.link = src.kind === 'public' ? location.href.split('?')[0] : `Личный диск: ${src.path}`;
        ui.list.replaceChildren();
        S.items = [];
        S.groups = [];
        S.treeOrder = [];
        S.runMs = 0;
        // НЕ сбрасываем S.calls / S.tpl: они накапливаются от страницы Яндекса
        // и нужны для правильной работы tryPrivateList.
        // Раньше их сбрасывали здесь — и из-за этого tryPrivateList получал
        // пустой пул запросов и начинал перебирать «догадки», что давало
        // список «не тех» файлов.
        if (src.kind === 'private') {
            log('Жду запросы страницы Яндекса к API…');
            const waitStart = Date.now();
            while (Date.now() - waitStart < 2500 && !S.stop && S.calls.length < 3) {
                await sleep(200);
            }
            if (S.calls.length === 0) {
                log('Страница не делает запросов к API. Кликните в Диске по любой папке один раз и повторите скан.', 'warn');
            }
        }
        ui.filter.value = '';
        ui.activeBox.replaceChildren();
        ui.thanks.hidden = true;
        setTitlePrefix('');
        log(`Сканирование: ${S.link}`, '', src.kind === 'public' ? undefined : 'Сканирование личного диска');
        try {
            const found = [];
            S.live = found;
            if (src.kind === 'public') {
                const q = new URLSearchParams({ public_key: S.key });
                if (src.sub) q.set('path', src.sub);
                const root = await apiGet(`${API}?${q}`);
                if (root.type === 'file') {
                    found.push(newItem(cleanSeg(root.name), root.name, root.size, src.sub || null, root.sha256));
                } else {
                    await walk(src.sub || null, [cleanSeg(root.name)], [root.name], found);
                }
            } else {
                const webPath = src.path === 'disk:/' ? '/disk' : '/disk/' + src.path.replace(/^disk:\//, '');
                const rootBase = src.path === 'disk:/' ? 'Мой Диск' : baseName(src.path);
                let ok = false;
                try {
                    await walkPrivateSession(webPath, [cleanSeg(rootBase)], [rootBase], found);
                    ok = found.length > 0;
                    if (ok) {
                        log('Личный диск: список получен через внутреннее API страницы (без входа).', 'ok');
                    }
                } catch (e) {
                    if (e.stopped) throw e;
                    log('Личный диск: внутреннее API списка не сработало (' + maskSecret(e.message) + '). Пробую читать текущую папку из памяти страницы.', 'warn');
                }
                if (!ok) {
                    try {
                        const fib = collectFiberCurrent();
                        if (fib.length) {
                            found.push(...fib);
                            ok = true;
                            log('Личный диск: прочитал текущую папку из памяти страницы. Если нужны подпапки — открой их и просканируй отдельно или один раз нажми родную «Скачать», чтобы скрипт запомнил шаблон списка.', 'warn');
                        }
                    } catch (e) {
                        if (e.stopped) throw e;
                        log('Fiber-чтение не удалось: ' + maskSecret(e.message), 'warn');
                    }
                }
                if (!ok && S.token) {
                    try {
                        const root = await apiGet(`${PRIV}?${new URLSearchParams({ path: src.path })}`, true);
                        if (root.type === 'file') {
                            found.push(newItem(cleanSeg(root.name), root.name, root.size, src.path, root.sha256, 'private'));
                        } else {
                            const base = src.path === 'disk:/' ? 'Мой Диск' : (root.name || 'Папка');
                            await walkPrivate(src.path, [cleanSeg(base)], [base], found);
                        }
                        ok = found.length > 0;
                        if (ok) {
                            log('Личный диск: список получен через OAuth.', 'ok');
                        }
                    } catch (e) {
                        if (e.stopped) throw e;
                        log('OAuth-скан не удался: ' + e.message, 'err');
                    }
                }
                if (!ok) {
                    log('Не удалось получить список личного диска. Обновите страницу (F5), убедитесь, что вы вошли в Яндекс, и попробуйте снова.', 'err');
                    return;
                }
            }
            if (!found.length) {
                log('Файлов не найдено.', 'err');
                return;
            }
            found.sort((a, b) => cmpDirs(a.dir, b.dir) || collator.compare(baseName(a.orig), baseName(b.orig)));

            const rootCandidates = [...new Set(found.map((i) => (i.name.includes('/') ? i.name.split('/')[0] : '')).filter(Boolean))];
            S.rootName = rootCandidates.length === 1 ? rootCandidates[0] : '';

            S.items = found;
            buildList();
            applySort('tree');
            ui.sort.value = 'tree';
            if (ui.names.value.trim()) applyNames();
            if (ST.autoDiag && !S.stop) {
                S.job = { label: 'Проверка доступности', done: 0, dirs: 0, total: found.length };
                const d = await runDiag(found);
                if (d.noaccess) {
                    log(`Недоступны на сервере: ${d.noaccess} файлов (помечены ⚠). Кнопка «Снять недоступные» уберёт их из выбора.`, 'warn');
                }
                if (d.errs) {
                    log(`Ошибок проверки: ${d.errs}`, 'warn');
                }
            }
            S.scanMs = Date.now() - S.scanT0;
            S.scanStats = computeScanStats();
            const st = S.scanStats;
            log(`Найдено: папок ${st.dirs}, файлов ${st.files}, ${fmtSize(st.bytes)} · недоступно ${st.noaccess} · время ${fmtTime(st.ms)}. Нажмите «Скачать».`, 'ok');
            S.scanDone = true;
            // Сохраняем сеанс
            saveScanToStorage(S.items, S.link);
        } catch (e) {
            S.scanMs = Date.now() - S.scanT0;
            S.scanStats = computeScanStats();
            log(
                e.stopped ? 'Сканирование остановлено.' : 'Ошибка сканирования: ' + maskSecret(e.message),
                e.stopped ? 'warn' : 'err'
            );
        } finally {
            S.busy = null;
            S.job = null;
            S.live = null;
            syncUI();
        }
    }
    async function diagnoseNow() {
        if (S.busy) return;
        if (!S.items.length) { log('Сначала отсканируйте папку на Диске.', 'warn'); return; }
        S.busy = 'diag'; S.stop = false; S.pause = false; S.screen = 'scan'; syncUI();
        const todo = S.items.filter((i) => i.sel);
        startJob('Проверка доступности', todo.length);
        log('Повторная проверка: ссылка у API + проба хранилища по каждому файлу…');
        const d = await runDiag(todo);
        S.job = null;
        S.scanStats = computeScanStats();
        S.busy = null; syncUI();
        if (S.stop) { log('Проверка остановлена.', 'warn'); return; }
        log(`Проверка завершена: доступно ${d.ok}, недоступно ${d.noaccess}, ошибок ${d.errs}.`, d.noaccess ? 'warn' : 'ok');
    }

    /* ================= ЛИЧНЫЙ ДИСК: OAUTH-ВХОД (страховка) ================= */
    function updatePrivUI() { if (!ui.loginBtn) return; ui.loginBtn.hidden = !!S.token; ui.logoutBtn.hidden = !S.token; ui.privStatus.textContent = S.token ? `Подключён${S.user ? ': ' + S.user : ''}` : 'Не подключён'; }
    function dropToken() { S.token = ''; S.user = ''; try { GM_deleteValue('oauth_token_tmp'); } catch { } updatePrivUI(); }
    function startLogin() {
        const id = ((GM_getValue('clientId', '') || OAUTH_CLIENT_ID) + '').trim();
        if (!/^[0-9a-f]{32}$/i.test(id)) { if (ui.privBox) ui.privBox.open = true; log('Для входа в личный диск нужен Client ID OAuth-приложения: создайте приложение на oauth.yandex.ru (права «чтение диска», callback https://oauth.yandex.ru/verification_code) и вставьте его ID в «Личный диск → Вход вручную». Личный диск также работает без входа, если Яндекс отдаёт сессию страницы.', 'warn'); return; }
        try { GM_setValue('oauth_pending', Date.now()); } catch { }
        window.open('https://oauth.yandex.ru/authorize?' + new URLSearchParams({ response_type: 'token', client_id: id }), '_blank', 'noopener,noreferrer');
        log('Открыта страница входа Яндекса. Разрешите доступ на чтение: токен подхватится сам. Если нет — скопируйте его и вставьте в «Вход вручную».');
    }
    async function setToken(tok) {
        S.token = tok;
        try {
            const info = await apiGet('https://cloud-api.yandex.net/v1/disk/', true);
            S.user = (info && info.user && info.user.login) || '';
            updatePrivUI();
            log(`Личный диск подключён${S.user ? ': ' + S.user : ''}`, 'ok', 'Личный диск подключён');
            if (S.pendingScan) { S.pendingScan = false; scan(); }
        } catch (e) { log('Токен не подошёл: ' + e.message, 'err'); dropToken(); }
    }
    function adoptTokenFromStorage(raw) { if (!raw) return; try { const v = JSON.parse(raw); GM_deleteValue('oauth_token_tmp'); GM_deleteValue('oauth_pending'); if (v && TOKEN_RE.test(v.token || '') && Date.now() - v.t < 10 * 60 * 1000) setToken(v.token); } catch { } }
    function captureTokenPage() {
        let pending = 0;
        try { pending = Number(GM_getValue('oauth_pending', 0)); } catch { }
        if (!pending || Date.now() - pending > 10 * 60 * 1000) return;
        const grab = () => {
            let tok = new URLSearchParams(location.hash.replace(/^#/, '')).get('access_token') || '';
            if (!tok) {
                const text = ((document.body && (document.body.innerText || document.body.textContent)) || '') + ' ' + [...document.querySelectorAll('input,textarea')].map((e) => e.value).join(' ');
                const m = text.match(/\b(y0[_A-Za-z0-9-]{30,}|AQAAAA[A-Za-z0-9_-]{20,})\b/);
                if (m) tok = m[1];
            }
            return TOKEN_RE.test(tok) ? tok : '';
        };
        let tries = 0;
        const iv = setInterval(() => {
            const tok = grab();
            if (tok) {
                clearInterval(iv);
                try { GM_setValue('oauth_token_tmp', JSON.stringify({ token: tok, t: Date.now() })); } catch { }
                const b = document.createElement('div');
                b.textContent = 'YaDLer: вход выполнен. Вернитесь на вкладку с Диском, эту вкладку можно закрыть.';
                b.style.cssText = 'position:fixed;left:0;right:0;top:0;padding:12px;background:#1f8a4c;color:#fff;font:14px system-ui;text-align:center;z-index:2147483647';
                document.documentElement.append(b);
            } else if (++tries > 120) clearInterval(iv);
        }, 500);
    }

    /* ================= СРАВНЕНИЕ С ПАПКОЙ (С ХЕШАМИ) ================= */
    async function compareLocal() {
        if (S.busy) return;
        if (!S.items.length) { log('Сначала отсканируйте папку на Диске.', 'warn'); return; }
        if (!S.dir) { log('Сначала выберите папку.', 'err'); return; }
        S.busy = 'compare'; S.stop = false; S.pause = false; startJob('Сравнение', S.items.length); syncUI();
        log('Сравнение с папкой на компьютере…' + (ST.verify ? ' (с проверкой SHA-256 у файлов до 256 МБ)' : ''));
        const cache = new Map();
        let stripRoot = false;
        if (ST.subfolders && S.rootName) {
            try { await S.dir.getDirectoryHandle(S.rootName); }
            catch (e) { if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') stripRoot = true; }
        }
        if (stripRoot) log('Выбранная папка сравнивается как сама корневая папка «' + S.rootName + '».');
        let n = 0;
        try {
            for (const it of S.items) {
                if (S.stop) break;
                await pauseGate();
                const full = ST.subfolders ? it.name : baseName(it.name);
                const segs = (stripRoot && full.includes('/')) ? full.split('/').slice(1) : full.split('/');
                const fileName = segs.pop();
                let d = S.dir, key = '';
                for (const sg of segs) {
                    key += '/' + sg;
                    if (cache.has(key)) d = cache.get(key);
                    else { try { d = await d.getDirectoryHandle(sg); } catch (e) { if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') d = null; else throw e; } cache.set(key, d); }
                    if (!d) break;
                }
                let local = 'missing';
                if (d) {
                    try {
                        const f = await (await d.getFileHandle(fileName)).getFile();
                        if (it.size != null && f.size === it.size) {
                            local = 'ok';
                            if (ST.verify && it.sha256 && f.size <= CFG.HASH_MAX && typeof crypto !== 'undefined' && crypto.subtle) { const got = await sha256Of(f); if (got !== it.sha256) local = 'corrupt'; }
                        } else local = 'size';
                    } catch (e) { if (e.name !== 'NotFoundError' && e.name !== 'TypeMismatchError') throw e; }
                }
                it.local = local; renderItem(it);
                n++;
                if (S.job) S.job.done = n;
                if (n % 200 === 0) await new Promise((r) => setTimeout(r, 0));
            }
            const c = { ok: 0, missing: 0, size: 0, corrupt: 0 };
            for (const it of S.items) if (it.local) c[it.local]++;
            log(`Сравнение: совпадает ${c.ok}, нет в папке ${c.missing}, другой размер ${c.size}, повреждено ${c.corrupt}. Кнопка «Отметить недостающие» выберет нужное.`, 'ok');
            S.cmpNote = `Сверка: совпало ${c.ok}, отличается или нет в папке ${c.missing + c.size + c.corrupt}.`;
        } catch (e) { log('Сравнение не удалось: ' + e.message, 'err'); }
        finally { S.busy = null; S.job = null; syncUI(); }
    }
    function markMissing() {
        if (S.busy) return;
        let n = 0;
        for (const it of S.items) { if (it.status === 'done' || !it.local) continue; it.sel = it.local !== 'ok'; if (it.sel) n++; if (it.ui) it.ui.cb.checked = it.sel; }
        if (ui.onlySel.checked) applyVisibility();
        syncUI();
        log(`Отмечено для докачки/перекачки: ${n}`, 'ok');
    }
    function dropUnavailable() {
        if (S.busy) return;
        let n = 0;
        for (const it of S.items) if (it.diag === 'noaccess' && it.sel) { it.sel = false; n++; if (it.ui) it.ui.cb.checked = false; }
        if (ui.onlySel.checked) applyVisibility();
        syncUI();
        log(`Снято с загрузки недоступных файлов: ${n}`, 'ok');
    }

    /* ================= ВЫБОР ПО СПИСКУ ИМЁН ================= */
    const normName = (s) => String(s).normalize('NFC').toLowerCase().replace(/\\/g, '/').replace(/^\/+/, '').trim();
    function parseNames(text) { return text.replace(/^\ufeff/, '').split(/\r?\n/).map((s) => s.trim().split(/\s+\|\s+/)[0].trim().replace(/^["'«]+|["'»]+$/g, '').trim()).filter((s) => s && !s.startsWith('#')); }
    function applyNames() {
        if (S.busy) { log('Нельзя менять выбор во время работы.', 'warn'); return; }
        const names = parseNames(ui.names.value);
        if (!names.length) { log('Список имён пуст.', 'warn'); return; }
        if (!S.items.length) { log('Сначала отсканируйте папку: список применится к найденным файлам.', 'warn'); return; }
        const byBase = new Map(), byStem = new Map();
        for (const it of S.items) {
            const b = normName(baseName(it.orig));
            (byBase.get(b) || byBase.set(b, []).get(b)).push(it);
            const stem = b.replace(/\.[^.]{1,10}$/, '');
            (byStem.get(stem) || byStem.set(stem, []).get(stem)).push(it);
        }
        const matched = new Set(), missing = [], multi = [];
        for (const name of names) {
            const n = normName(name);
            let hits;
            if (n.includes('/')) hits = S.items.filter((it) => { const p = normName(it.orig); return p === n || p.endsWith('/' + n); });
            else hits = byBase.get(n) || byStem.get(n) || [];
            if (!hits.length) missing.push(name);
            else { if (hits.length > 1) multi.push(`${name} (${hits.length})`); hits.forEach((i) => matched.add(i)); }
        }
        for (const it of S.items) { if (it.status === 'done') continue; it.sel = matched.has(it); if (it.ui) it.ui.cb.checked = it.sel; }
        S.namesMissing = missing;
        if (ui.onlySel.checked) applyVisibility();
        syncUI();
        log(`По списку: имён ${names.length}, найдено ${names.length - missing.length}, отмечено файлов ${matched.size}.`, missing.length ? 'warn' : 'ok');
    }
    async function loadNamesFile(file) {
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) { log('Файл списка слишком большой (больше 2 МБ).', 'err'); return; }
        try {
            const buf = await file.arrayBuffer();
            let text;
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1251').decode(buf); }
            ui.names.value = text;
            try { GM_setValue('names', text); } catch { }
            log(`Список загружен из «${file.name}»: строк ${parseNames(text).length}.`, 'ok', `Список имён загружен: строк ${parseNames(text).length}`);
            if (S.items.length) applyNames();
        } catch (e) { log('Не удалось прочитать файл: ' + e.message, 'err'); }
    }

    /* ================= КОНТРОЛЬ СКОРОСТИ ================= */
    function isTooSlow(it) {
        const min = ST.minSpeed * 1024;
        if (!min || it.slowRestarts >= CFG.SLOW_MAX || it.got <= 0) return false;
        const now = Date.now();
        if (!it.winT) { it.winT = now; it.winB = it.got; return false; }
        if (now - it.winT < CFG.SLOW_WINDOW) return false;
        const speed = (it.got - it.winB) / ((now - it.winT) / 1000);
        it.winT = now; it.winB = it.got;
        if (it.size && (it.size - it.got) / Math.max(speed, 1) < CFG.SLOW_NEAR_END_S) return false;
        return speed < min;
    }
    const slowErr = () => Object.assign(new Error(`медленно (меньше ${ST.minSpeed} КБ/с)`), { slow: true });

    /* ================= ЗАПИСЬ ФАЙЛА ================= */
    function viaStreamWrite(it, href, fh) {
        return new Promise((resolve, reject) => {
            const hnd = {};
            let finished = false, wdOn = true, req = null, reader = null, writer = null, started = false, lastPaint = 0;
            it.last = Date.now(); it.phase = 'ожидание ответа'; it.winT = 0;
            const finish = (fn, v) => { if (finished) return; finished = true; wdOn = false; S.handles.delete(hnd); fn(v); };
            const kill = () => { try { if (req) req.abort(); } catch { } try { if (reader) reader.cancel(); } catch { } };
            (async () => {
                while (wdOn) {
                    await tickWait();
                    if (!wdOn) break;
                    const now = Date.now();
                    if (now - it.last > ST.stall * 1000) { finish(reject, Object.assign(new Error(`завис: нет данных ${ST.stall} с`), { stalled: true })); kill(); break; }
                    else if (isTooSlow(it)) { S.lastProblem = now; finish(reject, slowErr()); kill(); break; }
                }
            })();
            const pump = async (stream, status) => {
                if (started) return;
                started = true;
                try {
                    if (status && (status < 200 || status >= 300)) throw Object.assign(new Error('HTTP ' + status), { status });
                    reader = stream.getReader();
                    writer = await fh.createWritable();
                    it.phase = 'скачивание и запись'; it.last = Date.now();
                    for (; ;) {
                        const { done, value } = await reader.read();
                        if (finished) throw stopErr();
                        if (done) break;
                        await writer.write(value);
                        it.got += value.byteLength; it.last = Date.now();
                        if (it.last - lastPaint > 250) { lastPaint = it.last; renderItem(it); }
                    }
                    if (it.size != null && it.got !== it.size) throw new Error(`получено ${fmtSize(it.got)} вместо ${fmtSize(it.size)}`);
                    await writer.close(); writer = null;
                    finish(resolve);
                } catch (e) { try { if (writer) await writer.abort(); } catch { } finish(reject, e); }
            };
            const tryStart = (r) => { if (!started && r && r.response && typeof r.response.getReader === 'function') pump(r.response, r.status); };
            req = GM_xmlhttpRequest({
                method: 'GET', url: href, responseType: 'stream', fetch: true, ...(it.mode === 'psession' ? { headers: { Referer: location.origin + '/' } } : {}),
                onloadstart: tryStart, onreadystatechange: tryStart,
                onload: (r) => { tryStart(r); if (!started) finish(reject, Object.assign(new Error('поток недоступен'), { code: 'nostream' })); },
                onerror: () => finish(reject, new Error('сетевая ошибка')),
                ontimeout: () => finish(reject, new Error('таймаут')),
                onabort: () => finish(reject, stopErr()),
            });
            hnd.abort = () => { finish(reject, stopErr()); kill(); };
            S.handles.add(hnd);
        });
    }
    function fetchBlob(it, href, maxBytes) {
        if (it.size && it.size > maxBytes) return Promise.reject(Object.assign(new Error(`файл ${fmtSize(it.size)} больше лимита ${fmtSize(maxBytes)} для режима без потоков — скачайте отдельно`), { final: true }));
        return new Promise((resolve, reject) => {
            const hnd = {};
            let finished = false, wdOn = true, req = null;
            it.last = Date.now(); it.phase = 'скачивание'; it.winT = 0;
            const finish = (fn, v) => { if (finished) return; finished = true; wdOn = false; S.handles.delete(hnd); fn(v); };
            (async () => {
                while (wdOn) {
                    await tickWait();
                    if (!wdOn) break;
                    const now = Date.now();
                    if (now - it.last > ST.stall * 1000) { finish(reject, Object.assign(new Error(`завис: нет данных ${ST.stall} с`), { stalled: true })); try { req.abort(); } catch { } break; }
                    else if (isTooSlow(it)) { S.lastProblem = now; finish(reject, slowErr()); try { req.abort(); } catch { } break; }
                }
            })();
            req = GM_xmlhttpRequest({
                method: 'GET', url: href, responseType: 'blob', ...(it.mode === 'psession' ? { headers: { Referer: location.origin + '/' } } : {}),
                onprogress: (p) => { it.last = Date.now(); it.got = p.loaded || 0; if (p.total > 0) it.total = p.total; renderItem(it); },
                onload: (r) => {
                    if (r.status < 200 || r.status >= 300 || !r.response) return finish(reject, Object.assign(new Error('HTTP ' + r.status), { status: r.status }));
                    if (it.size && r.response.size !== it.size) return finish(reject, new Error(`размер не совпал (${fmtSize(r.response.size)} вместо ${fmtSize(it.size)})`));
                    it.got = r.response.size;
                    finish(resolve, r.response);
                },
                onerror: () => finish(reject, new Error('сетевая ошибка')),
                ontimeout: () => finish(reject, new Error('таймаут')),
                onabort: () => finish(reject, stopErr()),
            });
            hnd.abort = () => { finish(reject, stopErr()); try { req.abort(); } catch { } };
            S.handles.add(hnd);
        });
    }
    function sha256Of(file) { const job = hashQueue.then(async () => { const buf = await file.arrayBuffer(); const d = await crypto.subtle.digest('SHA-256', buf); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''); }); hashQueue = job.catch(() => { }); return job; }
    async function viaFolder(it, href) {
        if (!S.dir) throw Object.assign(new Error('папка назначения не выбрана'), { final: true });
        const segs = (ST.subfolders ? it.name : baseName(it.name)).split('/');
        const fileName = segs.pop();
        let d = S.dir;
        for (const sg of segs) d = await d.getDirectoryHandle(sg, { create: true });
        let target = null;
        for (let n = 0; n < 50; n++) {
            const cand = n ? withSuffix(fileName, n) : fileName;
            try {
                const f = await (await d.getFileHandle(cand)).getFile();
                if (ST.skipExisting && it.size != null && f.size === it.size) { it.skipped = true; it.notes.push('уже есть, пропущено'); return; }
                if (f.size === 0 && it.size > 0) { target = cand; break; }
                if (ST.fixPartial && it.size != null && f.size > 0 && f.size < it.size) { target = cand; it.notes.push('недокачанный перезаписан'); break; }
            } catch (e) { if (e.name === 'NotFoundError') { target = cand; break; } throw e; }
        }
        if (!target) throw Object.assign(new Error('слишком много файлов с таким именем'), { final: true });
        const fh = await d.getFileHandle(target, { create: true });
        try {
            let done = false;
            if (!S.noStream) {
                try { await viaStreamWrite(it, href, fh); done = true; }
                catch (e) { if (e.code !== 'nostream') throw e; S.noStream = true; log('Потоковая запись недоступна в этой версии Tampermonkey — перехожу на запись через память.', 'warn'); }
            }
            if (!done) {
                const blob = await fetchBlob(it, href, CFG.FOLDER_MAX);
                it.phase = 'запись на диск';
                const w = await fh.createWritable();
                try { await w.write(blob); await w.close(); } catch (e) { try { await w.abort(); } catch { } throw new Error('запись на диск не удалась: ' + e.message); }
            }
            const f = await fh.getFile();
            if (it.size != null && f.size !== it.size) throw new Error(`после записи размер не совпал (${fmtSize(f.size)} вместо ${fmtSize(it.size)})`);
            if (ST.verify) {
                if (!(typeof crypto !== 'undefined' && crypto.subtle)) it.notes.push('SHA-256 недоступен в этом браузере');
                else if (!it.sha256) it.notes.push('SHA-256 не получен от Яндекса');
                else if (f.size > CFG.HASH_MAX) it.notes.push(`SHA-256 не проверен (файл больше ${fmtSize(CFG.HASH_MAX)})`);
                else { it.phase = 'проверка SHA-256'; renderItem(it); const got = await sha256Of(f); if (got !== it.sha256) throw Object.assign(new Error('контрольная сумма SHA-256 не совпала'), { sha: true }); it.notes.push('SHA-256 ✓'); }
            }
        } catch (e) { try { await d.removeEntry(target); } catch { } throw e; }
        if (target !== fileName) it.notes.push(`сохранён как «${target}»`);
    }

    /* ================= ОЧЕРЕДЬ И РЕЖИМЫ ================= */
    function applyMode(m) { if (MODES[m]) { ST.mode = m; ST.conc = MODES[m].conc; ST.auto = MODES[m].auto; } else ST.mode = 'custom'; saveSettings(); }
    function markCustom(key) { if (['conc', 'auto', 'stall', 'minSpeed'].includes(key) && ST.mode !== 'custom') { ST.mode = 'custom'; saveSettings(); log('Режим: Кастом (изменены параметры загрузки)', 'warn'); } }
    function orderTodo(list) { const arr = [...list]; if (ST.mode === 'fast') arr.sort((a, b) => (a.size || 0) - (b.size || 0)); else if (ST.mode === 'safe') arr.sort((a, b) => (b.size || 0) - (a.size || 0)); return arr; }
    async function downloadItem(it) {
        let n = 0;
        while (n < CFG.MAX_ATTEMPTS) {
            if (S.stop) { setStatus(it, 'queued'); return; }
            await pauseGate();
            n++;
            it.attempts = n; it.got = 0; it.skipped = false; it.notes = []; it.winT = 0;
            it.t0 = Date.now(); it.last = it.t0; it.phase = 'получаю ссылку';
            setStatus(it, 'active');
            try {
                const href = await getLink(it);
                await viaFolder(it, href);
                it.error = '';
                setStatus(it, 'done');
                it.local = 'ok';
                log(it.skipped ? `↷ ${it.orig}: уже есть, пропущено` : `✓ ${it.orig}`, 'ok', it.skipped ? '↷ [файл]: уже есть, пропущено' : '✓ [файл]');
                return;
            } catch (e) {
                if (e.stopped) { it.error = ''; setStatus(it, 'queued'); return; }
                if (e.slow) {
                    n--; it.slowRestarts++;
                    it.error = e.message; it.cls = 'slow'; S.lastProblem = Date.now();
                    log(`🐢 ${it.orig}: ${e.message} — перезапуск ${it.slowRestarts}/${CFG.SLOW_MAX}`, 'warn', `🐢 [файл]: ${e.message} — перезапуск ${it.slowRestarts}/${CFG.SLOW_MAX}`);
                    setStatus(it, 'retry');
                    await sleep(rand(1000, 3000));
                    continue;
                }
                it.error = e.message;
                it.cls = classify(e);
                it.noRetry = !!(e.final || e.status === 404);
                it.shaFail = !!e.sha;
                log(`✗ ${it.orig}: ${e.message} (попытка ${n}/${CFG.MAX_ATTEMPTS})`, 'err', `✗ [файл]: ${e.message} (попытка ${n}/${CFG.MAX_ATTEMPTS})`);
                if (it.noRetry || n >= CFG.MAX_ATTEMPTS) break;
                const limited = isRateLimit(e);
                if (limited) throttleDown('429');
                setStatus(it, 'retry');
                await sleep(limited ? 15000 * n : 2000 * n);
            }
        }
        if (it.shaFail) it.noRetry = true;
        if (['net', 'limit', 'gone'].includes(it.cls)) { it.diag = 'noaccess'; it.diagMsg = 'загрузка не удалась: ' + (CLS_TEXT[it.cls] || it.error); }
        setStatus(it, 'failed');
    }
    async function runPass(todo) {
        let next = 0;
        const worker = async (idx) => {
            while (!S.stop && next < todo.length) {
                await pauseGate();
                if (idx > S.effConc) { await sleep(500); continue; }
                const it = todo[next++];
                await downloadItem(it);
                if (S.stop) break;
                await sleep(rand(CFG.DELAY_MIN, CFG.DELAY_MAX));
            }
        };
        await Promise.all(Array.from({ length: Math.min(S.cap, todo.length) }, (_, i) => worker(i + 1)));
    }
    async function run() {
        if (S.busy) return;
        const base = S.items.filter((i) => i.status === 'queued' && i.sel);
        if (!base.length) { log('Нечего скачивать: отметьте файлы галочками.', 'warn'); return; }
        if (!S.dir) { log('Сначала выберите папку.', 'err'); return; }
        try {
            let p = await S.dir.queryPermission({ mode: 'readwrite' });
            if (p !== 'granted') p = await S.dir.requestPermission({ mode: 'readwrite' });
            if (p !== 'granted') { log('Нет доступа на запись в выбранную папку.', 'err'); return; }
        } catch (e) { log('Не удалось проверить доступ к папке: ' + e.message, 'err'); return; }
        S.busy = 'run'; S.stop = false; S.pause = false; S.note = ''; S.screen = 'dl'; ui.thanks.hidden = true; syncUI();
        if (ui.guide) { ui.guide.textContent = 'Идёт загрузка — вкладку можно свернуть или переключиться: процесс продолжится в фоне.'; ui.guide.className = 'guide'; }
        const t0 = Date.now();
        S.runStart = t0; S.samples = [];
        S.cap = modeSafe() ? Math.min(3, ST.conc) : ST.conc;
        S.effConc = modeSafe() ? 1 : S.cap;
        S.lastRateLimit = 0; S.lastDown = 0; S.lastRaise = t0; S.lastProblem = t0;
        S.tickId = setInterval(tick, 1000); tick();
        const todo = orderTodo(base);
        const mName = ST.mode === 'custom' ? 'Кастом' : MODES[ST.mode].name;
        log(`Старт: файлов ${todo.length}. Режим: ${mName} · потоков ${S.effConc} из ${S.cap} · зависание ${ST.stall} с · мин. скорость ${ST.minSpeed ? ST.minSpeed + ' КБ/с' : 'выкл'}`);
        await runPass(todo);
        for (let pass = 1; ST.autoRetry && !S.stop && pass <= CFG.AUTO_PASSES; pass++) {
            const bad = orderTodo(S.items.filter((i) => i.status === 'failed' && i.sel && !i.noRetry));
            if (!bad.length) break;
            for (let s = CFG.AUTO_DELAY_S; s > 0 && !S.stop; s--) { S.note = `Автоповтор ${pass}/${CFG.AUTO_PASSES} (${bad.length} файлов) через ${s} с`; await sleep(1000); }
            S.note = '';
            if (S.stop) break;
            log(`Автоповтор ${pass}/${CFG.AUTO_PASSES}: ${bad.length} файлов`, 'warn');
            for (const it of bad) { it.error = ''; it.slowRestarts = 0; setStatus(it, 'queued'); }
            await runPass(bad);
        }
        S.runMs += Date.now() - t0;
        clearInterval(S.tickId); S.note = '';
        S.busy = null; syncUI();
        await finalReport();
    }
    function stopAll() { if (!S.busy) return; S.stop = true; log('Стоп: прерываю текущие загрузки и запросы…', 'warn'); for (const hnd of [...S.handles]) hnd.abort(); syncUI(); }
    function retryFailed() {
        if (S.busy) return;
        for (const it of S.items) if (it.status === 'failed') { it.error = ''; it.warn = ''; it.noRetry = false; it.slowRestarts = 0; it.cls = ''; it.sel = true; if (it.ui) it.ui.cb.checked = true; setStatus(it, 'queued'); }
        run();
    }
    const bytesNow = () => S.items.reduce((a, i) => a + (i.status === 'done' ? (i.skipped ? 0 : (i.size || i.got || 0)) : (i.status === 'active' || i.status === 'retry' ? (i.got || 0) : 0)), 0);
    function tick() {
        const now = Date.now();
        if (modeSafe() && S.effConc < S.cap && now - S.lastProblem > CFG.SAFE_RAISE_MS && now - S.lastRaise > CFG.SAFE_RAISE_MS) { S.effConc++; S.lastRaise = now; log(`Бережный режим: потоков теперь ${S.effConc}`, ''); }
        if (ST.auto && !modeSafe() && S.effConc < S.cap && now - S.lastRateLimit > CFG.RAISE_AFTER_MS && now - S.lastRaise > CFG.RAISE_AFTER_MS) { S.effConc++; S.lastRaise = now; log(`Ограничений давно нет: потоков снова ${S.effConc}`); }
        const b = bytesNow();
        S.samples.push({ t: now, b });
        while (S.samples.length > 2 && now - S.samples[0].t > 15000) S.samples.shift();
        const a0 = S.samples[0], dt = (now - a0.t) / 1000;
        const speed = dt > 0 ? Math.max(0, (b - a0.b) / dt) : 0;
        S.avgSpeed = speed;
        const act = S.items.filter((i) => i.status === 'active');
        let remaining = 0, selTotal = 0;
        for (const i of S.items) { if (!i.sel) continue; selTotal += i.size || 0; if (i.status === 'queued' || i.status === 'active' || i.status === 'retry') remaining += Math.max(0, (i.size || 0) - (i.got || 0)); }
        const pctNow = selTotal > 0 ? Math.min(99, Math.round((b / selTotal) * 100)) : 0;
        ui.miniBar.value = pctNow;
        ui.miniText.textContent = `${pctNow}% · ${fmtSize(speed)}/с`;
        ui.activeBox.replaceChildren(...act.slice(0, 6).map((i) => { const pct = i.total > 0 ? Math.min(100, Math.round((i.got / i.total) * 100)) : null; const el = Math.max(1, Math.round((now - i.t0) / 1000)); return h('div', '', `▶ ${i.orig} — ${pct != null ? pct + '% · ' : ''}${i.phase || ''} · ${el} с`); }));
        for (const i of act) renderItem(i);
        renderDlScreen();
        if (selTotal > 0) setTitlePrefix(`(${Math.min(99, Math.round((b / selTotal) * 100))}%)`);
    }

    /* ================= ОТЧЁТ И УВЕДОМЛЕНИЯ ================= */
    const count = (st) => S.items.filter((i) => i.status === st && (st !== 'queued' || i.sel)).length;

    function sendNotification(title, body) {
        if (!ST.notify || typeof Notification === 'undefined') return;
        if (!document.hidden || Notification.permission !== 'granted') return;
        try { new Notification(title, { body }); } catch { /* ignore */ }
    }

    async function finalReport() {
        const done = count('done'), failed = count('failed'), left = count('queued');
        const warns = S.items.filter((i) => i.warn).length;
        const nSel = S.items.filter((i) => i.sel).length;
        const noacc = S.items.filter((i) => i.diag === 'noaccess').length;
        log('— ИТОГ —', 'head');
        log(`Время: ${fmtTime(S.runMs)}`);
        log(`Скачано: ${S.items.filter((i) => i.sel && i.status === 'done').length} из ${nSel} выбранных (всего найдено ${S.items.length})`, 'ok');
        const skipped = S.items.filter((i) => i.skipped).length;
        if (skipped) log(`Из них пропущено (уже были в папке): ${skipped}`);
        if (noacc) log(`Недоступно на сервере: ${noacc} (см. отчёт)`, 'warn');
        if (failed) log(`Не скачалось: ${failed} (см. список, кнопка «Повторить сбойные»)`, 'err');
        if (warns) log(`Проверить вручную: ${warns}`, 'warn');
        if (left) log(`Не начато / прервано: ${left} (кнопка «Скачать» продолжит)`, 'warn');
        if (S.stop) log('Остановлено пользователем.', 'warn');
        const avg = S.runMs > 0 ? bytesNow() / (S.runMs / 1000) : 0;
        S.avgSpeed = avg;
        if (!S.stop && !failed && done > 0) showThanks();
        ui.activeBox.replaceChildren();
        setTitlePrefix(S.stop ? '' : (failed ? '⚠' : '✓'));
        if (!S.stop && !failed && done > 0) {
            ui.guide.textContent = '✅ ГОТОВО! Файлы лежат в папке «' + (S.dirName || 'выбранной') + '».';
            ui.guide.className = 'guide ok';
            flashOled();
            sendNotification('YaDLer: готово', `Скачано файлов: ${done}`);
        } else if (failed > 0) {
            ui.guide.textContent = '⚠ Завершено с ошибками. См. отчёт .txt.';
            ui.guide.className = 'guide err';
            sendNotification('YaDLer: Завершено с ошибками', `Скачано: ${done}. Ошибок: ${failed}.`);
        }
        await saveReport();
        if (ST.sound && !S.stop) beep(failed ? 'bad' : 'ok');
    }
    function buildReport() {
        const L = [];
        const section = (title, arr, fmt) => { if (!arr.length) return; L.push('', `${title} (${arr.length}):`, ...arr.map(fmt)); };
        const avgSpeed = S.runMs > 0 ? bytesNow() / (S.runMs / 1000) : 0;
        L.push('YaDLer — отчёт', `Ссылка: ${S.link}`, `Дата: ${new Date().toLocaleString('ru-RU')}`, `Режим: ${ST.mode === 'custom' ? 'Кастом' : MODES[ST.mode].name}`, `Время работы: ${fmtTime(S.runMs)}`, `Найдено файлов: ${S.items.length}, выбрано: ${S.items.filter((i) => i.sel).length}, скачано: ${count('done')}`, `Скачано данных: ${fmtSize(bytesNow())}, средняя скорость: ${fmtSize(avgSpeed)}/с`);
        section('НЕТ ДОСТУПА НА СЕРВЕРЕ (ДИАГНОСТИКА)', S.items.filter((i) => i.diag === 'noaccess'), (i) => `${i.orig}  |  ${fmtSize(i.size)}  |  ${i.diagMsg}`);
        section('НЕ СКАЧАЛИСЬ', S.items.filter((i) => i.status === 'failed'), (i) => `${i.orig}  |  ${fmtSize(i.size)}  |  ${CLS_TEXT[i.cls] || CLS_TEXT.other}: ${i.error}`);
        const failedItems = S.items.filter((i) => i.status === 'failed');
        if (failedItems.length) { const by = {}; for (const i of failedItems) { const k = CLS_TEXT[i.cls] || CLS_TEXT.other; by[k] = (by[k] || 0) + 1; } L.push('', 'Причины сбоев:', ...Object.entries(by).map(([k, v]) => `  ${k}: ${v}`)); }
        section('ПОВРЕЖДЕНЫ В ЛОКАЛЬНОЙ ПАПКЕ', S.items.filter((i) => i.local === 'corrupt'), (i) => `${i.orig}  |  ${fmtSize(i.size)}  |  хеш не совпал`);
        section('ПРОВЕРИТЬ ВРУЧНУЮ', S.items.filter((i) => i.warn), (i) => `${i.orig}  |  ${i.warn}`);
        section('НЕ НАЧАТЫ / ПРЕРВАНЫ', S.items.filter((i) => i.status === 'queued' && i.sel), (i) => `${i.orig}  |  ${fmtSize(i.size)}`);
        section('ИМЕНА ИЗ СПИСКА, КОТОРЫХ НЕТ НА ДИСКЕ', S.namesMissing, (n) => n);
        const ver = S.items.filter((i) => i.notes.includes('SHA-256 ✓')).length;
        if (ver) L.push('', `Проверено по SHA-256: ${ver}`);
        L.push('');
        return L.join('\r\n');
    }
    function triggerSave(blob, filename) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.rel = 'noopener'; document.documentElement.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
    async function saveReport(force) {
        if (!ST.report && !force) return false;
        if (!S.items.length) return false;

        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
        const name = `_yadler_report_${stamp}.txt`;
        const text = '\ufeff' + buildReport();

        if (S.dir) {
            try {
                let target = S.dir;
                let where = 'выбранную папку';

                const root = ST.subfolders && S.rootName ? S.rootName : '';

                if (root) {
                    try {
                        target = await S.dir.getDirectoryHandle(root, { create: true });
                        where = `папку «${root}»`;
                    } catch (e) {
                        log('Не удалось положить отчёт в корневую папку «' + root + '»: ' + e.message + '. Сохраняю в выбранную папку.', 'warn');
                    }
                } else {
                    const doneItems = S.items.filter((i) => i.sel && (i.status === 'done' || i.skipped));
                    if (ST.subfolders && doneItems.length) {
                        const roots = [...new Set(doneItems.map((i) => (i.name.includes('/') ? i.name.split('/')[0] : '')).filter(Boolean))];
                        if (roots.length === 1) {
                            target = await S.dir.getDirectoryHandle(roots[0], { create: true });
                            where = `папку «${roots[0]}»`;
                        }
                    }
                }

                const fh = await target.getFileHandle(name, { create: true });
                const w = await fh.createWritable();
                await w.write(text);
                await w.close();

                log(`Отчёт сохранён в ${where}: ${name}`, 'ok');
                return true;
            } catch (e) {
                log('Не удалось записать отчёт в папку: ' + e.message + '. Сохраняю через браузер.', 'warn');
            }
        }

        triggerSave(new Blob([text], { type: 'text/plain;charset=utf-8' }), name);
        log(`Отчёт сохранён через браузер: ${name}`, 'ok');
        return true;
    }

    /* ================= ЗВУК, ТЕМА, ЗАГОЛОВОК ================= */
    let audioCtx = null;
    function ensureAudio() { try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch { } }
    function beep(kind) { try { if (!audioCtx) return; const tones = kind === 'ok' ? [880, 1175] : [330, 262]; tones.forEach((f, i) => { const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.value = f; g.gain.value = 0.06; o.connect(g); g.connect(audioCtx.destination); const t = audioCtx.currentTime + i * 0.28; o.start(t); o.stop(t + 0.22); }); } catch { } }
    function setTitlePrefix(p) { const clean = document.title.replace(/^(\(\d+%\)|✓|⚠) /, ''); document.title = p ? `${p} ${clean}` : clean; }
    function flashOled() {
        const el = (S.screen === 'dl' ? ui.dlScreen : ui.scanScreen);
        if (!el) return;
        el.classList.remove('flash');
        void el.offsetWidth; // перезапуск анимации
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1000);
    }

    /* ================= ИНТЕРФЕЙС ================= */
    const ui = {};
    const LOCAL_TEXT = { ok: 'уже есть в папке', missing: 'нет в папке', size: 'в папке другой размер', corrupt: 'в папке повреждён (хеш не совпал)' };
    const STATUS = { queued: 'в очереди', active: 'скачивается', retry: 'повтор', done: 'готово', failed: 'ошибка' };
    const THEME_ORDER = ['auto', 'light', 'dark'];
    const THEME_ICON = { auto: '◐', light: '☀', dark: '☾' };
    const THEME_TITLE = { auto: 'авто (как в системе)', light: 'светлая', dark: 'тёмная' };
    const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

    const CSS = `
:host {
  all: initial;
  --fs: 13px;
  --pw: 440px;
  --chassis: #E6E6EB;
  --chassis-dark: #D1D1D6;
  --chassis-darker: #BDBDC3;
  --display-bg: #08080A;
  --te-orange: #FF3300;
  --te-orange-dark: #D62B00;
  --te-blue: #0044FF;
  --te-blue-dark: #0038D1;
  --te-dark: #111111;
  --text: #1A1A1A;
  --text-muted: #5C5C64;
  --text-dim: #7A7A82;
  --border: #B5B5BA;
  --border-strong: #9A9AA1;
  --separator: rgba(0,0,0,.08);
  --white: #FFFFFF;
  --ok: #18A058;
  --warn: #FF9F0A;
  --err: #FF3300;
  --radius: 6px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}
:host(.dark) {
  --chassis: #1C1C1E;
  --chassis-dark: #2C2C2E;
  --chassis-darker: #3A3A3C;
  --text: #F2F2F7;
  --text-muted: #C7C7CC;
  --text-dim: #9A9AA1;
  --border: #48484A;
  --border-strong: #5A5A5E;
  --separator: rgba(255,255,255,.08);
  --white: #2C2C2E;
  --te-orange: #FF453A;
  --te-blue: #0A84FF;
  --te-dark: #F2F2F7;
  --ok: #30D158;
  --warn: #FF9F0A;
  --err: #FF453A;
}
:host(.fs-a) { --fs: 12px; }
:host(.fs-aa) { --fs: 13px; }
:host(.fs-aaa) { --fs: 15px; }

[hidden] { display: none !important; }
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }

.panel {
  position: fixed;
  top: 12px;
  right: 12px;
  width: var(--pw);
  max-height: calc(100vh - 24px);
  display: flex;
  flex-direction: column;
  background: var(--chassis);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.55),
    0 24px 50px rgba(0,0,0,.45),
    0 0 0 1px rgba(0,0,0,.10);
  font-family: var(--font);
  font-size: var(--fs);
  line-height: 1.35;
  z-index: 2147483647;
  overflow: hidden;
}
:host(.dark) .panel {
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.06),
    0 24px 50px rgba(0,0,0,.65),
    0 0 0 1px rgba(255,255,255,.06);
}

.resize-grip {
  position: absolute;
  top: 52px;
  bottom: 12px;
  width: 10px;
  cursor: ew-resize;
  z-index: 6;
  touch-action: none;
}
.resize-grip.gl { left: -5px; }
.resize-grip.gr { right: -5px; }
.resize-grip::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 3px;
  height: 28px;
  border-radius: 2px;
  background: var(--border);
  opacity: .45;
  transition: opacity .12s ease, background .12s ease;
}
.resize-grip:hover::after { opacity: 1; background: var(--te-orange); }

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border-bottom: 1px solid var(--separator);
  background: var(--chassis-dark);
  cursor: grab;
  user-select: none;
  touch-action: none;
  min-height: 46px;
}
.head.drag { cursor: grabbing; }
.head { flex-wrap: wrap; row-gap: 6px; }
.tools { margin-left: auto; }

.brand { display: flex; align-items: baseline; gap: 6px; flex: 1 1 auto; }
.brand strong {
  font-family: var(--mono);
  font-size: calc(var(--fs) * 1.0);
  font-weight: 800;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--text);
  white-space: nowrap;
}
.brand .ver {
  font-family: var(--mono);
  font-size: calc(var(--fs) * 0.78);
  color: var(--te-orange);
  font-weight: 700;
  letter-spacing: .04em;
  white-space: nowrap;
}

.view-mini {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  height: 28px;
  flex-shrink: 0;
  background: var(--white);
}
.vm-btn {
  border: 0;
  background: transparent;
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: calc(var(--fs) * 0.78);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .06em;
  padding: 0 9px;
  cursor: pointer;
  line-height: 28px;
}
.vm-btn.active { background: var(--te-dark); color: #fff; }
:host(.dark) .vm-btn.active { background: var(--text); color: var(--chassis); }

.tools { display: flex; gap: 4px; align-items: center; flex-shrink: 0; }
.tool {
  width: 28px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: linear-gradient(180deg, var(--white), var(--chassis));
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: calc(var(--fs) * 1.0);
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.55), 0 1px 2px rgba(0,0,0,.08);
  padding: 0;
}
.tool:hover { color: var(--text); border-color: var(--border-strong); }
.tool:active { transform: translateY(1px); }
.tool.upd {
  color: var(--te-orange);
  border-color: rgba(255,51,0,.35);
  animation: ydpulse 1.2s ease-in-out infinite;
}
@keyframes ydpulse {
  0%,100% { box-shadow: 0 0 0 0 rgba(255,51,0,0); }
  50% { box-shadow: 0 0 7px 1px rgba(255,51,0,.65); }
}
  .oled.flash { animation: oledflash .9s ease; }
@keyframes oledflash {
  0%   { box-shadow: inset 0 2px 10px rgba(0,0,0,.85), 0 0 0 0 rgba(255,51,0,0); }
  35%  { box-shadow: inset 0 2px 10px rgba(0,0,0,.85), 0 0 0 2px var(--te-orange), 0 0 22px rgba(255,51,0,.55); }
  100% { box-shadow: inset 0 2px 10px rgba(0,0,0,.85), 0 0 0 0 rgba(255,51,0,0); }
}
.font-cycle { font-weight: 800; }

.body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 12px;
  gap: 10px;
  overflow: auto;
  scrollbar-width: thin;
}
.collapsed .body { display: none; }
.collapsed { width: auto !important; min-width: 260px; }

.cols { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.col-main { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.col-detail { display: none; flex-direction: column; gap: 10px; min-width: 0; }
.panel.detail .col-detail { display: flex; }
/* Две колонки включаются только когда реально влезают (класс two-col ставит applyPos) */
.panel.detail.two-col .body { overflow: hidden; }
.panel.detail.two-col .cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 0.86fr);
  gap: 12px;
  align-items: stretch;
  flex: 1;
  min-height: 0;
}
.panel.detail.two-col .col-main,
.panel.detail.two-col .col-detail { overflow: auto; min-height: 0; scrollbar-width: thin; }
.panel.detail.two-col .col-detail { display: flex; }

.mini { display: none; padding: 8px 10px; border-bottom: 1px solid var(--separator); }
.collapsed .mini { display: block; }
.mini progress {
  width: 100%; height: 5px; border: 1px solid var(--border);
  border-radius: 999px; appearance: none; -webkit-appearance: none;
  background: var(--chassis-dark); overflow: hidden;
}
.mini progress::-webkit-progress-bar { background: var(--chassis-dark); }
.mini progress::-webkit-progress-value { background: var(--te-orange); }
.mini progress::-moz-progress-bar { background: var(--te-orange); }
.mini .summary {
  margin-top: 4px; font-family: var(--mono);
  font-size: calc(var(--fs) * 0.8); color: var(--text-dim);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.source-bar { display: grid; grid-template-columns: 1fr 34px; gap: 6px; }
.source-field {
  min-width: 0; background: var(--white); border: 1px solid var(--border);
  border-radius: 6px; padding: 7px 9px;
  box-shadow: inset 0 1px 3px rgba(0,0,0,.05);
  display: flex; flex-direction: column; gap: 2px;
}
.source-label {
  font-family: var(--mono); font-size: calc(var(--fs) * 0.7);
  font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--text-dim);
}
.source-value {
  font-family: var(--mono); font-size: calc(var(--fs) * 0.95);
  font-weight: 600; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.btn-icon {
  width: 34px; height: 34px; border: 1px solid var(--border); border-radius: 6px;
  background: linear-gradient(180deg, var(--white), var(--chassis));
  color: var(--text); font-size: 15px;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; box-shadow: 0 2px 0 var(--border); padding: 0;
}
.btn-icon:hover { border-color: var(--border-strong); }
.btn-icon:active { transform: translateY(2px); box-shadow: none; }

.guide {
  color: var(--text-muted); font-size: calc(var(--fs) * 0.92);
  line-height: 1.35; min-height: 1.2em;
}
.guide::before { content: '▸ '; color: var(--te-orange); }
.guide.ok { color: var(--ok); } .guide.ok::before { color: var(--ok); }
.guide.warn { color: var(--warn); } .guide.warn::before { color: var(--warn); }
.guide.err { color: var(--err); } .guide.err::before { color: var(--err); }

.action-grid { display: grid; grid-template-columns: 1.15fr 0.85fr 0.95fr; gap: 6px; }
.te-btn {
  border: none; border-radius: 6px; padding: 10px 8px;
  font-family: var(--font); font-size: calc(var(--fs) * 0.95);
  font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: #fff;
  cursor: pointer; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.18), 0 2px 0 rgba(0,0,0,.16), 0 6px 14px rgba(0,0,0,.12);
  transition: transform .06s ease, filter .12s ease, box-shadow .06s ease;
}
.te-btn:hover { filter: brightness(1.04); }
.te-btn:active { transform: translateY(2px); box-shadow: inset 0 1px 0 rgba(255,255,255,.12); }
.te-btn:disabled { opacity: .45; cursor: default; transform: none; filter: none; }
.btn-scan { background: linear-gradient(180deg, #FF4A1F 0%, var(--te-orange) 100%); }
.btn-stop {
  background: linear-gradient(180deg, var(--white) 0%, var(--chassis-dark) 100%);
  color: var(--text); border: 1px solid var(--border);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.55), 0 2px 0 var(--border);
}
.btn-stop:active { box-shadow: inset 0 1px 0 rgba(255,255,255,.35); }
.btn-resume { background: linear-gradient(180deg, #22C55E 0%, var(--ok) 100%); color: #fff; border: none; }
.btn-check { background: linear-gradient(180deg, #2A2A2E 0%, #111114 100%); }

.download-deck { display: grid; grid-template-columns: 1.05fr 1.45fr; gap: 6px; }
.btn-download { background: linear-gradient(180deg, #2D62FF 0%, var(--te-blue) 100%); font-size: calc(var(--fs) * 1.0); }
.speed-panel {
  background: var(--white); border: 1px solid var(--border); border-radius: 6px;
  padding: 3px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px;
  box-shadow: inset 0 1px 3px rgba(0,0,0,.05);
}
.speed-btn {
  border: none; background: transparent; border-radius: 4px; padding: 7px 4px;
  font-family: var(--mono); font-size: calc(var(--fs) * 0.82); font-weight: 700;
  letter-spacing: .05em; text-transform: uppercase; color: var(--text-dim);
  cursor: pointer; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.speed-btn:hover { color: var(--text); background: rgba(0,0,0,.04); }
:host(.dark) .speed-btn:hover { background: rgba(255,255,255,.06); }
.speed-btn.active { background: var(--te-dark); color: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.2); }
:host(.dark) .speed-btn.active { background: var(--text); color: var(--chassis); }

.oled {
  background:
    radial-gradient(circle at top left, rgba(255,255,255,.06), transparent 35%),
    linear-gradient(180deg, #0C0C10 0%, var(--display-bg) 100%);
  border: 1px solid #000; border-radius: 7px; padding: 11px 12px 10px;
  box-shadow: inset 0 2px 10px rgba(0,0,0,.85), 0 1px 0 rgba(255,255,255,.35);
  font-family: var(--mono); color: #fff; position: relative; overflow: hidden;
}
.oled::after {
  content: ''; position: absolute; inset: 0;
  background: repeating-linear-gradient(to bottom, rgba(255,255,255,.02) 0px, rgba(255,255,255,.02) 1px, transparent 1px, transparent 3px);
  pointer-events: none; opacity: .35;
}
.status-row {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  font-size: calc(var(--fs) * 0.82); text-transform: uppercase; letter-spacing: .07em;
  margin-bottom: 8px; position: relative; z-index: 1;
}
.status-badge { color: var(--te-orange); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status-badge.ok { color: #30D158; }
.status-badge.warn { color: #FF9F0A; }
.status-badge.err { color: #FF453A; }
.status-eta { color: #C2C2C8; white-space: nowrap; cursor: help; font-weight: 600; transition: color .2s ease; }
.status-eta.stale { color: #55555C; font-weight: 500; }
.progress-value {
  font-size: calc(var(--fs) * 2.05); line-height: 1; font-weight: 700;
  letter-spacing: -.04em; color: #fff; margin-bottom: 4px; position: relative; z-index: 1;
}
.progress-value .unit { font-size: calc(var(--fs) * 0.95); color: #9A9AA1; letter-spacing: 0; margin-left: 3px; }
.progress-sub {
  font-size: calc(var(--fs) * 0.88); color: #C8C8CE; text-transform: uppercase;
  letter-spacing: .06em; margin-bottom: 9px; position: relative; z-index: 1;
}
.progress-sub b { color: var(--te-orange); font-weight: 700; }
.bar {
  height: 5px; background: #1D1D22; border-radius: 999px; overflow: hidden;
  margin-bottom: 10px; position: relative; z-index: 1; box-shadow: inset 0 1px 2px rgba(0,0,0,.7);
}
.bar i {
  display: block; height: 100%; width: 0%;
  background: linear-gradient(90deg, #FF6A3D 0%, var(--te-orange) 100%);
  box-shadow: 0 0 10px rgba(255,51,0,.55); border-radius: 999px; transition: width .2s ease;
}
.screen-footer {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;
  font-size: calc(var(--fs) * 0.82); color: #9A9AA1; text-transform: uppercase;
  letter-spacing: .07em; position: relative; z-index: 1;
}
.screen-footer span { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.screen-footer b { color: #E8E8EC; font-weight: 700; }
.screen-footer b.bad { color: #FF453A; }
.screen-footer b.good { color: #30D158; }
.scan-now {
  font-size: calc(var(--fs) * 0.78); color: #9A9AA1; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; margin-top: 8px; position: relative; z-index: 1;
}

.matrix-label {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  font-family: var(--mono); font-size: calc(var(--fs) * 0.8); font-weight: 700;
  letter-spacing: .09em; text-transform: uppercase; color: var(--text-dim); margin: 4px 0 7px;
}
.matrix-label .hint { color: var(--te-orange); font-size: calc(var(--fs) * 0.72); letter-spacing: .07em; }
.file-matrix { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.matrix-cell {
  min-height: 56px; background: var(--white); border: 1px solid var(--border); border-radius: 6px;
  padding: 8px; display: flex; align-items: center; justify-content: space-between; gap: 6px;
  cursor: pointer; user-select: none;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.55), 0 1px 0 rgba(0,0,0,.05);
  transition: transform .06s ease, border-color .12s ease, background .12s ease, opacity .12s ease;
}
.matrix-cell:hover { border-color: var(--border-strong); }
.matrix-cell:active { transform: translateY(1px); }
.matrix-cell .meta { min-width: 0; }
.matrix-cell .type-label {
  display: block; font-family: var(--mono); font-size: calc(var(--fs) * 0.74); font-weight: 700;
  letter-spacing: .07em; text-transform: uppercase; color: var(--text-dim); margin-bottom: 3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.matrix-cell .type-count {
  display: block; font-family: var(--mono); font-size: calc(var(--fs) * 1.3); line-height: 1;
  font-weight: 800; color: var(--text-dim);
}
.matrix-cell .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--chassis-darker); flex-shrink: 0; }
.matrix-cell.has-files { border-color: var(--border-strong); }
.matrix-cell.has-files .type-label { color: var(--text); }
.matrix-cell.has-files .type-count { color: var(--text); }
.matrix-cell.has-files .dot { background: var(--te-orange); box-shadow: 0 0 7px rgba(255,51,0,.55); }
.matrix-cell.off { opacity: .62; }
.matrix-cell.off .type-count { color: var(--text-dim); text-decoration: line-through; }
.matrix-cell.off .dot { background: var(--chassis-darker); box-shadow: none; }

.utility-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
.btn-sub {
  border: 1px solid var(--border); border-radius: 5px;
  background: linear-gradient(180deg, rgba(255,255,255,.75), rgba(255,255,255,.35));
  color: var(--text-muted); font-family: var(--mono); font-size: calc(var(--fs) * 0.8);
  font-weight: 700; letter-spacing: .07em; text-transform: uppercase; padding: 8px 4px;
  cursor: pointer; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: all .08s ease; box-shadow: inset 0 1px 0 rgba(255,255,255,.55);
}
:host(.dark) .btn-sub { background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02)); box-shadow: inset 0 1px 0 rgba(255,255,255,.05); }
.btn-sub:hover { color: var(--text); border-color: var(--border-strong); background: var(--white); }
.btn-sub:active { transform: translateY(1px); background: var(--chassis-dark); }
.btn-sub:disabled { opacity: .45; cursor: default; }

.row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.list-empty {
  border: 1px dashed var(--border); border-radius: 6px; padding: 14px 10px;
  text-align: center; color: var(--text-muted); font-size: calc(var(--fs) * 0.9);
}
ul {
  list-style: none; margin: 0; padding: 0; overflow: auto; min-height: 120px; max-height: 46vh;
  border: 1px solid var(--border); border-radius: 6px; background: var(--white);
  scrollbar-gutter: stable;
}
li { display: flex; gap: 8px; align-items: flex-start; padding: 6px 8px 6px 9px; border-bottom: 1px solid var(--separator); border-left: 2px solid var(--border); }
li:hover { background: rgba(0,0,0,.035); }
:host(.dark) li:hover { background: rgba(255,255,255,.04); }
li:last-child { border-bottom: 0; }
li > input { margin-top: 2px; accent-color: var(--te-orange); }
li .content { flex: 1; min-width: 0; }
li { padding-left: calc(9px + var(--d, 0) * 12px); }
ul.flat li { padding-left: 9px; }
.name .full { display: none; }
ul.flat .name .short { display: none; }
ul.flat .name .full { display: inline; }
li.grp { background: var(--chassis-dark); border-left-color: var(--text-muted); align-items: center; position: sticky; top: 0; z-index: 3; }
li.grp .fold { border: 0; background: none; padding: 0; text-align: left; font-weight: 700; overflow-wrap: anywhere; flex: 1; color: var(--text); font-size: calc(var(--fs) * 0.95); text-transform: uppercase; letter-spacing: .03em; cursor: pointer; }
li.active { border-left-color: var(--te-orange); }
li.done { border-left-color: var(--ok); }
li.retry { border-left-color: var(--warn); }
li.failed { border-left-color: var(--err); }
.name { overflow-wrap: anywhere; font-size: calc(var(--fs) * 0.98); color: var(--text); }
.meta { color: var(--text-muted); font-size: calc(var(--fs) * 0.85); margin-top: 2px; font-variant-numeric: tabular-nums; }
li.done .meta { color: var(--ok); }
li.failed .meta { color: var(--err); }
li.retry .meta { color: var(--warn); }
.only-bad li.queued, .only-bad li.active, .only-bad li.done, .only-bad li.grp { display: none; }
ul.busy input { pointer-events: none; opacity: .5; }

.log {
  height: 150px; min-height: 90px; overflow: auto; background: var(--display-bg); color: #f5f5f5;
  border: 1px solid #000; border-radius: 6px; padding: 8px 10px;
  font-size: calc(var(--fs) * 0.88); line-height: 1.45; font-family: var(--mono); flex-shrink: 0;
}
.log div.ok { color: #7EE2A0; }
.log div.warn { color: #FFC46B; }
.log div.err { color: #FF9A94; }
.log div.head { color: #fff; font-weight: 700; }

details { border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; background: var(--white); }
summary { cursor: pointer; color: var(--text-muted); font-size: calc(var(--fs) * 0.9); font-weight: 700; text-transform: uppercase; letter-spacing: .05em; padding: 4px 0; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary::before { content: "▸"; display: inline-block; margin-right: 6px; transition: transform .15s ease; font-size: calc(var(--fs) * 0.78); }
details[open] > summary::before { transform: rotate(90deg); }
.adv-note { color: var(--text-muted); font-size: calc(var(--fs) * 0.88); padding: 4px 0 6px; border-bottom: 1px solid var(--separator); margin-bottom: 6px; }

.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; padding: 8px 0 4px; }
label.chk { color: var(--text); display: flex; align-items: center; gap: 6px; font-size: calc(var(--fs) * 0.95); }
label.chk input[type=checkbox] { width: 14px; height: 14px; accent-color: var(--te-orange); cursor: pointer; flex-shrink: 0; }
.chk-row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.chk-row label.chk { margin: 0; }
select, input[type=search], input[type=text], input[type=password] {
  font-size: calc(var(--fs) * 0.95); font-family: var(--mono); padding: 6px 8px;
  border: 1px solid var(--border); border-radius: 5px; background: var(--white); color: var(--text);
  letter-spacing: .02em; line-height: 1.3;
}
input[type=search] { flex: 1; min-width: 100px; }
textarea {
  width: 100%; margin: 8px 0; padding: 8px; font-size: calc(var(--fs) * 0.9); line-height: 1.45;
  font-family: var(--mono); border: 1px solid var(--border); border-radius: 5px; resize: vertical;
  background: var(--white); color: var(--text);
}
button { font-family: var(--font); font-size: calc(var(--fs) * 0.95); padding: 6px 10px; border: 1px solid var(--border); border-radius: 5px; background: var(--white); color: var(--text); cursor: pointer; line-height: 1.2; }
button:hover { border-color: var(--border-strong); }
button:disabled { opacity: .45; cursor: default; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--te-blue); outline-offset: 1px; }
button.okflash { background: var(--ok) !important; border-color: var(--ok) !important; color: #fff !important; }
button.primary { background: var(--te-orange); border-color: var(--te-orange); color: #fff; font-weight: 700; }
button.primary:hover { background: var(--te-orange-dark); }

.actbox div { font-size: calc(var(--fs) * 0.88); line-height: 1.45; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.foot {
  color: var(--text-dim); font-size: calc(var(--fs) * 0.85); line-height: 1.45;
  border-top: 1px solid var(--separator); padding-top: 8px; margin-top: 2px;
}
.foot a { color: var(--te-orange); text-decoration: none; font-weight: 600; }
.foot a:hover { text-decoration: underline; }
.foot .repo { display: block; margin-top: 4px; font-family: var(--mono); font-size: calc(var(--fs) * 0.8); }

.promo { background: var(--white); border: 1px solid var(--border); border-radius: 6px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.promo-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.promo-title-wrap { flex: 1; min-width: 0; }
.promo-title { font-size: calc(var(--fs) * 0.95); font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--text); margin: 0; line-height: 1.25; }
.promo-subtitle { font-size: calc(var(--fs) * 0.88); color: var(--text-muted); margin: 3px 0 0; line-height: 1.3; }
.promo-close { border: 1px solid var(--border); background: var(--chassis); width: 22px; height: 22px; border-radius: 5px; padding: 0; font-size: calc(var(--fs) * 1.1); line-height: 1; color: var(--text-muted); cursor: pointer; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; }
.promo-close:hover { background: var(--white); color: var(--text); }
.promo-section { display: flex; flex-direction: column; gap: 5px; }
.promo-label { font-family: var(--mono); font-size: calc(var(--fs) * 0.74); font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--text-dim); margin: 0; }
.promo-divider { height: 1px; background: var(--separator); margin: 0; border: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { padding: 4px 9px; border: 1px solid var(--border); border-radius: 5px; background: var(--chassis); color: var(--text); text-decoration: none; font-family: var(--mono); font-size: calc(var(--fs) * 0.85); font-weight: 700; letter-spacing: .04em; text-transform: uppercase; display: inline-flex; align-items: center; cursor: pointer; line-height: 1; }
.chip:hover { background: var(--white); border-color: var(--border-strong); }
.chip.accent { background: var(--te-orange); border-color: var(--te-orange); color: #fff; }
.chip.accent:hover { background: var(--te-orange-dark); border-color: var(--te-orange-dark); }
.chip.accent.full { width: 100%; justify-content: center; padding: 7px 10px; }
.thanks { background: var(--white); border: 1px solid var(--ok); border-radius: 6px; padding: 9px 10px; display: flex; flex-direction: column; gap: 7px; }
.thanks-text { font-size: calc(var(--fs) * 0.95); color: var(--text); font-weight: 700; letter-spacing: .03em; text-transform: uppercase; line-height: 1.35; }
.field { display: block; margin: 8px 0; color: var(--text-muted); font-size: calc(var(--fs) * 0.9); }
.field input { display: block; width: 100%; margin-top: 4px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 5px; font-size: calc(var(--fs) * 0.9); font-family: var(--mono); background: var(--white); color: var(--text); line-height: 1.3; }
.log-tools { display: flex; }
.log-tools button { flex: 1; }
`;


    function mkSelect(label, opts, key, isNum, live) {
        const l = h('label', 'chk', label + ' ');
        const el = document.createElement('select');
        for (const [v, t] of opts) { const o = document.createElement('option'); o.value = String(v); o.textContent = t; el.append(o); }
        el.value = String(ST[key]);
        ui.ctl = ui.ctl || {}; ui.ctl[key] = el;
        el.addEventListener('change', () => { ST[key] = isNum ? Number(el.value) : el.value; saveSettings(); markCustom(key); log(`${label}: ${el.selectedOptions[0].textContent}`); if (!live) syncUI(); });
        l.append(el);
        return { l, el };
    }
    function mkCheck(label, key) {
        const l = h('label', 'chk');
        const el = document.createElement('input'); el.type = 'checkbox'; el.checked = !!ST[key];
        ui.ctl = ui.ctl || {}; ui.ctl[key] = el;
        el.addEventListener('change', () => { ST[key] = el.checked; saveSettings(); markCustom(key); log(`${label}: ${el.checked ? 'вкл' : 'выкл'}`); });
        l.append(el, document.createTextNode(' ' + label));
        return { l, el };
    }
    function syncSettingsUI() {
        const c = ui.ctl || {};
        if (c.conc) c.conc.value = String(ST.conc);
        if (c.stall) c.stall.value = String(ST.stall);
        if (c.minSpeed) c.minSpeed.value = String(ST.minSpeed);
        if (c.auto) c.auto.checked = !!ST.auto;
        if (c.autoRetry) c.autoRetry.checked = !!ST.autoRetry;
        if (c.verify) c.verify.checked = !!ST.verify;
        if (c.fixPartial) c.fixPartial.checked = !!ST.fixPartial;
        if (c.report) c.report.checked = !!ST.report;
        if (c.autoScan) c.autoScan.checked = !!ST.autoScan;
        if (c.autoDiag) c.autoDiag.checked = !!ST.autoDiag;
        if (c.rememberDir) c.rememberDir.checked = !!ST.rememberDir;
        if (c.subfolders) c.subfolders.checked = !!ST.subfolders;
        if (c.skipExisting) c.skipExisting.checked = !!ST.skipExisting;
        if (c.sound) c.sound.checked = !!ST.sound;
        if (c.notify) c.notify.checked = !!ST.notify;
    }
    const MB = 1024 * 1024;
    function passes(it) {
        if (ui.onlySel && ui.onlySel.checked && !it.sel) return false;
        const q = ui.filter ? ui.filter.value.trim().toLowerCase() : '';
        if (q && !it.orig.toLowerCase().includes(q)) return false;
        if (!ST.types[groupOf(extOf(it.orig))]) return false;
        const s = ui.fsize ? ui.fsize.value : 'any', sz = it.size || 0;
        if (s === 'gt1' && !(sz > MB)) return false;
        if (s === 'gt10' && !(sz > 10 * MB)) return false;
        if (s === 'gt100' && !(sz > 100 * MB)) return false;
        if (s === 'lt1' && !(sz < MB)) return false;
        return true;
    }
    function applyVisibility() {
        for (const it of S.items) { it.filtered = passes(it); it.collapsedHide = false; }
        if (S.mode === 'tree') for (const g of S.groups) if (g.collapsed) for (const it of g.items) it.collapsedHide = true;
        for (const it of S.items) { const hide = !it.filtered || it.collapsedHide; if (it.ui && it.ui.li.hidden !== hide) it.ui.li.hidden = hide; }
        for (const g of S.groups) { let hid = S.mode !== 'tree' || !g.items.some((i) => i.filtered); for (let p = g.parent; p && !hid; p = p.parent) if (p.collapsed) hid = true; if (g.li.hidden !== hid) g.li.hidden = hid; }
    }
    const RANK = { failed: 0, retry: 1, active: 2, queued: 3, done: 4 };
    function applySort(mode) {
        S.mode = mode;
        const tree = mode === 'tree';
        ui.list.classList.toggle('flat', !tree);
        if (tree) ui.list.append(...S.treeOrder);
        else {
            const arr = [...S.items];
            if (mode === 'size-desc') arr.sort((a, b) => (b.size || 0) - (a.size || 0));
            else if (mode === 'size-asc') arr.sort((a, b) => (a.size || 0) - (b.size || 0));
            else if (mode === 'name') arr.sort((a, b) => collator.compare(a.orig, b.orig));
            else if (mode === 'status') arr.sort((a, b) => RANK[a.status] - RANK[b.status]);
            ui.list.append(...arr.map((i) => i.ui.li));
        }
        applyVisibility();
    }
    function updateGroups() { for (const g of S.groups) { let n = 0; for (const it of g.items) if (it.sel) n++; g.cb.checked = n === g.items.length && n > 0; g.cb.indeterminate = n > 0 && n < g.items.length; g.fold.textContent = `${g.collapsed ? '▸' : '▾'} ${g.base}  ·  ${n}/${g.items.length}`; } }

    /* --- экранчики --- */
    function buildScanScreen() {
        const box = h('div', 'oled');

        const statusRow = h('div', 'status-row');
        ui.statusBadge = h('div', 'status-badge', '● Ожидание');
        ui.tEta = h('div', 'status-eta', 'ETA: —');
        ui.tEta.title = 'Ориентировочное время. Точное появится после начала скачивания.';
        statusRow.append(ui.statusBadge, ui.tEta);

        ui.wMain = h('div', 'progress-value', '—');
        ui.wSub = h('div', 'progress-sub', 'выбрано / всего');

        const bar = h('div', 'bar');
        ui.barFill = h('i');
        bar.append(ui.barFill);

        const footer = h('div', 'screen-footer');
        ui.sDirs = makeFooterCell(footer, 'папок');
        ui.sFiles = makeFooterCell(footer, 'файлов');
        ui.sNoacc = makeFooterCell(footer, 'недоступно');
        ui.sErrs = makeFooterCell(footer, 'ошибки');

        ui.sNow = h('div', 'scan-now');
        ui.sNow.hidden = true;

        const ml = h('div', 'matrix-label');
        ml.append(h('span', '', 'Фильтры'), h('span', 'hint', '[тап]'));

        const matrix = h('div', 'file-matrix');
        ui.typeBtns = {};

        for (const k of ['images', 'video', 'audio', 'docs', 'archives', 'other']) {
            const cell = h('div', 'matrix-cell');
            cell.title = TYPE_RU[k] + ': ' + (TYPES[k] || 'все остальные расширения') + ' · нажмите, чтобы включить/выключать';
            const meta = h('div', 'meta');
            const label = h('span', 'type-label', TYPE_RU[k]);
            const cnt = h('span', 'type-count', '0');
            meta.append(label, cnt);
            const dot = h('span', 'dot');
            cell.append(meta, dot);
            cell.addEventListener('click', () => toggleType(k));
            ui.typeBtns[k] = { cell, cnt, dot };
            matrix.append(cell);
        }

        box.append(statusRow, ui.wMain, ui.wSub, bar, footer, ui.sNow, ml, matrix);
        return { box, cells: {} };
    }

    function makeFooterCell(parent, label) {
        const span = h('span');
        const b = h('b', '0');
        span.append(document.createTextNode(label + ' '), b);
        parent.append(span);
        return { el: span, b, label };
    }
    function toggleType(k) {
        ST.types[k] = !ST.types[k]; saveSettings();
        let n = 0;
        for (const it of S.items) if (groupOf(extOf(it.orig)) === k && it.status !== 'done') { it.sel = ST.types[k]; if (it.ui) it.ui.cb.checked = it.sel; n++; }
        if (ui.onlySel && ui.onlySel.checked) applyVisibility();
        syncUI(); renderScanScreen();
        log(`Тип «${TYPE_RU[k]}»: ${ST.types[k] ? 'включён' : 'выключен'} (${n} файлов)`, ST.types[k] ? 'ok' : 'warn');
    }
    function toggleTypeSilent(k, v) {
        ST.types[k] = v; saveSettings();
        for (const it of S.items) if (groupOf(extOf(it.orig)) === k && it.status !== 'done') { it.sel = v; if (it.ui) it.ui.cb.checked = v; }
    }
    function renderScanScreen() {
        if (!ui.wMain) return;

        const allStats = computeScanStats();
        const selectedItems = liveItems().filter(i => i.sel && i.filtered);
        let selBytes = 0;
        const selTypes = { images: 0, video: 0, audio: 0, docs: 0, archives: 0, other: 0 };

        for (const it of selectedItems) {
            selBytes += it.size || 0;
            selTypes[groupOf(extOf(it.orig))]++;
        }

        if (S.pause && S.busy) {
            ui.statusBadge.textContent = '● Пауза';
            ui.statusBadge.className = 'status-badge warn';
        } else if (S.busy === 'scan') {
            ui.statusBadge.textContent = '● Сканирование';
            ui.statusBadge.className = 'status-badge';
        } else if (S.busy === 'diag') {
            ui.statusBadge.textContent = '● Проверка';
            ui.statusBadge.className = 'status-badge';
        } else if (S.pause) {
            ui.statusBadge.textContent = '● Пауза';
            ui.statusBadge.className = 'status-badge warn';
        } else if (S.scanDone && allStats.files > 0) {
            ui.statusBadge.textContent = '● Готово';
            ui.statusBadge.className = 'status-badge ok';
        } else {
            ui.statusBadge.textContent = '● Ожидание';
            ui.statusBadge.className = 'status-badge';
        }

        const pctSel = allStats.bytes > 0 ? Math.round((selBytes / allStats.bytes) * 100) : 0;
        ui.wMain.innerHTML = fmtSize(selBytes) + ' <span class="unit">выбрано</span>';
        ui.wSub.innerHTML = '<b>' + pctSel + '%</b> из ' + fmtSize(allStats.bytes) + ' всего';
        ui.barFill.style.width = allStats.bytes > 0
            ? Math.min(100, (selBytes / allStats.bytes) * 100) + '%'
            : '0%';

        let etaTxt = 'ETA: —', etaStale = true;
        if (S.busy === 'scan' || S.busy === 'diag') {
            etaTxt = S.busy === 'diag' ? 'проверка…' : 'скан…';
            etaStale = false;
        } else if (selBytes > 0 && S.scanDone) {
            const avgSpeed = S.avgSpeed > 0 ? S.avgSpeed : (5 * 1024 * 1024);
            etaTxt = 'ETA: ~' + fmtTime((selBytes / avgSpeed) * 1000);
            etaStale = false;
        }
        ui.tEta.textContent = etaTxt;
        ui.tEta.className = 'status-eta' + (etaStale ? ' stale' : '');

        if (ui.sNow) {
            const jb = S.job;
            if ((S.busy === 'scan' || S.busy === 'diag') && jb) {
                ui.sNow.hidden = false;
                ui.sNow.textContent = jb.total
                    ? `${jb.label}: ${jb.done} из ${jb.total}`
                    : `Читаю: ${jb.cur || '/'}`;
            } else {
                ui.sNow.hidden = true;
            }
        }

        updateStatVal(ui.sDirs, allStats.dirs);
        updateStatVal(ui.sFiles, allStats.files);
        updateStatVal(ui.sNoacc, allStats.noaccess, true);
        updateStatVal(ui.sErrs, allStats.errs, true);

        if (ui.typeBtns) {
            for (const k of Object.keys(ui.typeBtns)) {
                const t = ui.typeBtns[k];
                const count = allStats.types[k] || 0;
                t.cnt.textContent = String(count);
                t.cell.classList.toggle('has-files', count > 0);
                t.cell.classList.toggle('off', !ST.types[k]);
            }
        }
    }

    function updateStatVal(obj, value, bad) {
        if (!obj) return;
        obj.b.textContent = String(value);
        obj.b.className = bad && value > 0 ? 'bad' : '';
    }
    function buildDlScreen() {
        const box = h('div', 'oled');

        const statusRow = h('div', 'status-row');
        ui.dlStatus = h('div', 'status-badge', '● Ожидание');
        ui.dlEta = h('div', 'status-eta', 'ETA: —');
        ui.dlEta.title = 'Оценка по текущей скорости. После завершения будет точное время.';
        statusRow.append(ui.dlStatus, ui.dlEta);

        ui.dlValue = h('div', 'progress-value', '—');
        ui.dlSub = h('div', 'progress-sub', 'выбрано 0 · 0 Б');

        const bar = h('div', 'bar');
        ui.dlBarFill = h('i');
        bar.append(ui.dlBarFill);

        const footer = h('div', 'screen-footer');
        ui.dlSpeed = makeFooterCell(footer, 'скорость');
        ui.dlLeft = makeFooterCell(footer, 'осталось');
        ui.dlTime = makeFooterCell(footer, 'время');
        ui.dlStreams = makeFooterCell(footer, 'потоки');

        box.append(statusRow, ui.dlValue, ui.dlSub, bar, footer);
        return box;
    }

    function renderDlScreen() {
        if (!ui.dlValue) return;

        const sel = S.items.filter((i) => i.sel);
        const doneSel = sel.filter((i) => i.status === 'done');
        const failed = S.items.filter((i) => i.status === 'failed');
        const queued = sel.filter((i) => i.status === 'queued' || i.status === 'retry');
        const active = S.items.filter((i) => i.status === 'active');
        const total = sel.reduce((a, i) => a + (i.size || 0), 0);
        const got = sel.reduce((a, i) => a + (i.status === 'done' ? (i.size || 0) : (i.got || 0)), 0);
        const left = sel.reduce((a, i) => i.status === 'done' ? a : a + Math.max(0, (i.size || 0) - (i.got || 0)), 0);
        const running = S.busy === 'run';
        const speed = running ? S.avgSpeed : 0;

        if (S.pause) {
            ui.dlStatus.textContent = '● Пауза';
            ui.dlStatus.className = 'status-badge warn';
        } else if (running) {
            ui.dlStatus.textContent = '● Загрузка';
            ui.dlStatus.className = 'status-badge';
        } else if (failed.length > 0) {
            ui.dlStatus.textContent = '● Ошибки';
            ui.dlStatus.className = 'status-badge err';
        } else if (doneSel.length > 0) {
            ui.dlStatus.textContent = '● Готово';
            ui.dlStatus.className = 'status-badge ok';
        } else {
            ui.dlStatus.textContent = '● Ожидание';
            ui.dlStatus.className = 'status-badge';
        }

        let dEta = 'ETA: —', dStale = true;
        if (running) {
            if (speed > 1024 && left > 0) { dEta = 'ETA: ~' + fmtTime((left / speed) * 1000); dStale = false; }
            else { dEta = 'ETA: …'; dStale = true; } // нет данных о скорости — тускнеет
        } else if (S.runMs > 0) {
            dEta = 'Время: ' + fmtTime(S.runMs); dStale = false; // точное время после финиша
        }
        ui.dlEta.textContent = dEta;
        ui.dlEta.className = 'status-eta' + (dStale ? ' stale' : '');

        const pctDl = total > 0 ? Math.round((got / total) * 100) : 0;
        ui.dlValue.innerHTML = fmtSize(got) + ' <span class="unit">скачано</span>';
        ui.dlSub.innerHTML = '<b>' + pctDl + '%</b> из ' + fmtSize(total) + ' · ' + sel.length + ' файлов';
        ui.dlBarFill.style.width = total > 0 ? Math.min(100, (got / total) * 100) + '%' : '0%';

        ui.dlSpeed.b.textContent = running ? fmtSize(speed) + '/с' : '—';
        ui.dlLeft.b.textContent = fmtSize(left);
        ui.dlTime.b.textContent = running ? fmtClock(Date.now() - S.runStart) : (S.runMs ? fmtTime(S.runMs) : '—');
        ui.dlStreams.b.textContent = running ? `${active.length}/${S.effConc}/${S.cap}` : '—';

        if (failed.length > 0) ui.dlStreams.b.className = 'bad';
        else ui.dlStreams.b.className = '';
    }
    function makeScreen(lblText, keys) {
        const box = h('div', 'screen');
        box.append(h('div', 'lbl', lblText));
        const grid = h('div', 'sgrid');
        const cells = {};
        for (const [k, cap] of keys) { const cell = h('div', 'cell'); const val = h('div', 'val', '—'); cell.append(val, h('div', 'cap', cap)); cells[k] = val; grid.append(cell); }
        box.append(grid);
        return { box, cells };
    }
    /* --- список файлов --- */
    function makeRow(it) {
        const li = h('li');
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = it.sel;
        cb.setAttribute('aria-label', 'Скачать ' + it.orig);
        cb.addEventListener('change', () => { it.sel = cb.checked; syncUI(); });
        const box = h('div', 'content');
        const name = h('div', 'name');
        name.title = it.orig;
        name.append(h('span', 'short', baseName(it.orig)), h('span', 'full', it.orig));
        li.style.setProperty('--d', String(it.depth + 1));
        const meta = h('div', 'meta');
        const bar = document.createElement('progress'); bar.max = 100; bar.value = 0; bar.hidden = true;
        bar.style.cssText = 'width:100%;height:6px;margin-top:3px;appearance:none;-webkit-appearance:none;border:1px solid var(--border);border-radius:2px;background:var(--chassis-dark);';
        box.append(name, meta, bar);
        li.append(cb, box);
        it.ui = { li, meta, bar, cb, name };
        renderItem(it);
        return li;
    }
    function makeGroup(dir, parent) {
        const g = { dir, base: baseName(dir), depth: dir.split('/').length - 1, parent, items: [], collapsed: false };
        const li = h('li', 'grp');
        li.style.setProperty('--d', String(g.depth));
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.setAttribute('aria-label', 'Выбрать папку ' + dir);
        cb.addEventListener('change', () => { for (const it of g.items) if (it.filtered && it.status !== 'done') { it.sel = cb.checked; it.ui.cb.checked = cb.checked; } syncUI(); });
        const fold = h('button', 'fold');
        fold.title = dir;
        fold.addEventListener('click', () => { g.collapsed = !g.collapsed; applyVisibility(); updateGroups(); });
        li.append(cb, fold);
        g.li = li; g.cb = cb; g.fold = fold;
        return g;
    }
    function buildList() {
        ui.list.replaceChildren();
        S.groups = []; S.treeOrder = [];
        const byDir = new Map();
        const ensure = (dir) => { if (!dir) return null; if (byDir.has(dir)) return byDir.get(dir); const g = makeGroup(dir, ensure(dirName(dir))); byDir.set(dir, g); S.groups.push(g); S.treeOrder.push(g.li); return g; };
        for (const it of S.items) { ensure(it.dir); const row = makeRow(it); S.treeOrder.push(row); for (let d = it.dir; d; d = dirName(d)) byDir.get(d).items.push(it); }
    }
    function renderItem(it) {
        if (!it.ui) return;
        const { li, meta, bar } = it.ui;
        li.className = it.status;
        let t = `${STATUS[it.status]} · ${fmtSize(it.size)}`;
        if (it.status === 'active' || it.status === 'retry') t += ` · попытка ${it.attempts}/${CFG.MAX_ATTEMPTS}`;
        if (it.local && it.status === 'queued') t += ` · ${LOCAL_TEXT[it.local]}`;
        if (it.slowRestarts) t += ` · перезапусков по скорости ${it.slowRestarts}`;
        if (it.status === 'active') {
            const now = Date.now();
            const el = Math.max(1, Math.round((now - it.t0) / 1000));
            const ago = Math.round((now - (it.last || it.t0)) / 1000);
            t += ` · ${it.phase || ''} · ${el} с`;
            if (it.got > 0) t += ` · ${fmtSize(it.got / el)}/с`;
            if (ago >= 5) t += ` · нет данных ${ago} с (лимит ${ST.stall})`;
        }
        if (it.diag === 'noaccess') t += ` · ⚠ ${it.diagMsg || 'нет доступа на сервере'}`;
        else if (it.diag === 'err') t += ` · ⚠ диагностика: ${it.diagMsg}`;
        if (it.error && (it.status === 'failed' || it.status === 'retry')) t += ` · ${it.error}`;
        if (it.notes.length) t += ` · ${it.notes.join('; ')}`;
        if (it.warn) t += ` · ⚠ ${it.warn}`;
        meta.textContent = t;
        const show = it.status === 'active' && it.total > 0;
        bar.hidden = !show;
        if (show) bar.value = Math.min(100, (it.got / it.total) * 100);
    }
    function setStatus(it, st) { it.status = st; renderItem(it); syncUI(); }
    /* --- папка: выбор всегда доступен --- */
    async function pickDir() {
        if (typeof window.showDirectoryPicker !== 'function') { log('Этот браузер не умеет выбирать папку (нужен Chrome или Edge).', 'err'); return false; }
        try {
            let opts = { id: 'yadler', mode: 'readwrite' };
            if (ST.rememberDir) { const saved = await idbGet('dir'); if (saved) opts.startIn = saved; }
            const d = await window.showDirectoryPicker(opts);
            S.dir = d; S.dirName = d.name;
            if (ui.sourceValue) {
                ui.sourceValue.textContent = d.name;
                ui.sourceValue.title = 'Сохранение в папку: ' + d.name;
            }
            if (ST.rememberDir) idbSet('dir', d);
            log(`Папка назначения: «${d.name}»`, 'ok', 'Папка назначения выбрана');
            return true;
        } catch (e) { log(e.name === 'AbortError' ? 'Выбор папки отменён.' : 'Не удалось выбрать папку: ' + e.message, 'warn'); return false; }
    }
    /* --- блок автора: только из promo.json --- */
    const safeUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };
    function chip(label, url, cls) { const u = safeUrl(url); if (!u) return null; const a = h('a', 'chip' + (cls ? ' ' + cls : ''), label); a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; }
    function chipsRow(list, cls) { const row = h('div', 'chips'); for (const [l, u] of list) { const a = chip(l, u, cls); if (a) row.append(a); } return row; }
    let promoHiddenNow = false;
    const promoHidden = () => promoHiddenNow;
    function buildPromo() {
     if (!PROMO || !PROMO.enabled) return null;
     const box = h('div', 'promo');
     const header = h('div', 'promo-header');
     const titleWrap = h('div', 'promo-title-wrap');
     
     // Основной заголовок
     const mainTitle = h('div', 'promo-title', 'Поддержи проект музыкой');
     
     // Текст с описанием альбома
     let descText = PROMO.album 
         ? `Пока файлы скачиваются — послушайте «${PROMO.album}»` 
         : 'Пока файлы скачиваются — послушайте музыку. Это тоже бесплатно!';
         
     const descEl = h('div', 'promo-subtitle', descText);
     
     // ДИСКЛЕЙМЕР (Новое поле)
     const disclaimer = h('div', 'promo-disclaimer', 'ДИСКЛЕЙМЕР 👀 Музыкальные ссылки ведут к автору треков, а не к разработчику скрипта. Мне лично ничего не нужно, а поддержать артиста на запись нового альбома можно кнопкой ниже. Баги и вопросы по программе — только в GitHub Issues. Закрыть окно можно на крестик [×] справа.');
     
     // Стили для дисклеймера (добавьте их в CSS или инлайн)
     disclaimer.style.cssText = `
        margin-top: 6px;
        font-size: calc(var(--fs) * 0.8);
        color: var(--text-muted);
        line-height: 1.3;
        border-top: 1px solid var(--separator);
        padding-top: 6px;
        opacity: 0.9;
     `;
     
     titleWrap.append(mainTitle, descEl, disclaimer);
     
     const closeBtn = h('button', 'promo-close', '×');
     closeBtn.title = 'Скрыть';
     closeBtn.setAttribute('aria-label', 'Скрыть блок');
     closeBtn.addEventListener('click', () => { box.hidden = true; promoHiddenNow = true; });
     
     header.append(titleWrap, closeBtn);
     
     const listenSection = h('div', 'promo-section');
     listenSection.append(h('div', 'promo-label', 'Слушать'), chipsRow(PROMO.listen));
     
     const parts = [header, listenSection];
     
     if (PROMO.social && PROMO.social.length) { 
         parts.push(h('div', 'promo-divider')); 
         const s = h('div', 'promo-section'); 
         s.append(h('div', 'promo-label', 'Подписаться на музыканта'), chipsRow(PROMO.social)); 
         parts.push(s); 
     }
     
     if (PROMO.donate) { 
         parts.push(h('div', 'promo-divider')); 
         const s = h('div', 'promo-section'); 
         const r = h('div', 'chips'); 
         const d = chip(PROMO.donate[0], PROMO.donate[1], 'accent full'); 
         if (d) r.append(d); 
         s.append(r); 
         parts.push(s); 
     }
     
     box.append(...parts);
     box.hidden = promoHidden();
     return box;
 }
    function showThanks() { if (!PROMO || !PROMO.enabled || !ui.thanks || promoHidden()) return; const wrap = h('div', 'thanks'); wrap.append(h('div', 'thanks-text', 'Готово. Понравился скрипт — поддержите автора прослушиванием!'), chipsRow(PROMO.listen)); ui.thanks.replaceChildren(wrap); ui.thanks.hidden = false; }
    /* --- тема, шрифт, степпер, подсказки, скроллбар, вид --- */
    const mediaDark = (typeof window.matchMedia === 'function') ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    function effDark() { return ST.theme === 'dark' || (ST.theme === 'auto' && !!mediaDark && mediaDark.matches); }
    function applyTheme() { if (!ui.host) return; ui.host.classList.toggle('dark', effDark()); if (ui.theme) { ui.theme.textContent = THEME_ICON[ST.theme]; ui.theme.title = 'Тема: ' + THEME_TITLE[ST.theme] + ' · клик — переключить'; } }
    function applyFontSize() {
        if (!ui.host) return;
        ui.host.classList.remove('fs-a', 'fs-aa', 'fs-aaa');
        ui.host.classList.add('fs-' + ST.fontSize);
        updateFontButton();
    }

    function updateFontButton() {
        if (!ui.fontCycle) return;
        const titles = {
            a: 'Размер шрифта: базовый · нажмите для переключения',
            aa: 'Размер шрифта: крупнее · нажмите для переключения',
            aaa: 'Размер шрифта: ещё крупнее · нажмите для переключения',
        };
        ui.fontCycle.title = titles[ST.fontSize] || titles.a;
        ui.fontCycle.textContent = 'A';
    }
    function updateStepper() {
        if (!ui.stepEls) return;
        const done1 = !!S.dir, done2 = S.items.length > 0;
        const selItems = S.items.filter((i) => i.sel);
        const done3 = !S.busy && selItems.length > 0 && selItems.every((i) => i.status === 'done');
        const done = [done1, done2, done3];
        const activeIdx = !done1 ? 0 : !done2 ? 1 : !done3 ? 2 : -1;
        ui.stepEls.forEach((el, i) => { el.classList.toggle('done', done[i]); el.classList.toggle('active', i === activeIdx); el.querySelector('.n').textContent = done[i] ? '✓' : String(i + 1); });
    }
    function setTip(btn, reason) { if (btn) btn.title = reason || btn.dataset.tip || ''; }
    function fixScrollbar() {
        /* Ширина корпуса фиксирована, скролл происходит внутри .body */
    }
    function applyView() {
        if (!ui.panel) return;
        ui.panel.classList.toggle('detail', ST.view === 'detail');
        if (ui.viewSimple) {
            ui.viewSimple.classList.toggle('active', ST.view === 'simple');
            ui.viewDetail.classList.toggle('active', ST.view === 'detail');
        }
        applyPos();
        fixScrollbar();
    }
    function buildDiagnostics() {
        const gi = (typeof GM_info !== 'undefined' && GM_info) || {};
        return [
            `YaDLer v${SCRIPT_VERSION}`, `Менеджер скриптов: ${gi.scriptHandler || '?'} ${gi.version || ''}`.trim(), `Браузер: ${navigator.userAgent}`,
            `Источник: ${S.pm === 'private' ? 'личный диск' : 'публичная ссылка'}; сессия: ${S.sess && S.sess.sk ? 'перехвачена' : 'нет'}; запись потоком: ${S.noStream ? 'недоступна (через память)' : 'доступна/не проверялась'}`,
            `Тема: ${ST.theme} (эфф. ${effDark() ? 'тёмная' : 'светлая'}); шрифт: ${ST.fontSize}; режим: ${ST.mode}; вид: ${ST.view}`,
            `Настройки: ${JSON.stringify(ST)}`,
            `Файлов: найдено ${S.items.length}, выбрано ${S.items.filter((i) => i.sel).length}, готово ${count('done')}, ошибок ${count('failed')}, недоступно ${S.items.filter((i) => i.diag === 'noaccess').length}`,
            '', 'Последние события:', ...S.logBuf.slice(-40).map((e) => `${e.t}  ${e.msg}`),
        ].join('\n');
    }
    async function copyText(text) { try { await navigator.clipboard.writeText(text); return true; } catch { } try { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; ui.panel.append(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch { return false; } }
    function syncPrivVisibility() { if (!ui.privBox) return; const isPublic = /^\/(d|i)\//.test(location.pathname); ui.privBox.hidden = isPublic; }
    function loadPanelState() { try { return JSON.parse(GM_getValue('panelState', '{}')) || {}; } catch { return {}; } }
    function savePanelState() { try { GM_setValue('panelState', JSON.stringify(ui.state)); } catch { } }
    function applyPos() {
        const p = ui.panel, st = ui.state;
        if (!p || !st) return;
        const detail = ST.view === 'detail';
        // Две колонки только если окно достаточно широкое и панель в него влезает
        const twoCol = detail && innerWidth >= 1000;
        p.classList.toggle('two-col', twoCol);
        const defW = twoCol ? 880 : 440;
        const key = detail ? 'widthDetail' : 'widthSimple';
        const raw = (typeof st[key] === 'number' && st[key] > 0) ? st[key] : defW;
        const maxW = Math.max(360, innerWidth - 24);
        const w = Math.min(Math.max(360, raw), maxW);
        p.style.width = w + 'px';
        const leftAnchored = typeof st.left === 'number';
        if (ui.grip) {
            ui.grip.classList.toggle('gl', !leftAnchored);
            ui.grip.classList.toggle('gr', leftAnchored);
        }
        if (!leftAnchored || typeof st.top !== 'number') {
            p.style.left = ''; p.style.top = ''; p.style.right = '';
            p.style.maxHeight = 'calc(100vh - 24px)';
            return;
        }
        st.left = Math.min(Math.max(0, st.left), Math.max(0, innerWidth - w));
        st.top = Math.min(Math.max(0, st.top), Math.max(0, innerHeight - 48));
        p.style.left = st.left + 'px'; p.style.top = st.top + 'px'; p.style.right = 'auto';
        p.style.maxHeight = `${Math.max(120, innerHeight - st.top - 8)}px`;
    }
    function buildUI() {
        const host = document.createElement('div');
        host.id = 'yd-dl-host';
        const root = host.attachShadow({ mode: 'closed' });
        try { const sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); root.adoptedStyleSheets = [sheet]; } catch { const st = document.createElement('style'); st.textContent = CSS; root.append(st); }

        const panel = h('div', 'panel');
        const head = h('div', 'head');

        const brand = h('div', 'brand');
        brand.append(h('strong', '', 'YaDLer'), h('span', 'ver', 'v' + SCRIPT_VERSION));

        const viewMini = h('div', 'view-mini');
        ui.viewSimple = h('button', 'vm-btn active', 'Просто');
        ui.viewDetail = h('button', 'vm-btn', 'Подробно');
        ui.viewSimple.title = 'Компактный режим: только главное';
        ui.viewDetail.title = 'Полный режим: список, фильтры, журнал, настройки';
        ui.viewSimple.addEventListener('click', () => { ST.view = 'simple'; saveSettings(); applyView(); log('Вид: Просто'); });
        ui.viewDetail.addEventListener('click', () => { ST.view = 'detail'; saveSettings(); applyView(); log('Вид: Подробно'); });
        viewMini.append(ui.viewSimple, ui.viewDetail);

        const tools = h('div', 'tools');

        ui.fontCycle = h('button', 'tool font-cycle', 'A');
        ui.fontCycle.title = 'Размер шрифта: базовый · нажмите для переключения';
        ui.fontCycle.addEventListener('click', () => {
            const order = ['a', 'aa', 'aaa'];
            ST.fontSize = order[(order.indexOf(ST.fontSize) + 1) % order.length];
            saveSettings();
            applyFontSize();
            applyPos();
        });

        ui.upd = h('button', 'tool', '↻');
        ui.upd.title = 'Проверить обновления';
        ui.upd.addEventListener('click', () => {
            log('Проверяю обновления…');
            let w = null;
            try { w = window.open('about:blank', '_blank'); } catch { w = null; }
            checkUpdate(true, w);
        });

        ui.theme = h('button', 'tool', THEME_ICON[ST.theme]);
        ui.theme.title = 'Тема: ' + THEME_TITLE[ST.theme] + ' · клик — переключить';
        ui.theme.addEventListener('click', () => {
            const i = THEME_ORDER.indexOf(ST.theme);
            ST.theme = THEME_ORDER[(i + 1) % THEME_ORDER.length];
            saveSettings();
            applyTheme();
            log(`Тема: ${THEME_TITLE[ST.theme]}`);
        });

        ui.flip = h('button', 'tool', '⇄');
        ui.flip.title = 'На другую сторону экрана';

        ui.toggle = h('button', 'tool', '—');
        ui.toggle.title = 'Свернуть/развернуть';
        ui.close = h('button', 'tool', '×');
        ui.close.title = 'Закрыть панель до перезагрузки страницы';
        ui.close.addEventListener('click', () => {
            if (S.busy) {
                log('Нельзя закрыть панель во время работы. Сначала нажмите «Стоп».', 'warn');
                return;
            }
            try {
                ui.closed = true;
                if (ui.host && ui.host.parentNode) ui.host.parentNode.removeChild(ui.host);
                log('Панель закрыта. Чтобы вернуть — перезагрузите страницу (F5).', 'ok');
            } catch (e) {
                console.warn('YaDLer: не удалось закрыть панель', e);
            }
        });
        if (PROMO && PROMO.enabled) {
            ui.heart = h('button', 'tool', '♥');
            ui.heart.title = 'Показать/скрыть блок автора';
            tools.append(ui.heart);
        }

        tools.append(ui.fontCycle, ui.upd, ui.theme, ui.flip, ui.toggle, ui.close);
        head.append(brand, viewMini, tools);
        head.title = 'Потяните, чтобы переместить · двойной клик — вернуть на место и сбросить ширину';

        ui.state = loadPanelState();
        panel.classList.toggle('collapsed', !!ui.state.collapsed);

        ui.toggle.addEventListener('click', () => {
            ui.state.collapsed = panel.classList.toggle('collapsed');
            applyPos();
            savePanelState();
        });

        ui.flip.addEventListener('click', () => {
            const r = panel.getBoundingClientRect();
            ui.state.left = r.left + r.width / 2 < innerWidth / 2 ? innerWidth - r.width - 12 : 12;
            ui.state.top = r.top;
            applyPos();
            savePanelState();
        });

        head.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || e.target.closest('button')) return;
            const r = panel.getBoundingClientRect();
            const dx = e.clientX - r.left, dy = e.clientY - r.top;
            head.setPointerCapture(e.pointerId);
            head.classList.add('drag');
            const move = (ev) => { ui.state.left = ev.clientX - dx; ui.state.top = ev.clientY - dy; applyPos(); };
            const up = () => {
                head.removeEventListener('pointermove', move);
                head.removeEventListener('pointerup', up);
                head.removeEventListener('pointercancel', up);
                head.classList.remove('drag');
                savePanelState();
            };
            head.addEventListener('pointermove', move);
            head.addEventListener('pointerup', up);
            head.addEventListener('pointercancel', up);
        });

        head.addEventListener('dblclick', (e) => {
            if (e.target.closest('button')) return;
            ui.state.left = null;
            ui.state.top = null;
            ui.state.widthSimple = null;
            ui.state.widthDetail = null;
            applyPos();
            savePanelState();
            log('Панель возвращена на место и к стандартному размеру.', 'ok');
        });

        const body = h('div', 'body');
        ui.body = body;

        ui.promo = buildPromo();

        const sourceBar = h('div', 'source-bar');
        const sourceField = h('div', 'source-field');
        sourceField.append(
            h('div', 'source-label', 'Папка назначения'),
            ui.sourceValue = h('div', 'source-value', 'Не выбрана')
        );
        ui.pick = h('button', 'btn-icon', '📁');
        ui.pick.title = 'Выбрать папку на компьютере, куда сохранять файлы';
        ui.pick.addEventListener('click', pickDir);
        sourceBar.append(sourceField, ui.pick);

        ui.restoreBtn = h('button', 'btn-sub', 'Продолжить прошлый сеанс');
        ui.restoreBtn.hidden = true;
        ui.restoreBtn.style.width = '100%';
        ui.restoreBtn.title = 'Восстановить список файлов из сохранённого сеанса';
        ui.restoreBtn.addEventListener('click', () => {
            loadScanFromStorage().then((data) => {
                if (restoreScan(data)) {
                    ui.restoreBtn.hidden = true;
                    log('Прошлый сеанс восстановлен.', 'ok');
                } else {
                    log('Сохранённый сеанс пуст, устарел или принадлежит другой версии скрипта.', 'warn');
                }
            }).catch((e) => {
                console.warn('YaDLer restore error', e);
                log('Не удалось восстановить сеанс: ' + e.message, 'err');
            });
        });

        ui.guide = h('div', 'guide', '');

        const actionGrid = h('div', 'action-grid');
        ui.scan = h('button', 'te-btn btn-scan', 'Сканировать');
        ui.scan.dataset.tip = 'Собрать список файлов и проверить доступность';
        ui.stop = h('button', 'te-btn btn-stop', 'Стоп');
        ui.stop.dataset.tip = 'Пауза/продолжение текущего процесса';
        ui.diagBtn = h('button', 'te-btn btn-check', 'Проверить');
        ui.diagBtn.dataset.tip = 'Повторная проверка доступности отмеченных файлов';
        actionGrid.append(ui.scan, ui.stop, ui.diagBtn);

        ui.abort = h('button', 'btn-sub', '■ Прервать полностью');
        ui.abort.hidden = true;
        ui.abort.style.width = '100%';
        ui.abort.title = 'Полностью остановить сканирование или загрузку';
        ui.abort.addEventListener('click', () => { S.pause = false; stopAll(); });

        const deck = h('div', 'download-deck');
        ui.start = h('button', 'te-btn btn-download', 'Скачать');
        ui.start.dataset.tip = 'Скачать отмеченные файлы. Активна после завершения сканирования.';

        const speedPanel = h('div', 'speed-panel');
        ui.modeCards = {};
        const speedLabels = { fast: 'Быстро', balance: 'Баланс', safe: 'Бережно' };
        for (const key of ['fast', 'balance', 'safe']) {
            const b = h('button', 'speed-btn', speedLabels[key]);
            b.title = MODES[key].name + ': ' + MODES[key].desc;
            b.addEventListener('click', () => {
                applyMode(key);
                syncSettingsUI();
                log(`Режим: ${MODES[key].name} — ${MODES[key].desc}`, 'ok');
                syncUI();
            });
            ui.modeCards[key] = b;
            speedPanel.append(b);
        }
        deck.append(ui.start, speedPanel);

        const scanScr = buildScanScreen();
        ui.scanScreen = scanScr.box;
        ui.scanCells = scanScr.cells;

        ui.dlScreen = buildDlScreen();

        ui.activeBox = h('div', 'actbox');
        ui.thanks = h('div', 'thanks');
        ui.thanks.hidden = true;

        const util = h('div', 'utility-row');
        ui.retry = h('button', 'btn-sub', 'Сбойные');
        ui.retry.dataset.tip = 'Повторно скачать только файлы с ошибками';
        ui.rep = h('button', 'btn-sub', 'Отчёт');
        ui.rep.dataset.tip = 'Сохранить текстовый отчёт';
        ui.dropBad = h('button', 'btn-sub', 'Снять ⚠');
        ui.dropBad.dataset.tip = 'Убрать из выбора файлы, к которым нет доступа на сервере';
        ui.compare = h('button', 'btn-sub', 'Сравнить');
        ui.compare.dataset.tip = 'Сверить с выбранной папкой по размеру и SHA-256';
        util.append(ui.retry, ui.rep, ui.dropBad, ui.compare);

        const selRow = h('div', 'row donly');
        ui.selRow = selRow;

        ui.foldAll = h('button', '', '⊟');
        ui.foldAll.title = 'Свернуть/развернуть все папки';
        ui.foldAll.addEventListener('click', () => {
            const anyOpen = S.groups.some((g) => !g.collapsed);
            for (const g of S.groups) g.collapsed = anyOpen;
            ui.foldAll.textContent = anyOpen ? '⊞' : '⊟';
            ui.foldAll.title = anyOpen ? 'Развернуть все папки' : 'Свернуть все папки';
            applyVisibility();
            updateGroups();
        });

        const bAll = h('button', '', 'Все');
        bAll.title = 'Отметить все видимые файлы';
        const bNone = h('button', '', 'Ничего');
        bNone.title = 'Снять все отметки с видимых файлов';

        ui.filter = document.createElement('input');
        ui.filter.type = 'search';
        ui.filter.placeholder = 'Фильтр: .pdf, имя…';
        ui.filter.title = 'Фильтр по имени файла';

        const bOk = h('button', '', 'Доступные (0)');
        bOk.dataset.tip = 'Отметить только доступные файлы в очереди';
        const bBad = h('button', '', 'Недоступные (0)');
        bBad.dataset.tip = 'Отметить только недоступные на сервере файлы';
        ui.bOk = bOk;
        ui.bBad = bBad;

        ui.markMissing = h('button', '', 'Недостающие');
        ui.markMissing.dataset.tip = 'Отметить отсутствующие, отличающиеся и повреждённые файлы для перекачки';

        selRow.append(ui.foldAll, bAll, bNone, bOk, bBad, ui.markMissing, ui.filter);

        ui.listEmpty = h('div', 'list-empty donly', '');
        ui.list = h('ul');
        ui.list.classList.add('donly');

        ui.log = h('div', 'log donly');
        ui.log.setAttribute('role', 'log');

        const logTools = h('div', 'row donly log-tools');
        ui.diag = h('button', '', 'Копировать диагностику');
        ui.diag.title = 'Версии, настройки и последние события — без имён файлов и ссылок';
        logTools.append(ui.diag);

        const adv = document.createElement('details');
        adv.classList.add('donly');
        adv.append(h('summary', '', 'Для продвинутых пользователей'));
        adv.append(h('div', 'adv-note', 'Фильтры, списки имён, параметры загрузки. Базовый сценарий работает без них.'));

        const fRow = h('div', 'row');
        const mk = (opts) => {
            const el = document.createElement('select');
            for (const [v, t] of opts) {
                const o = document.createElement('option');
                o.value = v;
                o.textContent = t;
                el.append(o);
            }
            return el;
        };

        ui.fsize = mk([['any', 'Любой размер'], ['gt1', '> 1 МБ'], ['gt10', '> 10 МБ'], ['gt100', '> 100 МБ'], ['lt1', '< 1 МБ']]);
        ui.fsize.title = 'Фильтр по размеру файла';
        ui.sort = mk([['tree', 'По папкам'], ['name', 'По имени'], ['size-desc', 'Крупные сверху'], ['size-asc', 'Мелкие сверху'], ['status', 'Проблемные сверху']]);
        ui.sort.title = 'Сортировка списка файлов';
        fRow.append(ui.fsize, ui.sort);

        const chkRow = h('div', 'chk-row');
        const chkLabel = h('label', 'chk');
        ui.onlyBad = document.createElement('input');
        ui.onlyBad.type = 'checkbox';
        ui.onlyBad.title = 'Показывать только проблемные файлы';
        chkLabel.append(ui.onlyBad, document.createTextNode(' Только проблемные'));

        const selLabel = h('label', 'chk');
        ui.onlySel = document.createElement('input');
        ui.onlySel.type = 'checkbox';
        ui.onlySel.title = 'Показывать только отмеченные файлы';
        selLabel.append(ui.onlySel, document.createTextNode(' Только отмеченные'));
        chkRow.append(chkLabel, selLabel);

        const namesDet = document.createElement('details');
        namesDet.append(h('summary', '', 'Отметить по списку имён'));
        ui.names = document.createElement('textarea');
        ui.names.rows = 5;
        ui.names.spellcheck = false;
        ui.names.placeholder = 'Имена файлов, по одному в строке.\nМожно с путём (Папка/файл.pdf) или без расширения.';
        ui.names.title = 'Вставьте список имён файлов, чтобы отметить только их';
        try { ui.names.value = GM_getValue('names', '') || ''; } catch { /* ignore */ }

        let namesTimer = 0;
        ui.names.addEventListener('input', () => {
            clearTimeout(namesTimer);
            namesTimer = setTimeout(() => {
                try { GM_setValue('names', ui.names.value); } catch { /* ignore */ }
            }, 500);
        });

        const nRow = h('div', 'row');
        const bApply = h('button', 'primary', 'Отметить по списку');
        bApply.title = 'Применить список имён к текущим файлам';
        const bFile = h('button', '', 'Загрузить .txt…');
        bFile.title = 'Загрузить список имён из текстового файла';
        const bClear = h('button', '', 'Очистить');
        bClear.title = 'Очистить поле списка имён';
        ui.file = document.createElement('input');
        ui.file.type = 'file';
        ui.file.accept = '.txt,text/plain';
        ui.file.hidden = true;
        nRow.append(bApply, bFile, bClear, ui.file);
        namesDet.append(ui.names, nRow);

        const det = document.createElement('details');
        det.append(h('summary', '', 'Настройки загрузки'));
        const grid = h('div', 'grid');

        const conc = mkSelect('Потоков', [1, 2, 3, 4, 5, 6].map((n) => [n, String(n)]), 'conc', true);
        conc.l.title = 'Сколько файлов качать одновременно';
        const stall = mkSelect('Зависание', [[20, '20 с'], [30, '30 с'], [60, '60 с']], 'stall', true, true);
        stall.l.title = 'Через сколько секунд без данных считать файл зависшим';
        const slow = mkSelect('Мин. скорость', [[0, 'выкл'], [100, '100 КБ/с'], [300, '300 КБ/с'], [1000, '1 МБ/с']], 'minSpeed', true, true);
        slow.l.title = 'Если скорость ниже этого значения — перезапуск файла';
        const auto = mkCheck('Автоподбор потоков', 'auto');
        auto.l.title = 'Автоматически снижать потоки при лимитах Яндекса';
        const retry = mkCheck('Автоповтор сбойных', 'autoRetry');
        retry.l.title = 'После основного прогона повторно попробовать скачать ошибки';
        const ver = mkCheck('Проверять SHA-256', 'verify');
        ver.l.title = 'После записи сверяет хеш с тем, что отдал Яндекс (файлы до 256 МБ).';
        const fixp = mkCheck('Перезаписывать недокачанные', 'fixPartial');
        fixp.l.title = 'Если файл в папке меньше ожидаемого (обрыв) — перезаписать его, а не создавать копию «(1)».';
        const rep = mkCheck('Сохранять отчёт (.txt)', 'report');
        rep.l.title = 'После загрузки класть отчёт в папку со скачанными файлами.';
        const sub = mkCheck('Подпапки', 'subfolders');
        sub.l.title = 'Скачивать вложенные папки с сохранением структуры';
        const skip = mkCheck('Пропускать уже скачанные', 'skipExisting');
        skip.l.title = 'Не перезакачивать файлы, которые уже есть в папке и совпадают по размеру';
        const snd = mkCheck('Звук по окончании', 'sound');
        snd.l.title = 'Проиграть короткий сигнал после завершения';
        const ascan = mkCheck('Сканировать автоматически', 'autoScan');
        ascan.l.title = 'Запускать сканирование сразу при открытии публичной ссылки или папки личного диска.';
        const adiag = mkCheck('Проверять доступность при скане', 'autoDiag');
        adiag.l.title = 'После сканирования проверять каждый файл: ссылка у API + проба хранилища.';
        const rdir = mkCheck('Помнить папку между сессиями', 'rememberDir');
        const ntf = mkCheck('Уведомление по окончании', 'notify');
        ntf.l.title = 'Показать уведомление браузера, когда загрузка закончится (если вкладка в фоне)';
        rdir.l.title = 'Запоминать выбранную папку назначения в IndexedDB';

        grid.append(conc.l, stall.l, slow.l, auto.l, retry.l, ver.l, fixp.l, rep.l, sub.l, skip.l, snd.l, ascan.l, adiag.l, rdir.l, ntf.l);
        det.append(grid);

        ui.locked = [conc.el, ver.l.querySelector('input'), fixp.l.querySelector('input'), sub.l.querySelector('input'), skip.l.querySelector('input')];
        adv.append(fRow, chkRow, namesDet, det);

        const priv = document.createElement('details');
        ui.privBox = priv;
        priv.classList.add('donly');
        priv.append(h('summary', '', 'Личный диск (вход)'));

        const pRow = h('div', 'row');
        ui.loginBtn = h('button', 'primary', 'Войти через Яндекс');
        ui.loginBtn.title = 'OAuth-вход — страховка, если внутренний API Яндекса изменится';
        ui.logoutBtn = h('button', '', 'Выйти');
        ui.logoutBtn.hidden = true;
        ui.logoutBtn.title = 'Удалить токен из скрипта';
        ui.privStatus = h('span', 'summary', 'Не подключён');
        pRow.append(ui.loginBtn, ui.logoutBtn, ui.privStatus);
        priv.append(pRow, h('div', 'adv-note', 'Обычно вход не нужен: скрипт работает через вашу сессию браузера. Вход пригодится, только если Яндекс закроет внутренний API.'));

        ui.pathInput = document.createElement('input');
        ui.pathInput.type = 'text';
        ui.pathInput.spellcheck = false;
        ui.pathInput.placeholder = 'Например Фото/2024 (пусто — открытая папка)';
        ui.pathInput.title = 'Путь на Яндекс Диске для сканирования';
        const pathLabel = h('label', 'field', 'Папка на Диске');
        pathLabel.append(ui.pathInput);

        const man = document.createElement('details');
        man.append(h('summary', '', 'Вход вручную / Client ID'));
        ui.clientId = document.createElement('input');
        ui.clientId.type = 'text';
        ui.clientId.spellcheck = false;
        ui.clientId.placeholder = '32 символа';
        ui.clientId.title = 'Client ID OAuth-приложения Яндекса';
        try { ui.clientId.value = GM_getValue('clientId', '') || ''; } catch { /* ignore */ }
        const cidLabel = h('label', 'field', 'Client ID приложения');
        cidLabel.append(ui.clientId);

        ui.tokenInput = document.createElement('input');
        ui.tokenInput.type = 'password';
        ui.tokenInput.autocomplete = 'off';
        ui.tokenInput.placeholder = 'Токен со страницы Яндекса';
        ui.tokenInput.title = 'Вставьте access_token, если автоматический вход не сработал';
        const tokLabel = h('label', 'field', 'Токен (если автоматический вход не сработал)');
        tokLabel.append(ui.tokenInput);
        ui.tokenBtn = h('button', '', 'Подключить токен');
        ui.tokenBtn.title = 'Проверить токен и подключить личный диск через OAuth';
        man.append(cidLabel, tokLabel, ui.tokenBtn);
        priv.append(pathLabel, man);

        const foot = h('div', 'foot');
        foot.append(document.createTextNode('Приватность: YaDLer не отправляет ваши данные третьим сторонам. Запросы идут только к API Яндекс Диска и на CDN Яндекса. Файлы, токены и история остаются на вашем компьютере.'));
        const repoLink = h('a', '', 'github.com/albertomazzoni/YaDLer');
        repoLink.href = 'https://github.com/albertomazzoni/YaDLer';
        repoLink.target = '_blank';
        repoLink.rel = 'noopener noreferrer';
        repoLink.title = 'Исходники, релизы и Issues';
        const repoRow = h('span', 'repo');
        repoRow.append(document.createTextNode('Репозиторий: '), repoLink);
        foot.append(repoRow);
        log('YaDLer v' + SCRIPT_VERSION + ' | Official Build by albertomazzoni', 'ok');

        const cols = h('div', 'cols');
        const colMain = h('div', 'col-main');
        const colDetail = h('div', 'col-detail');
        colMain.append(
            ui.promo,
            sourceBar,
            ui.restoreBtn,
            ui.guide,
            actionGrid,
            ui.abort,
            deck,
            ui.scanScreen,
            ui.dlScreen,
            ui.activeBox,
            ui.thanks,
            util
        );
        colDetail.append(
            selRow,
            ui.listEmpty,
            ui.list,
            ui.log,
            logTools,
            adv,
            priv
        );
        cols.append(colMain, colDetail);
        body.append(cols, foot);

        const mini = h('div', 'mini');
        ui.miniBar = document.createElement('progress');
        ui.miniBar.max = 100;
        ui.miniBar.value = 0;
        ui.miniText = h('div', 'summary', 'Готов к работе');
        mini.append(ui.miniBar, ui.miniText);

        ui.grip = h('div', 'resize-grip gl');
        ui.grip.title = 'Потяните, чтобы изменить ширину · двойной клик — сброс';
        ui.grip.setAttribute('role', 'separator');
        ui.grip.setAttribute('aria-orientation', 'vertical');
        ui.grip.setAttribute('aria-label', 'Изменить ширину панели YaDLer');
        panel.append(head, mini, body, ui.grip);
        root.append(panel);

        let rs = null;
        ui.grip.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            rs = { startX: e.clientX, startW: panel.offsetWidth, leftAnchored: typeof ui.state.left === 'number' };
            try { ui.grip.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        });
        ui.grip.addEventListener('pointermove', (e) => {
            if (!rs) return;
            const dx = e.clientX - rs.startX;
            const delta = rs.leftAnchored ? dx : -dx;
            const nw = Math.min(Math.max(360, rs.startW + delta), Math.max(360, innerWidth - 24));
            ui.state[ST.view === 'detail' ? 'widthDetail' : 'widthSimple'] = Math.round(nw);
            panel.style.width = nw + 'px';
        });
        const rsUp = () => { if (rs) { rs = null; savePanelState(); } };
        ui.grip.addEventListener('pointerup', rsUp);
        ui.grip.addEventListener('pointercancel', rsUp);
        ui.grip.addEventListener('dblclick', () => {
            ui.state[ST.view === 'detail' ? 'widthDetail' : 'widthSimple'] = null;
            savePanelState();
            applyPos();
        });

        const visible = () => S.items.filter((i) => i.filtered);

        bAll.addEventListener('click', () => {
            for (const i of visible()) if (i.status !== 'done') { i.sel = true; i.ui.cb.checked = true; }
            syncUI();
        });

        const pickBy = (pred, label) => {
            let n = 0;
            for (const i of visible()) {
                const v = !!pred(i);
                i.sel = v;
                if (i.ui) i.ui.cb.checked = v;
                if (v) n++;
            }
            if (ui.onlySel && ui.onlySel.checked) applyVisibility();
            syncUI();
            log(label + ': отмечено ' + n + (n ? '' : ' (нет подходящих файлов)'), n ? 'ok' : 'warn');
        };

        bOk.addEventListener('click', () => pickBy((i) => i.status === 'queued' && i.diag !== 'noaccess', 'Доступные (в очереди)'));
        bBad.addEventListener('click', () => pickBy((i) => i.diag === 'noaccess', 'Недоступные'));
        bNone.addEventListener('click', () => {
            for (const i of visible()) { i.sel = false; i.ui.cb.checked = false; }
            syncUI();
        });

        for (const el of [ui.filter, ui.fsize]) el.addEventListener('input', () => { if (S.items.length) applyVisibility(); });
        ui.sort.addEventListener('change', () => { if (S.items.length) applySort(ui.sort.value); });
        ui.onlyBad.addEventListener('change', () => ui.list.classList.toggle('only-bad', ui.onlyBad.checked));
        ui.onlySel.addEventListener('change', () => { if (S.items.length) applyVisibility(); });

        ui.scan.addEventListener('click', scan);
        ui.stop.addEventListener('click', togglePause);
        ui.start.addEventListener('click', () => {
            ensureAudio();
            try { if (ST.notify && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission(); } catch { /* ignore */ }
            if (!S.dir) pickDir().then((ok) => { if (ok) run(); });
            else run();
        });
        ui.retry.addEventListener('click', () => { ensureAudio(); retryFailed(); });
        ui.rep.addEventListener('click', async () => {
            const ok = await saveReport(true);
            flashBtn(ui.rep, ok ? '✓ Сохранено' : '✕ Не вышло');
        });
        ui.diagBtn.addEventListener('click', diagnoseNow);
        ui.dropBad.addEventListener('click', dropUnavailable);
        ui.compare.addEventListener('click', async () => {
            if (S.busy) return;
            if (!S.dir && !(await pickDir())) return;
            if (!S.items.length) {
                const prevDiag = ST.autoDiag;
                ST.autoDiag = false; // для сверки проверка доступности не нужна
                try { await scan(); } finally { ST.autoDiag = prevDiag; }
                if (!S.items.length) return;
            }
            compareLocal();
        });
        ui.markMissing.addEventListener('click', markMissing);
        ui.diag.addEventListener('click', async () => {
            const ok = await copyText(buildDiagnostics());
            log(ok ? 'Диагностика скопирована в буфер: вставьте её в сообщение об ошибке (имён файлов и ссылок там нет).' : 'Не удалось скопировать в буфер обмена.', ok ? 'ok' : 'err');
        });

        bApply.addEventListener('click', applyNames);
        bFile.addEventListener('click', () => ui.file.click());
        ui.file.addEventListener('change', () => { loadNamesFile(ui.file.files[0]); ui.file.value = ''; });
        bClear.addEventListener('click', () => {
            ui.names.value = '';
            S.namesMissing = [];
            try { GM_setValue('names', ''); } catch { /* ignore */ }
            log('Список имён очищен (выбор файлов не менялся).');
        });

        ui.loginBtn.addEventListener('click', startLogin);
        ui.logoutBtn.addEventListener('click', () => { dropToken(); log('Вы вышли: токен удалён из скрипта.', 'warn'); });
        ui.clientId.addEventListener('change', () => { try { GM_setValue('clientId', ui.clientId.value.trim()); } catch { /* ignore */ } });
        ui.tokenBtn.addEventListener('click', () => {
            const t = ui.tokenInput.value.trim();
            ui.tokenInput.value = '';
            if (!TOKEN_RE.test(t)) { log('Это не похоже на токен.', 'err'); return; }
            setToken(t);
        });

        if (ui.heart) ui.heart.addEventListener('click', () => {
            if (!ui.promo) return;
            ui.promo.hidden = !ui.promo.hidden;
            promoHiddenNow = ui.promo.hidden;
        });

        function flashBtn(btn, text) {
            if (!btn) return;
            const old = btn.textContent;
            btn.classList.add('okflash');
            btn.textContent = text;
            setTimeout(() => { btn.classList.remove('okflash'); btn.textContent = old; }, 2000);
        }

        document.documentElement.append(host);
        ui.host = host;
        ui.panel = panel;

        applyTheme();
        applyFontSize();
        applyView();
        applyPos();

        window.addEventListener('resize', () => { applyPos(); fixScrollbar(); });
        if (mediaDark && typeof mediaDark.addEventListener === 'function') mediaDark.addEventListener('change', () => { if (ST.theme === 'auto') applyTheme(); });

        syncUI();
    }
    const scrub = (t) => String(t).replace(/https?:\/\/\S+/g, '[ссылка]').replace(/disk:\/\S*/g, '[путь]');
    function log(msg, kind, safe) {
        const time = new Date().toLocaleTimeString('ru-RU');
        S.logBuf.push({ t: time, msg: scrub(safe !== undefined ? safe : msg) });
        if (S.logBuf.length > 300) S.logBuf.shift();
        if (!ui.log) { console.log('[YaDLer]', msg); return; }
        const d = h('div', kind || '', `${time}  ${msg}`);
        ui.log.append(d);
        while (ui.log.childElementCount > 500) ui.log.firstElementChild.remove();
        ui.log.scrollTop = ui.log.scrollHeight;
    }
    let syncPending = false;
    function syncUI() { if (syncPending) return; syncPending = true; setTimeout(() => { syncPending = false; doSyncUI(); }, 80); }
    function doSyncUI() {
        if (!ui.scan) return;

        const busy = !!S.busy;
        const done = count('done'), failed = count('failed'), queued = count('queued');

        if (ui.sourceValue) {
            ui.sourceValue.textContent = S.dirName || 'Не выбрана';
            ui.sourceValue.title = S.dirName ? 'Сохранение в папку: ' + S.dirName : 'Папка не выбрана';
        }

        ui.scan.disabled = busy;
        if (busy) S.cmpNote = '';
        if (ui.abort) ui.abort.hidden = !busy;
        if (ui.restoreBtn && (S.items.length || busy)) ui.restoreBtn.hidden = true;
        setTip(ui.scan, busy ? 'Дождитесь окончания или нажмите «Стоп»' : '');

        ui.stop.disabled = !busy;
        ui.stop.textContent = S.pause ? 'Продолжить' : 'Стоп';
        ui.stop.className = 'te-btn ' + (S.pause ? 'btn-resume' : 'btn-stop');
        setTip(ui.stop, !busy
            ? 'Появится во время сканирования или загрузки'
            : (S.pause ? 'Нажмите, чтобы продолжить' : 'Нажмите, чтобы поставить на паузу'));

        ui.diagBtn.disabled = busy || !S.items.length;
        setTip(ui.diagBtn, busy ? 'Дождитесь окончания' : (S.items.length ? '' : 'Появится после сканирования'));

        ui.start.disabled = busy || !S.scanDone || queued === 0;
        ui.start.textContent = (done || failed) && queued ? 'Продолжить' : 'Скачать';
        setTip(ui.start, busy
            ? 'Дождитесь окончания или нажмите «Стоп»'
            : (!S.dir
                ? 'Сначала выберите папку назначения'
                : (!S.scanDone
                    ? 'Сначала завершите сканирование'
                    : (queued === 0 ? 'Нечего качать: отметьте файлы или нажмите «Все»' : ''))));

        ui.retry.disabled = busy || failed === 0;
        setTip(ui.retry, busy ? 'Дождитесь окончания' : (failed === 0 ? 'Появится, если будут файлы с ошибками' : ''));

        ui.rep.disabled = !S.items.length;
        setTip(ui.rep, S.items.length ? '' : 'Появится после сканирования');

        ui.compare.disabled = busy;
        setTip(ui.compare, busy ? 'Дождитесь окончания' : 'Сверить папку на компьютере с папкой на Яндекс Диске. Если нужно, скрипт сначала спросит папку и просканирует Диск');

        ui.dropBad.disabled = busy || !S.items.some((i) => i.diag === 'noaccess' && i.sel);
        setTip(ui.dropBad, busy ? 'Дождитесь окончания' : (S.items.some((i) => i.diag === 'noaccess') ? '' : 'Появится, если проверка найдёт недоступные файлы'));

        ui.markMissing.disabled = busy || !S.items.some((i) => i.local);
        setTip(ui.markMissing, busy ? 'Дождитесь окончания' : (S.items.some((i) => i.local) ? '' : 'Появится после сравнения с папкой'));

        const availCount = S.items.filter((i) => i.status === 'queued' && i.diag !== 'noaccess').length;
        const unavailCount = S.items.filter((i) => i.diag === 'noaccess').length;
        if (ui.bOk) {
            ui.bOk.textContent = 'Доступные (' + availCount + ')';
            ui.bOk.disabled = busy || !S.items.length;
        }
        if (ui.bBad) {
            ui.bBad.textContent = 'Недоступные (' + unavailCount + ')';
            ui.bBad.disabled = busy || !S.items.some((i) => i.diag === 'noaccess');
        }

        for (const el of ui.locked) el.disabled = busy;
        ui.list.classList.toggle('busy', busy);

        if (!busy) {
            let guide = '', gcls = 'guide';
            if (!S.dir) guide = 'Шаг 1: нажмите 📁 и выберите папку назначения.';
            else if (!S.scanDone) guide = 'Шаг 2: нажмите «Сканировать» — скрипт соберёт список и проверит файлы.';
            else if (queued > 0) guide = 'Шаг 3: нажмите «Скачать». Типы файлов переключаются тапом по матрице.';
            else if (failed > 0) { guide = 'Готово с ошибками: «Сбойные» или откройте отчёт.'; gcls += ' err'; }
            else { guide = 'Готово! Файлы и отчёт — в папке со скачанным.'; gcls += ' ok'; }
            if (S.newVer) guide = '🔔 Вышла v' + S.newVer + ' — нажмите ↻ в шапке. ' + guide;
            if (S.cmpNote) guide = S.cmpNote + ' ' + guide;
            ui.guide.textContent = guide;
            ui.guide.className = gcls;
        }

        ui.modeCustom && (ui.modeCustom.hidden = true);
        for (const key of Object.keys(ui.modeCards)) ui.modeCards[key].classList.toggle('active', ST.mode === key);

        ui.scanScreen.hidden = !((S.items.length || S.busy === 'scan' || S.busy === 'diag') && S.screen === 'scan' && S.busy !== 'run');
        ui.dlScreen.hidden = !(S.items.length && (S.screen === 'dl' || S.busy === 'run'));

        if (!ui.scanScreen.hidden) renderScanScreen();
        if (!ui.dlScreen.hidden) renderDlScreen();

        ui.listEmpty.textContent = busy
            ? 'Идёт ' + (S.busy === 'scan' ? 'сканирование и проверка' : S.busy === 'diag' ? 'проверка доступности' : S.busy === 'compare' ? 'сравнение с папкой' : 'загрузка') + ' — список появится через минуту. Не закрывайте вкладку.'
            : 'Список пуст. Откройте папку Яндекс Диска и нажмите «Сканировать» — здесь появятся файлы с галочками.';
        ui.listEmpty.hidden = S.items.length > 0;
        ui.list.hidden = !S.items.length;
        ui.selRow.hidden = !S.items.length;

        if (S.items.length) {
            const sel = S.items.filter((i) => i.sel);
            const doneSel = sel.filter((i) => i.status === 'done').length;
            if (!busy) {
                ui.miniBar.value = sel.length ? (doneSel / sel.length) * 100 : 0;
                ui.miniText.textContent = `скачано ${doneSel} из ${sel.length}` + (failed ? ` · ошибок ${failed}` : '');
            }
            updateGroups();
        } else if (!busy) {
            ui.miniBar.value = 0;
            ui.miniText.textContent = 'Готов к работе';
        }

        fixScrollbar();
        updatePrivUI();
    }
    /* ================= ЗАПУСК ================= */
    function boot() {
        buildUI();
        fixScrollbar();
        syncPrivVisibility();
        setInterval(syncPrivVisibility, 1000);
        updatePrivUI();
        try { if (typeof GM_addValueChangeListener === 'function') GM_addValueChangeListener('oauth_token_tmp', (n, o, v) => { if (v) adoptTokenFromStorage(v); }); adoptTokenFromStorage(GM_getValue('oauth_token_tmp', '')); } catch { }
        try { if (typeof GM_info !== 'undefined') log(`YaDLer v${SCRIPT_VERSION}, ${GM_info.scriptHandler || 'менеджер'} ${GM_info.version || '?'}`, 'ok'); } catch { }
        log('Готово. Откройте нужную папку и нажмите «Сканировать».', 'ok');

        // Check for saved session
        loadScanFromStorage().then(data => {
            if (data && data.items && data.items.length && !S.items.length && ui.restoreBtn) {
                ui.restoreBtn.hidden = false;
                log(`Найден сохранённый сеанс: ${data.items.length} файлов. Нажми «Продолжить прошлый сеанс».`, 'warn');
            }
        }).catch(e => {
            console.warn('YaDLer: ошибка проверки сохранённого сеанса', e);
        });

        if (ST.rememberDir) {
            idbGet('dir').then(async (saved) => {
                if (!saved || S.dir) return;
                try {
                    const p = await saved.queryPermission({ mode: 'readwrite' });
                    if (p === 'granted') {
                        S.dir = saved;
                        S.dirName = saved.name;
                        if (ui.sourceValue) {
                            ui.sourceValue.textContent = saved.name;
                            ui.sourceValue.title = 'Сохранение в папку: ' + saved.name;
                        }
                        log(`Папка восстановлена из памяти: «${saved.name}»`, 'ok');
                        syncUI();
                    }
                } catch { /* ignore */ }
            });
        }
        if (ST.autoScan && (parseHere() || privatePathFromUrl()) && !S.busy) setTimeout(() => { if (!S.busy && (parseHere() || privatePathFromUrl())) scan(); }, 400);
        setInterval(() => { if (ui.host && !ui.closed && !ui.host.isConnected) document.documentElement.append(ui.host); }, 3000);
        setTimeout(() => checkUpdate(false), 1500);
        setInterval(jobTick, 400);
    }
    Promise.race([PROMO_READY, new Promise((r) => setTimeout(r, 4000))]).then(boot);
})();

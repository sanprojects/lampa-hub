/*
 * Lampa Hub — единый магазин плагинов.
 * Объединяет магазины lampaplugins / k03mad / skaztv / bylampa / lampaguide + автопоиск на GitHub,
 * убирает дубли, ведёт историю (название, версия, дата, описание, источники и т.д.).
 * Каталог вшит при сборке (build/build.py), на устройстве обновляется сам.
 */
(function () {
    'use strict';

    var SEED = /*__SEED__*/null;
    var HUB_VERSION = '1.0.0';
    var K_SET = 'lampa_hub_settings', K_CACHE = 'lampa_hub_cache', K_HIST = 'lampa_hub_history';
    var GH_GROUP = 'Найдено в GitHub';
    var STORES = [
        { name: 'lampaplugins', url: 'https://lampaplugins.github.io/store/extensions.json', kind: 'json' },
        { name: 'k03mad', url: 'https://k03mad.github.io/lampa/store.json', kind: 'json' },
        { name: 'skaztv', url: 'https://skaztv.online/extensions.json', kind: 'json' },
        { name: 'bylampa', url: 'https://bylampa.github.io/addon.js', kind: 'bylampa' },
        { name: 'lampaguide', url: 'https://lampaguide.com/plugins', kind: 'lampaguide' }
    ];
    var PRIORITY = ['lampaplugins', 'skaztv', 'k03mad', 'bylampa', 'lampaguide', 'github'];
    /* доверенные источники: магазины, из которых собран хаб (их плагины идут первыми) */
    var TRUSTED = ['lampaplugins', 'skaztv', 'k03mad', 'bylampa', 'lampaguide'];
    var GH_QUERIES = ['topic:lampa-plugin', 'topic:lampa-plugins', 'lampa plugin in:name,description fork:false'];

    /* ------------------------------------------------------------------ helpers */
    function ls(k, d) { try { var v = Lampa.Storage.get(k, d === undefined ? '{}' : d); return v == null ? d : v; } catch (e) { return d; } }
    function lset(k, v) { try { Lampa.Storage.set(k, v); } catch (e) { /* quota */ } }
    function today() { return new Date().toISOString().slice(0, 10); }
    function noty(t) { try { Lampa.Noty.show(t); } catch (e) { /* ignore */ } }
    function each(o, f) { for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) f(o[k], k); }
    function clip(s, n) { s = (s || '') + ''; s = s.replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
    function esc(s) { return $('<div>').text(s == null ? '' : s).html(); }

    function settings() {
        var s = ls(K_SET, {});
        if (typeof s !== 'object' || !s) s = {};
        if (s.github === undefined) s.github = true;
        if (s.interval === undefined) s.interval = 24;
        if (s.auto === undefined) s.auto = true;
        if (!s.stores) s.stores = [];
        if (s.token === undefined) s.token = '';
        if (s.query === undefined) s.query = '';
        if (s.hide_github === undefined) s.hide_github = false;
        return s;
    }
    function saveSettings(s) { lset(K_SET, s); }

    function cache() {
        var c = ls(K_CACHE, {});
        if (typeof c !== 'object' || !c) c = {};
        c.raw = c.raw || [];
        c.sources = c.sources || {};
        c.gh = c.gh || { repos: {}, rejected: {} };
        c.probe = c.probe || {};
        return c;
    }
    function saveCache(c) { lset(K_CACHE, c); }

    /* same normalisation as build.py key() + Lampa's own plugin url rewrites */
    function keyOf(url) {
        var u = (url + '').trim().replace('cub.watch', 'cub.red').replace('bwa.to', 'bwa.ad');
        var m = u.match(/^(?:[a-z]+:)?\/\/([^\/?#]+)([^?#]*)(?:\?([^#]*))?/i);
        if (!m) return u.toLowerCase();
        var host = m[1].toLowerCase().replace(/^www\./, '');
        var q = (m[3] || '').split('&').filter(function (p) { return p && !/^(v|ver|version|t|_|cache|rnd)=/i.test(p); }).join('&');
        return host + m[2].replace(/\/+$/, '') + (q ? '?' + q : '');
    }

    /* ------------------------------------------------------------------ http */
    function http(url, opt, ok, fail) {
        opt = opt || {};
        var done = false;
        function fin(f, a, b) { if (!done) { done = true; f(a, b); } }
        function native() {
            try {
                var net = new Lampa.Reguest();
                net.timeout(opt.timeout || 15000);
                net.native(url, function (d) { fin(ok, typeof d === 'string' ? d : JSON.stringify(d), {}); },
                    function (e) { fin(fail, e); }, false, { dataType: 'text' });
            } catch (e) { fin(fail, e); }
        }
        try {
            var x = new XMLHttpRequest();
            x.open('GET', url, true);
            x.timeout = opt.timeout || 15000;
            if (opt.headers) each(opt.headers, function (v, k) { x.setRequestHeader(k, v); });
            x.onload = function () {
                if (x.status >= 200 && x.status < 300) {
                    fin(ok, x.responseText, { 'last-modified': x.getResponseHeader('Last-Modified'), status: x.status,
                        remaining: x.getResponseHeader('X-RateLimit-Remaining') });
                } else if (x.status === 403 || x.status === 429) { fin(fail, { status: x.status, rate: true }); }
                else { fin(fail, { status: x.status }); }
            };
            x.onerror = x.ontimeout = function () { if (opt.nofallback) fin(fail, { status: 0 }); else { done = false; native(); } };
            x.send();
        } catch (e) { native(); }
    }
    function httpJSON(url, opt, ok, fail) {
        http(url, opt, function (t, h) { var j; try { j = JSON.parse(t); } catch (e) { return fail({ parse: true }); } ok(j, h); }, fail);
    }

    /* live "does the plugin work" check, same idea as Lampa's own extensions page:
       download the script, a body mentioning "Lampa." = works (200), otherwise 500; a failed request = its status / 404 */
    var K_STAT = 'lampa_hub_status', STAT_TTL = 3 * 36e5, statMem = null, statJobs = [], statBusy = 0;
    function statAll() { if (!statMem) { statMem = ls(K_STAT, {}); if (typeof statMem !== 'object' || !statMem) statMem = {}; } return statMem; }
    function statFresh(url) { var r = statAll()[url]; return r && Date.now() - r.t < STAT_TTL ? r : null; }
    function statPump() {
        while (statBusy < 4 && statJobs.length) {
            statBusy++;
            (function (j) {
                function fin(r) {
                    r.t = Date.now(); statAll()[j.url] = r;
                    try { lset(K_STAT, statAll()); } catch (e) { /* ignore */ }
                    statBusy--; j.cb(r); statPump();
                }
                http(j.url, { timeout: 5000 }, function (body) {
                    fin(/Lampa\./.test(body) ? { code: 200, ok: 1, txt: 'Рабочий' } : { code: 500, ok: 0, txt: 'Плагин не подтверждён' });
                }, function (e) {
                    var st = e && e.status;
                    if (!st && j.probe && j.probe.http === 200 && j.probe.lampa) fin({ code: 200, ok: 2, txt: 'Рабочий · по сборке' });
                    else fin({ code: st || 404, ok: 0, txt: 'Ошибка' });
                });
            })(statJobs.shift());
        }
    }
    function statCheck(url, probe, cb) {
        var r = statFresh(url);
        if (r) return cb(r, true);
        statJobs.push({ url: url, probe: probe, cb: cb }); statPump();
    }
    function loadFailed(url) { try { return (Lampa.Plugins.errors() || []).indexOf(url) >= 0; } catch (e) { return false; } }

    /* ------------------------------------------------------------------ source parsers */
    var GROUPS = { 'онлайн видео': 'Онлайн', 'онлайн': 'Онлайн', 'телевидение': 'ТВ', 'управление': 'Управление', 'разное': 'Разное',
        'мои': 'Разное', 'сообщество': 'Разное', 'интерфейс': 'Интерфейс', 'торренты': 'Торренты', 'тв': 'ТВ', 'радио': 'Радио',
        'музыка': 'Музыка', '18+': '18+', 'tmdb proxy': 'TMDB Proxy' };
    function normGroup(g) {
        if (!g) return null;
        g = (g + '').trim();
        if (g.charAt(0) === '@' || g.toLowerCase() === 'популярные') return null;
        return GROUPS[g.toLowerCase()] || g;
    }
    function validUrl(u) { return /^https?:\/\/[^\s<>]+$/.test((u + '').trim()); }

    function parseJsonStore(name, data) {
        var out = [];
        (data.results || []).forEach(function (g) {
            (g.results || []).forEach(function (r) {
                out.push({ url: r.link, name: r.name, source: name, descr: r.descr, author: r.author, version: r.version,
                    group: normGroup(g.title), popular: g.hpu === 'best' || undefined });
            });
        });
        return out;
    }
    function parseBylampa(name, text) {
        var CAT = { interface: 'Интерфейс', management: 'Управление', music: 'Музыка', online: 'Онлайн', radio: 'Радио', sisi: '18+',
            tmdb_proxy: 'TMDB Proxy', tv: 'ТВ', torrent: 'Торренты' };
        var out = [];
        text.split('Lampa.SettingsApi.addParam(').forEach(function (b) {
            var m = b.match(/itemON\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]*)['"]/);
            if (!m) return;
            var c = b.match(/component:\s*['"]add_(\w+?)_plugin['"]/);
            var d = b.match(/field:\s*\{[^}]*?description:\s*'((?:[^'\\]|\\.)*)'/);
            out.push({ url: m[1], name: m[2], source: name, author: m[3], descr: d ? d[1].replace(/\\'/g, "'") : null, group: c ? CAT[c[1]] : null });
        });
        return out;
    }
    function parseLampaguide(name, text) {
        var SEC = { online: 'Онлайн', torrent: 'Торренты', tv: 'ТВ', interface: 'Интерфейс', tools: 'Инструменты', integration: 'Интеграции',
            mediaserver: 'Медиасерверы', stores: 'Магазины', radio: 'Радио', adult: '18+', special: 'Специальные', system: 'Системные' };
        var out = [];
        var doc = new DOMParser().parseFromString(text, 'text/html');
        var secs = doc.querySelectorAll('section[id$="-plugins"]');
        for (var i = 0; i < secs.length; i++) {
            var sec = secs[i].id.replace(/-plugins$/, '');
            var cards = secs[i].querySelectorAll('.plugin-card');
            for (var j = 0; j < cards.length; j++) {
                var c = cards[j], code = c.querySelector('code'), a = c.querySelector('h3 a'), p = c.querySelector('p'), st = c.querySelector('.plugin-status');
                var url = code ? code.textContent.trim() : '';
                if (!validUrl(url) || !a) continue;
                out.push({ url: url, name: a.textContent.replace(/^[^\w\[(А-Яа-я]+/, '').trim(), source: name, group: SEC[sec],
                    descr: p ? p.textContent.replace(/\s*Плагин для Lampa: адрес для установки, статус и пошаговая инструкция\.?/, '').trim() : null,
                    status: st ? st.className.split(/\s+/).pop() : null, page: a.getAttribute('href') ? 'https://lampaguide.com' + a.getAttribute('href') : null });
            }
        }
        return out;
    }

    /* script header probing: version / description / Last-Modified */
    var RE_VER = [/@version\s+v?([\w.\-+]+)/i, /\bversion['"]?\s*[:=]\s*['"]v?(\d[\w.\-+]*)['"]/i, /\bplugin_version\s*=\s*['"]v?(\d[\w.\-+]*)['"]/i,
        /\bVERSION\s*=\s*['"]v?(\d[\w.\-+]*)['"]/, /\/\/\s*v(?:ersion)?[:\s]\s*v?(\d+\.\d+[\w.\-+]*)/i];
    function parseScript(txt, headers) {
        var info = { checked: today(), http: 200 };
        txt = txt.slice(0, 120000);
        for (var i = 0; i < RE_VER.length; i++) { var m = txt.match(RE_VER[i]); if (m) { info.ver_parsed = m[1]; break; } }
        var d = txt.match(/@description\s+(.+)/) || txt.match(/\bdescription['"]?\s*:\s*['"]([^'"\n]{8,200})['"]/);
        if (d) info.descr_parsed = d[1].trim();
        var a = txt.match(/@(?:author|autor)\s+(.+)/);
        if (a) info.author_parsed = a[1].trim();
        info.lampa = /\bLampa\b/.test(txt);
        info.size = txt.length;
        if (headers && headers['last-modified']) { var t = new Date(headers['last-modified']); if (!isNaN(t)) info.updated = t.toISOString().slice(0, 10); }
        return info;
    }

    /* ------------------------------------------------------------------ catalog merge */
    function rank(s) { var i = PRIORITY.indexOf(s); return i < 0 ? 99 : i; }

    function buildCatalog() {
        var byk = {}, order = [];
        function take(p) {
            var k = p.id || keyOf(p.url);
            var e = byk[k];
            if (!e) { e = byk[k] = JSON.parse(JSON.stringify(p)); e.id = k; e.sources = e.sources || []; order.push(k); return; }
            if (e.url !== p.url && p.url && (e.mirrors || []).indexOf(p.url) < 0) e.mirrors = (e.mirrors || []).concat([p.url]);
            ['author', 'version', 'page', 'img', 'status', 'updated', 'repo', 'stars', 'pushed', 'created', 'topics', 'license', 'homepage', 'popular', 'probe'].forEach(function (f) {
                if (e[f] == null && p[f] != null) e[f] = p[f];
            });
            if (p.descr && (!e.descr || p.descr.length > e.descr.length)) e.descr = p.descr;
            (p.sources || []).forEach(function (s) { if (e.sources.indexOf(s) < 0) e.sources.push(s); });
            if (p.group && (e.group === 'Разное' || !e.group) && p.group !== GH_GROUP) e.group = p.group;
        }
        (SEED && SEED.plugins || []).forEach(take);
        var c = cache();
        c.raw.forEach(function (r) {
            if (!r.url || !validUrl(r.url)) return;
            var k = keyOf(r.url);
            take({ id: k, name: r.name || k, url: r.url, author: r.author, descr: r.descr, version: r.version, group: r.group || 'Разное',
                sources: [r.source], page: r.page, status: r.status, popular: r.popular, repo: r.repo, stars: r.stars, pushed: r.pushed,
                created: r.created, topics: r.topics, license: r.license, homepage: r.homepage, found: r.found });
        });
        var list = order.map(function (k) {
            var e = byk[k], pr = c.probe[k];
            if (pr && pr.http === 200) {
                if (pr.ver_parsed && !e.version) e.version = pr.ver_parsed;
                if (pr.updated) e.updated = pr.updated;
                if (pr.descr_parsed && !e.descr) e.descr = pr.descr_parsed;
                e.probe = pr;
            }
            if (!e.updated && e.pushed) e.updated = e.pushed;
            e.sources.sort(function (a, b) { return rank(a) - rank(b); });
            return e;
        });
        return list;
    }

    /* ------------------------------------------------------------------ history */
    function history() { var h = ls(K_HIST, '[]'); return Object.prototype.toString.call(h) === '[object Array]' ? h : []; }
    function logEvent(type, p, extra) {
        var h = history();
        h.unshift({ ts: Date.now(), date: today(), type: type, id: p.id, name: p.name, version: p.version || null, updated: p.updated || null,
            descr: p.descr || null, url: p.url, author: p.author || null, group: p.group || null, sources: p.sources || [], extra: extra || null });
        lset(K_HIST, h.slice(0, 600));
    }
    var TYPE_TXT = { installed: 'установлен', removed: 'удалён', updated: 'обновление версии', 'new': 'новый в каталоге', enabled: 'включён', disabled: 'выключен', checked: 'проверен' };

    /* ------------------------------------------------------------------ installed plugins */
    /* Установленные плагины: локальные (Lampa.Plugins) и из аккаунта CUB (account_plugins). Как и в оригинальном
       «Расширения», плагин из CUB можно включить/выключить (через Account.Api.pluginToggle), но не удалить. */
    var instMemo = null, cubMem = null;
    function dirty() { instMemo = null; cubMem = null; }
    function cubAll() {
        if (!cubMem) {
            var a = ls('account_plugins', '[]');
            if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = []; } }
            cubMem = Object.prototype.toString.call(a) === '[object Array]' ? a : [];
        }
        return cubMem;
    }
    function installedMap() {
        if (instMemo) return instMemo;
        var m = {};
        try { Lampa.Plugins.get().forEach(function (p) { m[keyOf(p.url)] = { url: p.url, status: p.status ? 1 : 0, name: p.name, local: p, cub: null }; }); } catch (e) { /* ignore */ }
        cubAll().forEach(function (c) {
            if (!c || !c.url) return;
            var k = keyOf(c.url), v = m[k] || (m[k] = { url: c.url, status: 0, name: c.name, local: null, cub: null });
            v.cub = c; v.status = v.status || c.status ? 1 : 0;
        });
        (SEED && SEED.plugins || []).forEach(function (p) {
            if (m[p.id] || !p.mirrors) return;
            for (var i = 0; i < p.mirrors.length; i++) { var a = m[keyOf(p.mirrors[i])]; if (a) { m[p.id] = a; return; } }
        });
        return (instMemo = m);
    }
    /* что изменилось с момента запуска Lampa: плагины подключаются при старте, так что убранный плагин
       исчезает, а добавленный (не всегда) заработает полностью только после перезагрузки */
    var base = {};
    function touch(id) { if (!(id in base)) { var v = installedMap()[id]; base[id] = !!(v && v.status); } }
    function pending() {
        var inst = installedMap(), add = 0, rem = 0;
        Object.keys(base).forEach(function (id) {
            var now = !!(inst[id] && inst[id].status);
            if (now && !base[id]) add++;
            else if (!now && base[id]) rem++;
        });
        return { add: add, rem: rem };
    }
    function reloadSub() {
        var c = pending(), t = [];
        if (c.add) t.push('+' + c.add + ' установлено');
        if (c.rem) t.push('\u2212' + c.rem + ' убрано');
        return t.length ? t.join(', ') + ' — применить' : 'изменений нет';
    }
    var reloadNode = null;
    function syncReload() {
        if (!reloadNode) return;
        var c = pending();
        reloadNode.childNodes[1].textContent = reloadSub();
        reloadNode.className = reloadNode.className.replace(' hub-act--pending', '') + (c.add || c.rem ? ' hub-act--pending' : '');
    }

    function install(p, done) {
        if (installedMap()[p.id]) { noty('Уже установлен'); return done && done(); }
        touch(p.id);
        Lampa.Plugins.add({ url: p.url, status: 1, name: p.name, author: p.author || '@hub' });
        dirty();
        logEvent('installed', p);
        noty('Установлен: ' + p.name);
        done && done();
    }
    function uninstall(p, done) {
        var v = installedMap()[p.id];
        if (!v) return done && done();
        if (!v.local) { noty('Установлен через CUB — удалить можно только на cub.best, здесь его можно лишь выключить'); return done && done(); }
        touch(p.id);
        /* одна и та же ссылка могла быть добавлена дважды (хаб + штатный раздел, http/https): убираем все записи */
        var keys = {}; keys[p.id] = 1; keys[keyOf(v.url)] = 1;
        (p.mirrors || []).forEach(function (m) { keys[keyOf(m)] = 1; });
        var same = [];
        try { Lampa.Plugins.get().forEach(function (x) { if (x && x.url && keys[keyOf(x.url)]) same.push(x); }); } catch (e) { /* ignore */ }
        if (same.indexOf(v.local) < 0) same.push(v.local);
        same.forEach(function (x) { Lampa.Plugins.remove(x); });
        if (v.cub && v.cub.status) {
            v.cub.status = 0;
            try { Lampa.Account.Api.pluginToggle(v.cub, 0); } catch (e) { /* offline */ }
            lset('account_plugins', cubAll());
        }
        dirty();
        logEvent('removed', p);
        noty('Удалён: ' + p.name + (v.cub ? '. В CUB он выключен, удалить его оттуда можно на cub.best' : '. Перезагрузите Lampa, чтобы он перестал работать'));
        done && done();
    }
    function toggle(p, done) {
        var v = installedMap()[p.id];
        if (!v) return done && done();
        var st = v.status ? 0 : 1;
        touch(p.id);
        if (v.local) { v.local.status = st; Lampa.Plugins.save(); }
        if (v.cub) {
            v.cub.status = st;
            try { Lampa.Account.Api.pluginToggle(v.cub, st); } catch (e) { /* offline */ }
            lset('account_plugins', cubAll());
        }
        if (st) { try { Lampa.Plugins.push(v.local || v.cub); } catch (e) { /* loads on next start */ } }
        dirty();
        logEvent(st ? 'enabled' : 'disabled', p);
        noty((st ? 'Включён: ' : 'Выключен: ') + p.name + (st ? '' : '. Нужна перезагрузка'));
        done && done();
    }

    /* ------------------------------------------------------------------ refresh (stores + GitHub + probes) */
    var refreshing = false;

    function queue(items, worker, parallel, done) {
        var i = 0, active = 0, finished = false;
        function next() {
            if (finished) return;
            if (i >= items.length && active === 0) { finished = true; return done(); }
            while (active < parallel && i < items.length) {
                (function (it) { active++; worker(it, function () { active--; next(); }); })(items[i++]);
            }
        }
        next();
    }

    function refresh(opt, finish) {
        opt = opt || {};
        if (refreshing) return finish && finish('busy');
        refreshing = true;
        var set = settings(), c = cache(), before = {}, report = [];
        buildCatalog().forEach(function (p) { before[p.id] = p; });
        var stores = STORES.concat((set.stores || []).map(function (u, i) { return { name: 'custom' + (i + 1), url: u, kind: /\.json(\?|$)/.test(u) ? 'json' : 'auto' }; }));
        var fresh = {};

        function stage1(cb) {
            queue(stores, function (s, next) {
                http(s.url, { timeout: 20000 }, function (text) {
                    var recs = [];
                    try {
                        if (s.kind === 'json') recs = parseJsonStore(s.name, JSON.parse(text));
                        else if (s.kind === 'bylampa') recs = parseBylampa(s.name, text);
                        else if (s.kind === 'lampaguide') recs = parseLampaguide(s.name, text);
                        else {
                            try { recs = parseJsonStore(s.name, JSON.parse(text)); } catch (e) {
                                var m = text.match(/store\s*:\s*['"]([^'"]+)['"]/);   // store.js that opens Extensions.show({store})
                                if (m) { s.follow = m[1]; } else recs = parseBylampa(s.name, text);
                            }
                        }
                    } catch (e) { c.sources[s.name] = { ok: false, ts: Date.now(), err: 'parse' }; return next(); }
                    if (s.follow) {
                        return http(s.follow, { timeout: 20000 }, function (t2) {
                            try { recs = parseJsonStore(s.name, JSON.parse(t2)); fresh[s.name] = recs; c.sources[s.name] = { ok: true, ts: Date.now(), count: recs.length }; } catch (e) { c.sources[s.name] = { ok: false, ts: Date.now(), err: 'parse' }; }
                            next();
                        }, function () { c.sources[s.name] = { ok: false, ts: Date.now(), err: 'network' }; next(); });
                    }
                    fresh[s.name] = recs; c.sources[s.name] = { ok: true, ts: Date.now(), count: recs.length };
                    next();
                }, function (e) { c.sources[s.name] = { ok: false, ts: Date.now(), err: e && e.status ? 'HTTP ' + e.status : 'недоступен' }; next(); });
            }, 3, cb);
        }

        function stage2(cb) {   // GitHub discovery
            if (!set.github) return cb();
            var hd = { 'Accept': 'application/vnd.github+json' };
            if (set.token) hd.Authorization = 'Bearer ' + set.token;
            var repos = {}, limited = false;
            var queries = GH_QUERIES.concat(set.query ? [set.query] : []);
            queue(queries, function (q, next) {
                if (limited) return next();
                httpJSON('https://api.github.com/search/repositories?per_page=30&sort=updated&q=' + encodeURIComponent(q), { headers: hd, nofallback: true }, function (d) {
                    (d.items || []).forEach(function (r) { if (!r.fork && !r.archived) repos[r.full_name] = r; });
                    next();
                }, function (e) { if (e && e.rate) limited = true; next(); });
            }, 1, function () {
                var names = Object.keys(repos).filter(function (n) { return c.gh.repos[n] !== repos[n].pushed_at; }).slice(0, opt.deep ? 40 : 12);
                var found = [];
                var known = {}; buildCatalog().forEach(function (p) { known[p.id] = 1; });
                queue(names, function (n, next) {
                    var r = repos[n], br = r.default_branch || 'main';
                    httpJSON('https://data.jsdelivr.com/v1/package/gh/' + n + '@' + br + '/flat', {}, function (d) {
                        var cands = (d.files || []).filter(function (f) { return /\.js$/.test(f.name) && !/\.min\.js$/.test(f.name) && f.name.indexOf('node_modules') < 0 && f.size > 400 && f.size < 800000; }).slice(0, 8);
                        queue(cands, function (f, n2) {
                            var path = f.name.replace(/^\//, '');
                            var url = r.has_pages ? 'https://' + r.owner.login.toLowerCase() + '.github.io/' + r.name + '/' + path : 'https://cdn.jsdelivr.net/gh/' + n + '@' + br + '/' + path;
                            var k = keyOf(url);
                            if (known[k] || c.gh.rejected[k]) return n2();
                            http(url, { timeout: 15000 }, function (body, h) {
                                if (!/Lampa\.(Plugin|Listener|Template|Settings|SettingsApi|Component|Manifest|Utils|Storage)/.test(body)) { c.gh.rejected[k] = today(); return n2(); }
                                var info = parseScript(body, h);
                                c.probe[k] = info;
                                found.push({ url: url, name: path.split('/').pop().replace(/\.js$/, ''), source: 'github', author: '@' + r.owner.login, descr: r.description || info.descr_parsed,
                                    version: info.ver_parsed, group: GH_GROUP, repo: n, stars: r.stargazers_count, pushed: (r.pushed_at || '').slice(0, 10),
                                    created: (r.created_at || '').slice(0, 10), topics: r.topics, license: r.license && r.license.spdx_id, homepage: r.html_url, found: true });
                                n2();
                            }, function () { n2(); });
                        }, 3, function () { c.gh.repos[n] = r.pushed_at; next(); });
                    }, function () { next(); });
                }, 2, function () { fresh.github = (fresh.github || []).concat(found); cb(); });
            });
        }

        function stage3(cb) {   // probe installed plugins: version + last-modified
            var inst = installedMap(), list = buildCatalog().filter(function (p) { return inst[p.id]; });
            queue(list, function (p, next) {
                http(p.url, { timeout: 12000 }, function (body, h) { c.probe[p.id] = parseScript(body, h); next(); }, function () { next(); });
            }, 3, cb);
        }

        stage1(function () {
            stage2(function () {
                stage3(function () {
                    // keep previously found github items, replace per-source raw sets from stores
                    var keepGh = c.raw.filter(function (r) { return r.source === 'github'; });
                    var raw = [];
                    each(fresh, function (recs, name) { if (name !== 'github') raw = raw.concat(recs); });
                    STORES.concat((set.stores || []).map(function (u, i) { return { name: 'custom' + (i + 1) }; })).forEach(function (s) {
                        if (!fresh[s.name]) raw = raw.concat(c.raw.filter(function (r) { return r.source === s.name; }));
                    });
                    c.raw = raw.concat(keepGh, fresh.github || []);
                    c.ts = Date.now();
                    saveCache(c);
                    var after = buildCatalog(), nNew = 0, nUpd = 0, vers = ls('lampa_hub_versions', {});
                    after.forEach(function (p) {
                        if (!before[p.id] && SEED) { nNew++; logEvent('new', p); }
                        var pv = vers[p.id];
                        if (p.version) {
                            if (pv && pv !== p.version) { nUpd++; logEvent('updated', p, { from: pv, to: p.version }); }
                            vers[p.id] = p.version;
                        }
                    });
                    lset('lampa_hub_versions', vers);
                    refreshing = false;
                    var ok = 0, bad = 0; each(c.sources, function (s) { if (s.ok) ok++; else bad++; });
                    finish && finish(null, { total: after.length, nNew: nNew, nUpd: nUpd, ok: ok, bad: bad });
                });
            });
        });
    }

    /* ------------------------------------------------------------------ UI: page in the look of Lampa's official "Расширения" */
    var CSS = '' +
        '.hub-card .hub-shot{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .3s}' +
        '.hub-card .hub-shot.loaded{opacity:1}' +
        '.hub-card .extensions__item-author{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.hub-card .extensions__item-name{overflow:hidden;text-overflow:ellipsis}' +
        '.hub-card .extensions__item-descr{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:3em;margin-top:.5em;opacity:.8}' +
        '.hub-card .extensions__item-body{position:relative}' +
        '.hub-card .extensions__item-author{padding-right:6em}' +
        '.hub-card .extensions__item-footer{flex-wrap:wrap;margin-top:auto;padding-top:.6em;min-height:2.2em;align-items:center}' +
        '.hub-card .hub-meta{font-size:.78em;color:#8D8D8D;margin-top:.5em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.hub-card .hub-meta b{color:#ffd666;font-weight:600;margin-right:.7em}' +
        '.hub-card .hub-url{font-size:.78em;color:#8D8D8D;opacity:.75;margin-top:.3em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.hub-card .hub-url{display:flex;align-items:center}' +
        '.hub-card .hub-url span{overflow:hidden;text-overflow:ellipsis}' +
        '.hub-fav{width:1.1em;height:1.1em;margin-right:.45em;flex-shrink:0;border-radius:.2em}' +
        '.hub-card .hub-flags{font-size:.78em;margin-top:.3em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.hub-flags span{margin-right:.8em}.hub-flag--ok{color:#6DCE4B}.hub-flag--warn{color:#ffd016}.hub-flag--risk{color:#ff6e6e}' +
        '.hub-rd{padding:.7em 1em;margin:.4em 0;border-radius:.4em;background-color:rgba(255,255,255,.04);line-height:1.45}' +
        '.hub-rd.focus{background-color:rgba(255,255,255,.14)}' +
        '.hub-rd__t{font-weight:600;margin-bottom:.4em}.hub-rd__l{margin:.15em 0;word-break:break-word}.hub-rd__k{color:#8D8D8D}' +
        '.hub-rd__note{font-size:.85em;color:#8D8D8D}' +
        '.hub-md .hub-md__i{margin:.45em 0;word-break:break-word}' +
        '.hub-md .hub-md__i.focus,.hub-md .hub-md__i.hover{background:none;box-shadow:none;outline:none}' +
        '.hub-md__h1{font-size:1.5em;font-weight:700;margin-top:.9em!important}.hub-md__h2{font-size:1.25em;font-weight:700;margin-top:.8em!important}.hub-md__h3{font-size:1.08em;font-weight:600;margin-top:.7em!important}' +
        '.hub-md__li{margin-top:.2em!important;margin-bottom:.2em!important}.hub-md__n{color:#8D8D8D}' +
        '.hub-md__q{border-left:.2em solid rgba(255,255,255,.25);padding-left:.8em;opacity:.8}' +
        '.hub-md__row{font-size:.9em;opacity:.9}' +
        '.hub-md__code{font-family:monospace;font-size:.85em;white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.3);border-radius:.3em;padding:.6em .8em}' +
        '.hub-md code{font-family:monospace;font-size:.9em;background:rgba(0,0,0,.3);border-radius:.25em;padding:.05em .35em}' +
        '.hub-md__a{text-decoration:underline;opacity:.9}' +
        '.hub-btns{display:flex;flex-wrap:wrap;margin-bottom:.6em}' +
        '.hub-badge{position:absolute;top:0;right:0;background-color:rgba(0,0,0,.18);border-radius:.3em;padding:.3em .4em .4em;font-size:.78em}' +
        '.hub-badge--free{color:#6DCE4B}.hub-badge--shareware{color:#ffd016}.hub-badge--paid{color:#8D8D8D}.hub-badge--bad{color:#ff9d6e}' +
        '.hub-card .extensions__item-footer .extensions__item-included{position:static;width:1.2em;height:1.2em;padding-top:.24em;margin:0 .5em 0 0;flex-shrink:0;background-color:rgba(0,0,0,.18)}' +
        '.hub-card .extensions__item-proto{margin-right:.5em;flex-shrink:0;line-height:0}' +
        '.hub-state{display:flex;align-items:center;min-width:0}' +
        '.hub-state .extensions__item-check,.hub-state .extensions__item-error{margin-right:.5em;flex-shrink:0}' +
        '.hub-state .extensions__item-code{margin-right:.5em;font-size:.78em;white-space:nowrap}' +
        '.hub-state .extensions__item-status{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.hub-act{flex-direction:column;text-align:center}' +
        '.hub-act__title{font-size:1.2em;margin-bottom:.4em}' +
        '.hub-act__sub{font-size:.84em;color:#8D8D8D;line-height:1.4}' +
        '.hub-act--pending .hub-act__sub{color:#fff}' +
        '.hub-act--pending:not(.focus){background:rgba(76,175,80,.25)}' +
        '.hub-page .extensions__block-title span{color:#8D8D8D;font-size:.8em;margin-left:.6em}';

    function injectCss() {
        if (document.getElementById('lampa-hub-css')) return;
        var st = document.createElement('style'); st.id = 'lampa-hub-css'; st.textContent = CSS; document.head.appendChild(st);
    }

    function newIdsMap() {
        var m = {}, lim = Date.now() - 14 * 864e5;
        history().forEach(function (h) { if (h.type === 'new' && h.ts > lim) m[h.id] = 1; });
        return m;
    }
    function ownerOf(p) {
        if (p.repo) return p.repo.split('/')[0];
        var u = p.url || '', m = u.match(/^https?:\/\/([^\/.]+)\.github\.io\//i);
        if (m) return m[1];
        m = u.match(/(?:raw\.githubusercontent\.com|cdn\.jsdelivr\.net\/gh|github\.com)\/([^\/@]+)\//i);
        return m ? m[1] : null;
    }
    function hueOf(s) { var h = 0; s = s || ''; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) % 360; }
    function authorOf(p) { var a = p.author; if (a) return a.charAt(0) === '@' ? a : '@' + a; return p.sources && p.sources[0] ? p.sources[0] : ''; }
    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

    var LOCK_SVG = '<svg width="21" height="30" viewBox="0 0 21 30" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10.5" cy="8.5" r="7" stroke="currentColor" stroke-width="3"/><rect y="9" width="21" height="21" rx="4" fill="currentColor"/></svg>';
    function shortUrl(u) { u = (u + '').replace(/^[a-z]+:\/\//i, '').replace(/^www\./i, '').replace(/[?#].*$/, ''); return u.length > 44 ? u.slice(0, 43) + '…' : u; }

    /* status line of a card: loader -> "200 Рабочий" / "500 Плагин не подтверждён" / "404 Ошибка"; red "!" = Lampa failed to load it */
    function stateLine(card, o) {
        var line = el('div', 'hub-state'), started = false;
        function show(r) {
            line.innerHTML = '';
            if (loadFailed(o.statusUrl)) { var bad = el('div', 'extensions__item-error'); bad.title = 'Lampa не смогла загрузить плагин'; line.appendChild(bad); }
            line.appendChild(el('div', 'extensions__item-code ' + (r.ok === 1 ? 'success' : r.ok === 2 ? 'yellow' : 'error'), r.code));
            line.appendChild(el('div', 'extensions__item-status', r.txt));
        }
        function start() {
            if (started) return; started = true;
            var hit = statFresh(o.statusUrl);
            if (hit) return show(hit);
            line.appendChild(el('div', 'extensions__item-check'));
            statCheck(o.statusUrl, o.probe, show);
        }
        card.addEventListener('visible', start);
        card.addEventListener('hover:focus', start);
        return line;
    }

    /* card skeleton shared by plugin / history cards */
    function baseCard(o) {
        var c = el('div', 'extensions__item extensions__item--store hub-card selector layer--visible layer--render');
        var box = el('div', 'extensions__item-imagebox'), h = hueOf(o.seed || o.name);
        var stops = 'hsla(' + h + ',60%,48%,.6) 0%, hsla(' + h + ',60%,48%,.25) 45%, hsla(' + h + ',60%,48%,.06) 100%';
        box.style.backgroundImage = 'radial-gradient(ellipse farthest-corner at center, ' + stops + ')';
        var letter = el('div', 'extensions__item-letter', (o.name || '?').trim().slice(0, 1).toUpperCase());
        box.appendChild(letter);
        if (o.avatar) {
            var img = el('img', 'extensions__item-icon');
            img.onload = function () { img.className += ' loaded'; letter.style.display = 'none'; };
            img.onerror = function () { img.style.display = 'none'; };
            img.src = 'https://github.com/' + encodeURIComponent(o.avatar) + '.png?size=120';
            box.appendChild(img);
        }
        if (o.img) {
            var shot = el('img', 'hub-shot');
            shot.onload = function () { shot.className += ' loaded'; };
            shot.onerror = function () { shot.parentNode && shot.parentNode.removeChild(shot); };
            shot.src = o.img;
            box.appendChild(shot);
        }
        var body = el('div', 'extensions__item-body');
        if (o.badge) body.appendChild(el('div', 'hub-badge hub-badge--' + o.badge[1], o.badge[0]));
        body.appendChild(el('div', 'extensions__item-author', o.author || ''));
        body.appendChild(el('div', 'extensions__item-name', o.name));
        if (o.descr) body.appendChild(el('div', 'extensions__item-descr', clip(o.descr, 150)));
        var meta = el('div', 'hub-meta');
        if (o.stars) meta.appendChild(el('b', '', '★ ' + o.stars));
        meta.appendChild(document.createTextNode([o.version ? 'v' + o.version : '', o.date || ''].filter(Boolean).join(' · ')));
        if (meta.textContent) body.appendChild(meta);
        if (o.statusUrl) {
            var ur = el('div', 'hub-url');
            ur.appendChild(fav(o.domain || (o.statusUrl.split('/')[2] || '')));
            ur.appendChild(el('span', '', shortUrl(o.statusUrl)));
            body.appendChild(ur);
        }
        var fl = el('div', 'hub-flags');
        if (o.trusted) fl.appendChild(el('span', 'hub-flag--ok', '✔ Доверенный'));
        if (o.scan) { var sh = SCAN_SHORT[o.scan.v]; if (sh) fl.appendChild(el('span', 'hub-flag--' + o.scan.v, sh)); }
        if (fl.firstChild) body.appendChild(fl);
        var foot = el('div', 'extensions__item-footer');
        if (o.check) foot.appendChild(el('div', 'extensions__item-included'));
        if (o.statusUrl) {
            var lock = el('div', 'extensions__item-proto protocol-' + (/^https:/i.test(o.statusUrl) ? 'https' : 'http'));
            lock.innerHTML = LOCK_SVG; foot.appendChild(lock);
            foot.appendChild(stateLine(c, o));
        }
        body.appendChild(foot);
        c.appendChild(box); c.appendChild(body);
        return c;
    }

    /* Живые карточки плагинов: после установки/удаления/переключения обновляются на месте, без перестройки страницы */
    var cards = {};
    function badgeOf(p, v, nw) {
        if (v) return v.status ? ['Установлен', 'free'] : ['Выключен', 'bad'];
        if (nw[p.id]) return ['Новое', 'shareware'];
        if (p.found) return ['GitHub', 'paid'];
        return null;
    }
    function decorate(c, p, v, nw) {
        var body = c.querySelector('.extensions__item-body'), foot = c.querySelector('.extensions__item-footer');
        var b = body.querySelector('.hub-badge'), badge = badgeOf(p, v, nw);
        if (!badge) { if (b) b.parentNode.removeChild(b); }
        else {
            if (!b) { b = el('div'); body.insertBefore(b, body.firstChild); }
            b.className = 'hub-badge hub-badge--' + badge[1]; b.textContent = badge[0];
        }
        var ch = foot.querySelector('.extensions__item-included'), on = !!(v && v.status);
        if (on && !ch) foot.insertBefore(el('div', 'extensions__item-included'), foot.firstChild);
        else if (!on && ch) foot.removeChild(ch);
        var tag = c.querySelector('.extensions__cub');
        if (v && v.cub && !tag) c.appendChild(el('div', 'extensions__cub', 'CUB'));
        else if (!(v && v.cub) && tag) c.removeChild(tag);
    }
    function refreshCards(id) {
        var inst = installedMap();
        (id ? [id] : Object.keys(cards)).forEach(function (k) {
            (cards[k] || []).forEach(function (r) { decorate(r.node, r.p, inst[k], r.nw); });
        });
    }

    function pluginCard(p, ctx) {
        var c = baseCard({ name: p.name, seed: p.id, author: authorOf(p), descr: p.descr, stars: p.stars, version: p.version, date: p.updated,
            avatar: ownerOf(p), img: p.img, statusUrl: p.url, probe: p.probe, domain: p.domain, trusted: isTrusted(p), scan: p.scan });
        decorate(c, p, installedMap()[p.id], ctx.nw);
        (cards[p.id] = cards[p.id] || []).push({ node: c, p: p, nw: ctx.nw });
        c.addEventListener('hover:enter', function () { showDetail(p, pageToggle); });
        return c;
    }

    var HIST_BADGE = { installed: 'free', removed: 'paid', updated: 'shareware', 'new': 'shareware', enabled: 'free', disabled: 'bad' };
    function historyCard(e, ctx) {
        var txt = (TYPE_TXT[e.type] || e.type) + (e.extra && e.extra.from ? ': ' + e.extra.from + ' → ' + e.extra.to : '');
        var c = baseCard({ name: e.name, seed: e.id, author: e.date, descr: txt + (e.descr ? ' · ' + e.descr : ''), version: e.version, date: e.updated,
            avatar: ownerOf({ url: e.url }), badge: [TYPE_TXT[e.type] || e.type, HIST_BADGE[e.type] || 'shareware'] });
        c.addEventListener('hover:enter', function () {
            var p = ctx.all.filter(function (x) { return x.id === e.id; })[0] || { id: e.id, name: e.name, url: e.url, version: e.version, descr: e.descr,
                author: e.author, group: e.group, sources: e.sources || [], updated: e.updated };
            showDetail(p, pageToggle);
        });
        return c;
    }

    function actionCard(a) {
        var c = el('div', 'extensions__block-add hub-act selector layer--visible layer--render');
        c.appendChild(el('div', 'hub-act__title', a.title));
        c.appendChild(el('div', 'hub-act__sub', a.sub || ''));
        c.addEventListener('hover:enter', function () { a.run(); });
        if (a.id === 'reload') { reloadNode = c; if (a.pending) c.className += ' hub-act--pending'; }
        return c;
    }

    var page = null;

    function pageToggle() { if (page) page.toggle(); }

    /* one horizontal row of cards; cards are appended lazily in batches */
    function makeRow(def, idx) {
        var r = { def: def, els: [], shown: 0, active: 0, last: null };
        r.scroll = new Lampa.Scroll({ horizontal: true, step: window.innerWidth / 4 });
        r.html = $('<div class="extensions__block layer--visible layer--render"><div class="extensions__block-head"><div class="extensions__block-title"></div></div><div class="extensions__block-body"></div></div>');
        var t = r.html.find('.extensions__block-title');
        t.text(def.title); if (def.count) t.append($('<span></span>').text(def.count));
        r.html.find('.extensions__block-body').append(r.scroll.render());
        r.scroll.onWheel = function (step) {
            if (!Lampa.Controller.own(r)) r.toggle();
            Lampa.Controller.enabled().controller[step > 0 ? 'right' : 'left']();
        };
        r.more = function (n) {
            var end = Math.min(def.items.length, r.shown + (n || 14));
            for (; r.shown < end; r.shown++) {
                (function (item, k) {
                    var node = def.build(item);
                    node.addEventListener('hover:focus', function () {
                        r.last = node;
                        var prev = r.active; r.active = k;
                        if (k > 0 || prev > k) r.scroll.update(node, true);
                        if (k >= r.shown - 4 && r.shown < def.items.length) r.more();
                    });
                    r.scroll.body(true).appendChild(node);
                    r.els.push(node);
                    if (Lampa.Controller.own(r)) Lampa.Controller.collectionAppend($(node));
                })(def.items[r.shown], r.shown);
            }
            try { Lampa.Layer.visible(r.scroll.render(true)); } catch (e) { /* ignore */ }
        };
        r.focusAt = function (k) { k = Math.max(0, Math.min(k, def.items.length - 1)); while (r.shown <= k && r.shown < def.items.length) r.more(); r.last = r.els[k] || null; r.active = k; };
        r.toggle = function () {
            Lampa.Controller.add('lampa_hub_line', {
                link: r,
                toggle: function () {
                    Lampa.Controller.collectionSet(r.scroll.render(true));
                    Lampa.Controller.collectionFocus(r.last || false, r.scroll.render(true));
                    page.active = idx; page.scroll.update(r.html[0], true);
                },
                update: function () { },
                right: function () { Navigator.move('right'); },
                left: function () { Navigator.move('left'); },
                down: function () { page.down(); },
                up: function () { page.up(); },
                back: function () { page.close(); }
            });
            Lampa.Controller.toggle('lampa_hub_line');
        };
        r.more();
        return r;
    }

    /* доверенные первыми, затем звёзды GitHub, затем свежесть обновления, затем возраст аккаунта автора (старше — выше) */
    function isTrusted(p) { return p.trusted || (p.sources || []).some(function (s) { return TRUSTED.indexOf(s) >= 0; }); }
    function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
    function byTrust(x, y) {
        return cmp(isTrusted(y) ? 1 : 0, isTrusted(x) ? 1 : 0) || cmp(y.stars || 0, x.stars || 0) ||
            cmp(y.updated || y.pushed || '', x.updated || x.pushed || '') ||
            cmp(x.owner_created || '9999', y.owner_created || '9999') || cmp(x.name.toLowerCase(), y.name.toLowerCase());
    }

    function catRows(all, ctx) {
        var g = {};
        all.forEach(function (p) { (g[p.group || 'Разное'] = g[p.group || 'Разное'] || []).push(p); });
        var names = Object.keys(g).sort(function (a, b) { return a === GH_GROUP ? 1 : b === GH_GROUP ? -1 : g[b].length - g[a].length; });
        return names.map(function (n) {
            var list = g[n].sort(byTrust);
            return { id: 'cat:' + n, cat: n, title: n, count: list.length, items: list, build: function (p) { return pluginCard(p, ctx); } };
        });
    }

    function planRows(state) {
        var s = settings(), c = cache(), inst = installedMap(), nw = newIdsMap();
        var full = buildCatalog(), all = full.filter(function (p) { return !(s.hide_github && p.group === GH_GROUP); });
        /* установлено через стандартный раздел «Расширения» (или CUB), а в каталоге хаба нет — всё равно показываем */
        var known = {}, seen = {};
        full.forEach(function (p) { known[p.id] = 1; (p.mirrors || []).forEach(function (u) { known[keyOf(u)] = 1; }); });
        Object.keys(inst).forEach(function (k) {
            var v = inst[k];
            if (known[k] || seen[v.url]) return;
            seen[v.url] = 1;
            var a = (v.local && v.local.author) || (v.cub && v.cub.author) || '';
            full.push({ id: k, name: v.name || (v.url.split('/').pop() || v.url).replace(/\.js.*$/, ''), url: v.url, author: a === '@hub' ? '' : a,
                descr: 'Установлен через стандартный раздел «Расширения»; в каталоге хаба его нет.', group: 'Установленные', sources: ['Lampa'],
                domain: v.url.split('/')[2] || '' });
        });
        var ctx = { inst: inst, nw: nw, all: full };
        var plug = function (p) { return pluginCard(p, ctx); };
        var when = c.ts ? new Date(c.ts).toISOString().slice(0, 10) : (SEED && SEED.generated) || '—';
        var instList = full.filter(function (p) { return inst[p.id]; });
        var fresh = all.filter(function (p) { return p.updated && !p.found; }).sort(function (x, y) { return x.updated < y.updated ? 1 : -1; }).slice(0, 40);
        var hist = history().slice(0, 60);
        var popular = all.filter(function (p) { return p.popular && !p.found; });
        var cats = catRows(all, ctx);

        var actions = [
            { title: 'Поиск', sub: state.q ? 'сейчас: «' + state.q + '» — нажмите, чтобы изменить' : 'по названию, описанию, автору', run: function () { page.search(all); } },
            { id: 'reload', title: 'Перезагрузить', sub: reloadSub(), pending: pending().add + pending().rem > 0, run: function () { window.location.reload(); } },
            { title: 'Обновить каталог', sub: 'магазины + автопоиск в GitHub · обновлён ' + when, run: function () { runRefresh(); } },
            { title: 'Источники', sub: 'какие магазины доступны', run: function () { showSources(pageToggle); } },
            { title: 'Настройки', sub: 'автопоиск, обновление, свои магазины', run: function () { showSettings(function () { if (page) { page.rebuild(); } }); } }
        ];
        var rows = [{ id: 'actions', title: 'Хаб расширений', count: all.length + ' расширений без дублей', items: actions, build: actionCard }];
        if (state.q) {
            var q = state.q.toLowerCase();
            var res = all.filter(function (p) { return [p.name, p.descr, p.author, p.url, (p.alt_names || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0; });
            rows.push({ id: 'search', title: 'Поиск: ' + state.q, count: res.length ? res.length + ' найдено' : 'ничего не найдено', items: res, build: plug });
        }
        /* первой карточкой — «Добавить по адресу»; строка есть всегда, даже когда ничего не установлено */
        rows.push({ id: 'inst', title: 'Установленные', count: instList.length, items: [{ add: true }].concat(instList), build: function (p) {
            return p.add ? actionCard({ title: 'Добавить по адресу', sub: 'установить плагин по ссылке', run: function () { page.addByUrl(); } }) : plug(p);
        } });
        if (fresh.length) rows.push({ id: 'fresh', title: 'Новое и обновлённое', count: fresh.length, items: fresh, build: plug });
        if (hist.length) rows.push({ id: 'hist', title: 'История', count: history().length, items: hist, build: function (e) { return historyCard(e, ctx); } });
        if (popular.length) rows.push({ id: 'popular', title: 'Популярные', count: popular.length, items: popular, build: plug });
        cats.forEach(function (r) { rows.push(r); });
        return rows.filter(function (r) { return r.items.length || r.id === 'actions' || r.id === 'search'; });
    }

    function openPage() {
        if (page) return;
        injectCss(); dirty();
        var prev = Lampa.Controller.enabled().name;
        var P = page = { rows: [], active: 0, state: { q: '' } };
        P.html = $('<div class="extensions hub-page"><div class="extensions__body"></div></div>');
        P.scroll = new Lampa.Scroll({ mask: true });
        var head = Lampa.Template.get('head_backward', { title: 'Хаб расширений v' + HUB_VERSION });
        head.find('.head-backward__button').on('click', function () { Lampa.Controller.back(); });
        P.scroll.append(head[0]);
        P.scroll.height();
        P.html.find('.extensions__body').append(P.scroll.render());
        P.scroll.onWheel = function (step) { if (step > 0) P.down(); else P.up(); };

        P.clear = function () {
            P.rows.forEach(function (r) { try { r.scroll.destroy(); } catch (e) { /* ignore */ } r.html.remove(); });
            P.rows = []; cards = {};
        };
        P.fill = function (keepId, keepIdx) {
            P.clear();
            var plan = planRows(P.state), at = 0;
            plan.forEach(function (def, i) {
                if (def.id === keepId) at = i;
                var r = makeRow(def, i);
                P.scroll.body(true).appendChild(r.html[0]);
                P.rows.push(r);
            });
            P.active = at;
            if (P.rows[at] && keepIdx) P.rows[at].focusAt(keepIdx);
        };
        P.rebuild = function () {
            var cur = P.rows[P.active];
            P.fill(cur && cur.def.id, cur ? cur.active : 0);
            P.toggle();
        };
        P.down = function () { if (P.active < P.rows.length - 1) { P.active++; P.rows[P.active].toggle(); } };
        P.up = function () { if (P.active > 0) { P.active--; P.rows[P.active].toggle(); } };
        P.jump = function (id) {
            for (var i = 0; i < P.rows.length; i++) if (P.rows[i].def.id === id) { P.active = i; P.rows[i].toggle(); return; }
        };
        P.toggle = function () {
            Lampa.Controller.add('lampa_hub', {
                toggle: function () {
                    Lampa.Controller.collectionSet(P.html[0]);
                    if (P.rows.length) P.rows[P.active].toggle();
                },
                back: function () { P.close(); }
            });
            Lampa.Controller.toggle('lampa_hub');
        };
        P.search = function () {
            Lampa.Input.edit({ title: 'Поиск плагина', value: P.state.q || '', free: true, nosave: true }, function (v) {
                P.state.q = (v || '').trim();
                P.fill('actions', 0); P.toggle();
                if (P.state.q) P.jump('search');
            });
        };
        P.addByUrl = function () {
            Lampa.Input.edit({ title: 'Адрес плагина (https://…/plugin.js)', value: '', free: true, nosave: true }, function (v) {
                v = (v || '').trim();
                if (validUrl(v)) install({ id: keyOf(v), name: v.replace(/^https?:\/\//, '').split('/').slice(-1)[0] || v, url: v, sources: ['manual'] }, function () { P.rebuild(); });
                else { if (v) noty('Некорректный адрес'); P.toggle(); }
            });
        };
        P.close = function () {
            P.clear();
            try { P.scroll.destroy(); } catch (e) { /* ignore */ }
            P.html.remove();
            page = null; reloadNode = null;
            $('body').removeClass('ambience--enable');
            Lampa.Controller.toggle(prev);
        };

        P.fill('actions', 0);
        $('body').addClass('ambience--enable').append(P.html);
        /* без этого у скролла страницы нет высоты и «вниз» не прокручивает к нижним категориям */
        try { Lampa.Layer.update(P.html); } catch (e) { /* ignore */ }
        P.toggle();
        try { Lampa.Account.Api.plugins(function () { if (page === P) { dirty(); refreshCards(); } }); } catch (e) { /* not logged in */ }
    }

    function showMain() { openPage(); }

    /* ---- карточка плагина: блоки-«селекторы», чтобы пультом можно было прокрутить длинное содержимое ---- */
    var SCAN_SHORT = { ok: '✓ Код проверен', warn: '! Есть замечания', risk: '✕ Подозрительно' };
    var FAV = 'https://www.google.com/s2/favicons?sz=32&domain=';
    var SCAN_TXT = {
        miner: 'похоже на майнер', stealer: 'читает данные аккаунта/пароли и обращается к чужим адресам', eval: 'eval / динамически исполняемый код',
        obf: 'обфусцированный код — прочитать нельзя', cookie: 'работает с cookie', beacon: 'отправляет данные через sendBeacon', write: 'document.write',
        ipurl: 'обращается к серверам по IP-адресу', loader: 'подгружает другие скрипты', http: 'ставится по http — без шифрования'
    };
    var SCAN_HEAD = { ok: ['✓ Проверка кода: замечаний нет', 'ok'], warn: ['! Проверка кода: есть замечания', 'warn'], risk: ['✕ Проверка кода: подозрительно', 'risk'] };
    function fav(host) {
        var i = el('img', 'hub-fav'); i.onerror = function () { i.style.display = 'none'; }; i.src = FAV + encodeURIComponent(host); return i;
    }
    function kv(k, v) { if (v == null || v === '') return null; var d = el('div', 'hub-rd__l'); d.appendChild(el('span', 'hub-rd__k', k + ': ')); d.appendChild(document.createTextNode(v + '')); return d; }
    function block(title, rows) {
        rows = rows.filter(Boolean);
        if (!rows.length) return null;
        var d = el('div', 'hub-rd selector');
        if (title) d.appendChild(el('div', 'hub-rd__t', title));
        rows.forEach(function (r) { d.appendChild(typeof r === 'string' ? el('div', 'hub-rd__l', r) : r); });
        return d;
    }
    function ageOf(d) {
        if (!d) return '';
        var y = (Date.now() - new Date(d).getTime()) / 31557600000;
        return d + (y >= 1 ? ' (' + Math.floor(y) + ' л.)' : ' (< года)');
    }
    function scanBlock(p) {
        var sc = p.scan;
        if (!sc) return block('Проверка кода', ['Не проверялся: сборка не смогла скачать скрипт.']);
        var h = SCAN_HEAD[sc.v] || SCAN_HEAD.ok, rows = [];
        var t = el('div', 'hub-rd__l hub-flag--' + h[1], h[0]); rows.push(t);
        (sc.f || []).forEach(function (c) { rows.push('• ' + (SCAN_TXT[c] || c)); });
        if (sc.h && sc.h.length) rows.push(kv('Внешние адреса в коде' + (sc.n > sc.h.length ? ' (' + sc.n + ', первые ' + sc.h.length + ')' : ''), sc.h.join(', ')));
        rows.push(el('div', 'hub-rd__l hub-rd__note', 'Автоматический поиск подозрительных приёмов при сборке каталога. Это не гарантия безопасности — только то, что нашлось по шаблонам.'));
        return block('Проверка кода', rows);
    }
    function githubBlock(p) {
        if (!p.repo) return null;
        var own = p.repo.split('/')[0];
        return block('GitHub', [kv('Репозиторий', p.repo), kv('Звёзды', p.stars != null ? '★ ' + p.stars : ''), kv('Форки', p.forks), kv('Лицензия', p.license),
            p.archived ? el('div', 'hub-rd__l hub-flag--warn', '! Репозиторий в архиве — не поддерживается') : null,
            kv('Открытых issues', p.issues), kv('Автор', own + (p.owner_type ? ' (' + (p.owner_type === 'Organization' ? 'организация' : 'пользователь') + ')' : '')),
            kv('Подписчиков у автора', p.owner_followers), kv('Репозиториев у автора', p.owner_repos), kv('Аккаунт создан', ageOf(p.owner_created)),
            kv('Репозиторий создан', ageOf(p.created)), kv('Последний коммит', p.pushed), kv('Темы', (p.topics || []).join(', ')), kv('Ссылка', p.homepage)]);
    }

    /* README: разбор Markdown в DOM только через createElement/textContent — без HTML, ссылок, картинок и скриптов */
    function mdInline(t) {
        var f = document.createDocumentFragment(), re = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]*\)|<[^>]+>)/g, last = 0, m;
        t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        while ((m = re.exec(t))) {
            if (m.index > last) f.appendChild(document.createTextNode(t.slice(last, m.index)));
            var x = m[0];
            if (x.charAt(0) === '<') { /* HTML-теги выкидываем */ }
            else if (x.charAt(0) === '`') f.appendChild(el('code', '', x.slice(1, -1)));
            else if (x.charAt(0) === '[') f.appendChild(el('span', 'hub-md__a', x.slice(1, x.indexOf(']('))));
            else if (x.slice(0, 2) === '**' || x.slice(0, 2) === '__') f.appendChild(el('strong', '', x.slice(2, -2)));
            else f.appendChild(el('em', '', x.slice(1, -1)));
            last = m.index + x.length;
        }
        if (last < t.length) f.appendChild(document.createTextNode(t.slice(last)));
        return f;
    }
    function mdBlocks(md) {
        md = (md + '').replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
        var out = [], para = [], code = null;
        function flush() { if (para.length) { var t = para.join(' ').trim(); if (t) out.push({ k: 'p', t: t }); para = []; } }
        md.split('\n').forEach(function (ln) {
            if (/^\s*(```|~~~)/.test(ln)) { if (code) { out.push({ k: 'code', t: code.join('\n') }); code = null; } else { flush(); code = []; } return; }
            if (code) { code.push(ln); return; }
            var h = ln.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
            if (h) { flush(); if (h[2].trim()) out.push({ k: 'h', l: Math.min(h[1].length, 3), t: h[2].trim() }); return; }
            var li = ln.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
            if (li) { flush(); out.push({ k: 'li', d: Math.min(Math.floor(li[1].replace(/\t/g, '    ').length / 2), 3), n: /\d/.test(li[2]) ? li[2] : '•', t: li[3] }); return; }
            if (/^\s*>/.test(ln)) { flush(); out.push({ k: 'q', t: ln.replace(/^\s*>\s?/, '') }); return; }
            if (/^\s*\|?[\s:-]+\|[\s|:-]*$/.test(ln)) return;
            if (/^\s*\|.*\|\s*$/.test(ln)) { flush(); out.push({ k: 'row', t: ln.replace(/^\s*\||\|\s*$/g, '').split('|').map(function (c) { return c.trim(); }).join('  ·  ') }); return; }
            if (!ln.trim() || /^\s*(?:[-*_]\s*){3,}$/.test(ln)) { flush(); return; }
            para.push(ln.trim());
        });
        flush();
        if (code && code.length) out.push({ k: 'code', t: code.join('\n') });
        return out;
    }

    /* README прямо в окне плагина: текст грузится асинхронно (jsDelivr), кладётся блоками-«селекторами» и кешируется на сессию */
    var RD_CACHE = {};
    function readmeNodes(txt, p) {
        var box = el('div', 'hub-rd hub-md'), n = 0, size = 0;
        box.appendChild(el('div', 'hub-rd__t', 'README'));
        mdBlocks(txt).forEach(function (b) {
            if (n > 250 || size > 24000) return;
            var t = b.t.length > 1500 ? b.t.slice(0, 1499) + '…' : b.t, d;
            if (b.k === 'h') d = el('div', 'hub-md__i hub-md__h' + b.l);
            else if (b.k === 'li') { d = el('div', 'hub-md__i hub-md__li'); d.style.marginLeft = (b.d * 1.2) + 'em'; d.appendChild(el('span', 'hub-md__n', b.n + ' ')); }
            else d = el('div', 'hub-md__i hub-md__' + b.k);
            if (b.k === 'code') d.textContent = t; else d.appendChild(mdInline(t));
            d.className += ' selector';
            box.appendChild(d); n++; size += t.length;
        });
        if (!n) box.appendChild(el('div', 'hub-rd__l', 'README пустой или не содержит текста.'));
        else box.appendChild(el('div', 'hub-rd__l hub-rd__note', 'Показан текст README (без картинок и ссылок). Полный — ' + (p.homepage || p.repo) + '.'));
        return [box];
    }
    function loadReadme(p, done) {
        if (RD_CACHE[p.rd] != null) return done(RD_CACHE[p.rd]);
        http('https://cdn.jsdelivr.net/gh/' + p.rd, { timeout: 12000 }, function (txt) { RD_CACHE[p.rd] = txt; done(txt); }, function () { done(null); });
    }

    function showDetail(p, back) {
        var inst = installedMap()[p.id], pr = p.probe || {};
        var where = inst ? (inst.cub ? 'CUB' + (inst.local ? ' + локально' : '') : 'локально') : '';
        var hist = history().filter(function (h) { return h.id === p.id; }).slice(0, 8);
        var html = $('<div class="about hub-detail"></div>');
        var btns = $('<div class="hub-btns"></div>');
        function btn(t, fn) {
            var b = $('<div class="simple-button selector" style="margin:.3em .6em .3em 0"></div>').text(t);
            b.on('hover:enter', fn); btns.append(b);
        }
        /* закрыть диалог сразу и обновить карточку на месте: без перерисовки страницы */
        function finish() { Lampa.Modal.close(); setTimeout(function () { refreshCards(); syncReload(); back && back(); }, 30); }
        if (!inst) btn('Установить', function () { install(p, finish); });
        else {
            btn(inst.status ? 'Выключить' : 'Включить', function () { toggle(p, finish); });
            if (inst.local) btn('Удалить', function () { uninstall(p, finish); });
        }
        btn('Копировать адрес', function () { try { Lampa.Utils.copyTextToClipboard(p.url, function () { noty('Адрес скопирован'); }, function () { noty(p.url); }); } catch (e) { noty(p.url); } });
        html.append(btns);
        if (inst && inst.cub && !inst.local) html.append(el('div', 'hub-rd__note hub-rd__l', 'Установлен через CUB — как и в оригинальном списке, его можно только включать и выключать; удалить — на cub.best.'));

        var st = statFresh(p.url), trusted = isTrusted(p);
        var src = el('div', 'hub-rd__l'); src.appendChild(fav(p.domain || (p.url.split('/')[2] || ''))); src.appendChild(document.createTextNode(p.domain || p.url));
        var tr = trusted ? el('div', 'hub-rd__l hub-flag--ok', '✔ Доверенный источник: плагин есть в ' + (p.sources || []).filter(function (x) { return TRUSTED.indexOf(x) >= 0; }).join(', '))
            : el('div', 'hub-rd__l', 'Не из доверенных источников' + (p.found ? ' — найден автопоиском в GitHub' : ''));
        var slot = $('<div class="hub-rdslot"></div>');
        function fill(txt) {
            slot.empty();
            if (txt == null) slot.append(block('README', ['Не удалось загрузить README (' + p.rd + ').']));
            else readmeNodes(txt, p).forEach(function (n) { slot.append(n); });
        }
        [
            block('Описание', [p.descr && el('div', 'hub-rd__l hub-rd__full', p.descr), p.about && p.about !== p.descr && el('div', 'hub-rd__l hub-rd__full', p.about)]),
            block('Источник', [src, tr, kv('Адрес', p.url), kv('Зеркала', (p.mirrors || []).join(', ')), kv('Найден в', (p.sources || []).join(', ')),
                kv('На lampaguide', p.status), kv('Страница', p.page)]),
            scanBlock(p),
            githubBlock(p),
            block('Состояние', [kv('Версия', p.version), kv('Обновлён', p.updated), kv('Автор', p.author), kv('Категория', p.group),
                kv('Установка', inst ? (inst.status ? 'установлен, включён' : 'установлен, выключен') + ' (' + where + ')' : 'не установлен'),
                kv('Проверка загрузки', st ? st.code + ' · ' + st.txt : ''), kv('Размер', pr.size ? Math.round(pr.size / 1024) + ' КБ' : ''),
                kv('Другие названия', (p.alt_names || []).join(', ')), kv('Проверен в сборке', pr.checked)]),
            hist.length ? block('История', hist.map(function (h) { return h.date + ' — ' + (TYPE_TXT[h.type] || h.type) + (h.version ? ' (v' + h.version + ')' : '') + (h.extra && h.extra.from ? ' ' + h.extra.from + ' → ' + h.extra.to : ''); })) : null
        ].forEach(function (b) { if (b) html.append(b); });
        if (p.rd) html.append(slot);  /* README длинный — в самом конце */
        if (p.rd) {
            if (RD_CACHE[p.rd] != null) fill(RD_CACHE[p.rd]);
            else {
                slot.append(block('README', ['Загружаю README…']));
                loadReadme(p, function (txt) {
                    fill(txt);
                    /* кнопки остаются на месте (Modal.update пересоздал бы содержимое и потерял бы их обработчики): подключаем только новые блоки */
                    try {
                        if (!document.body.contains(slot[0])) return;
                        slot.find('.selector').on('hover:focus', function (e) { Lampa.Modal.scroll().update($(e.target)); });
                        Lampa.Modal.toggle(true);
                    } catch (e) { /* закрыто */ }
                });
            }
        }
        if (p.rd) {
            /* внутри README стрелки вверх/вниз сдвигают фокус примерно на полэкрана, а не на одну строку */
            var halfPage = function (e) {
                if (!document.body.contains(slot[0])) return document.removeEventListener('keydown', halfPage, true);
                var dir = e.keyCode === 40 || e.key === 'ArrowDown' ? 1 : e.keyCode === 38 || e.key === 'ArrowUp' ? -1 : 0;
                if (!dir) return;
                var lines = slot.find('.hub-md__i.selector').toArray(), cur = -1, i;
                for (i = 0; i < lines.length; i++) if (lines[i].classList.contains('focus')) cur = i;
                if (cur < 0) return;
                var top = lines[cur].getBoundingClientRect().top, step = window.innerHeight / 2, to = -1;
                if (dir > 0) {
                    if (cur === lines.length - 1) return;
                    for (i = cur + 1; i < lines.length; i++) { to = i; if (lines[i].getBoundingClientRect().top - top >= step) break; }
                } else {
                    if (cur === 0) return;
                    for (i = cur - 1; i >= 0; i--) { to = i; if (top - lines[i].getBoundingClientRect().top >= step) break; }
                }
                e.preventDefault(); e.stopImmediatePropagation();
                Lampa.Controller.collectionFocus(lines[to], Lampa.Modal.render()[0]);
            };
            document.addEventListener('keydown', halfPage, true);
        }
        Lampa.Modal.open({ title: p.name, html: html, size: p.rd ? 'large' : 'medium', onBack: function () { Lampa.Modal.close(); setTimeout(function () { back && back(); }, 30); } });
    }

    function showSources(back) {
        var c = cache(), s = settings();
        var items = STORES.concat((s.stores || []).map(function (u, i) { return { name: 'custom' + (i + 1), url: u }; })).map(function (st) {
            var r = c.sources[st.name], seedS = (SEED && SEED.sources || []).filter(function (x) { return x.name === st.name; })[0];
            var state = r ? (r.ok ? '✓ ' + r.count + ' шт., ' + new Date(r.ts).toISOString().slice(0, 10) : '✗ ' + r.err) : (seedS ? 'из сборки: ' + seedS.count + ' шт. (' + (SEED.generated || '') + ')' : 'ещё не обновлялся');
            return { title: st.name, subtitle: state + '\n' + st.url };
        });
        var gh = buildCatalog(), ghn = gh.filter(function (p) { return (p.sources || []).indexOf('github') >= 0; }).length, grn = gh.filter(function (p) { return p.repo; }).length;
        items.push({ title: 'github', subtitle: 'автопоиск ' + (s.github ? 'вкл' : 'выкл') + ': найдено ' + ghn + ' шт.; исходник на GitHub известен у ' + grn + ' из ' + gh.length +
            (c.sources.github ? '; ' + new Date(c.sources.github.ts).toISOString().slice(0, 10) : '') + '\nhttps://github.com/search?q=lampa+plugin&type=code' });
        Lampa.Select.show({ title: 'Источники', items: items, onBack: back, onSelect: function () { back(); } });
    }

    function showSettings(back) {
        var s = settings();
        var items = [
            { title: 'Автопоиск в GitHub: ' + (s.github ? 'вкл' : 'выкл'), k: 'github' },
            { title: 'Автообновление: ' + (s.auto ? 'раз в ' + s.interval + ' ч' : 'выкл'), k: 'auto' },
            { title: 'GitHub-токен: ' + (s.token ? 'задан' : 'нет (лимит 60 запросов/час)'), k: 'token' },
            { title: 'Свой GitHub-запрос: ' + (s.query || 'нет'), subtitle: 'например: topic:lampa-plugin language:JavaScript stars:>2', k: 'query' },
            { title: 'Свой магазин (адрес JSON или store.js)', subtitle: 'Добавлено: ' + (s.stores.length ? s.stores.join(', ') : 'нет'), k: 'store' },
            { title: 'Очистить свои магазины', k: 'clear' },
            { title: 'Скрывать найденное в GitHub в общем каталоге: ' + (s.hide_github ? 'да' : 'нет'), k: 'hide' }
        ];
        Lampa.Select.show({
            title: 'Настройки хаба', items: items, onBack: back,
            onSelect: function (a) {
                var again = function () { saveSettings(s); setTimeout(function () { showSettings(back); }, 10); };
                var ask = function (title, val, cb) { Lampa.Input.edit({ title: title, value: val || '', free: true, nosave: true }, function (v) { cb(v); again(); }); };
                if (a.k === 'github') { s.github = !s.github; again(); }
                else if (a.k === 'auto') { if (!s.auto) s.auto = true; else if (s.interval === 24) s.interval = 6; else if (s.interval === 6) s.interval = 72; else { s.auto = false; s.interval = 24; } again(); }
                else if (a.k === 'token') ask('GitHub token (read-only, public_repo не нужен)', s.token, function (v) { s.token = (v || '').trim(); });
                else if (a.k === 'query') ask('GitHub search query', s.query, function (v) { s.query = (v || '').trim(); });
                else if (a.k === 'store') ask('URL магазина', '', function (v) { v = (v || '').trim(); if (validUrl(v) && s.stores.indexOf(v) < 0) s.stores.push(v); });
                else if (a.k === 'clear') { s.stores = []; again(); }
                else if (a.k === 'hide') { s.hide_github = !s.hide_github; again(); }
            }
        });
    }

    function runRefresh() {
        noty('Обновляю каталог…');
        refresh({ deep: true }, function (err, r) {
            if (err === 'busy') noty('Уже обновляется');
            else if (r) noty('Готово: ' + r.total + ' плагинов, новых ' + r.nNew + ', обновлений версий ' + r.nUpd + ', источников OK ' + r.ok + (r.bad ? ', недоступно ' + r.bad : ''));
            if (page) page.rebuild();
        });
    }

    /* ------------------------------------------------------------------ settings folder + boot */
    var ICON = '<svg viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="19" height="19" rx="2" fill="white"/><rect x="25" width="19" height="19" rx="2" fill="white"/><rect y="25" width="19" height="19" rx="2" fill="white"/><rect x="25" y="25" width="19" height="19" rx="2" stroke="white" stroke-width="3"/></svg>';

    /* Вставляет папку в главное меню настроек; вызывается на старте и при каждом открытии настроек,
       поэтому переживает пересборку списка. Место: после «Расширения» (на виду, а не за десятком папок других плагинов),
       иначе после «Остальное», иначе в конец списка папок. */
    function addFolder(body) {
        var main = Lampa.Settings.main && Lampa.Settings.main(), host = body || (main && main.render());
        if (!host || !host.length) return false;
        var field = host.find('[data-component="lampa_hub"]');
        if (!field.length) {
            field = $('<div class="settings-folder selector" data-component="lampa_hub" data-static="true"><div class="settings-folder__icon">' + ICON +
                '</div><div class="settings-folder__name">Хаб расширений</div></div>');
            var anchor = host.find('[data-component="plugins"]');
            if (!anchor.length) anchor = host.find('[data-component="more"]');
            if (!anchor.length) anchor = host.find('.settings-folder').last();
            if (!anchor.length) return false;
            anchor.after(field);
            if (main) main.update();
        }
        field.off('hover:enter').on('hover:enter', function () { showMain(); });
        return true;
    }

    function boot() {
        try { addFolder(); } catch (e) { /* the open listener below retries */ }
        Lampa.Settings.listener.follow('open', function (e) {
            if (e.name === 'main') { try { addFolder(e.body); } catch (x) { /* ignore */ } }
        });
        var s = settings(), c = cache();
        if (s.auto && (!c.ts || Date.now() - c.ts > s.interval * 3600e3)) setTimeout(function () { refresh({}, function () { }); }, 15000);
    }

    window.lampa_hub = { version: HUB_VERSION, catalog: buildCatalog, refresh: refresh, history: history, open: showMain, key: keyOf };

    if (window.appready) boot();
    else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') boot(); });
})();

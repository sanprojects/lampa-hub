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
            ['author', 'version', 'page', 'status', 'updated', 'repo', 'stars', 'pushed', 'created', 'topics', 'license', 'homepage', 'popular', 'probe'].forEach(function (f) {
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
    function installedMap() {
        var m = {};
        try { Lampa.Plugins.get().forEach(function (p) { m[keyOf(p.url)] = p; }); } catch (e) { /* ignore */ }
        return m;
    }
    function install(p, done) {
        var inst = installedMap();
        if (inst[p.id]) { noty('Уже установлен'); return done && done(); }
        Lampa.Plugins.add({ url: p.url, status: 1, name: p.name, author: p.author || '@hub' });
        logEvent('installed', p);
        noty('Установлен: ' + p.name);
        done && done();
    }
    function uninstall(p, done) {
        var plug = installedMap()[p.id];
        if (!plug) return done && done();
        Lampa.Plugins.remove(plug);
        logEvent('removed', p);
        noty('Удалён: ' + p.name + '. Перезагрузите Lampa, чтобы он перестал работать');
        done && done();
    }
    function toggle(p, done) {
        var plug = installedMap()[p.id];
        if (!plug) return done && done();
        plug.status = plug.status ? 0 : 1;
        Lampa.Plugins.save();
        logEvent(plug.status ? 'enabled' : 'disabled', p);
        noty((plug.status ? 'Включён: ' : 'Выключен: ') + p.name + '. Нужна перезагрузка');
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

    /* ------------------------------------------------------------------ UI */
    function controllerName() { try { return Lampa.Controller.enabled().name; } catch (e) { return 'content'; } }

    function line(p, inst) {
        var parts = [];
        if (p.version) parts.push('v' + p.version);
        if (p.updated) parts.push(p.updated);
        parts.push(p.group || 'Разное');
        if (p.stars) parts.push('★' + p.stars);
        var sub = parts.join(' · ');
        if (p.descr) sub += '\n' + clip(p.descr, 110);
        return sub;
    }
    function mark(p, inst, newIds) {
        var i = inst[p.id];
        var m = i ? (i.status ? '● ' : '○ ') : '';
        return m + p.name + (newIds && newIds[p.id] ? '  NEW' : '');
    }
    function newIdsMap() {
        var m = {}, lim = Date.now() - 14 * 864e5;
        history().forEach(function (h) { if (h.type === 'new' && h.ts > lim) m[h.id] = 1; });
        return m;
    }

    function showList(title, list, back, state) {
        state = state || {};
        var inst = installedMap(), nw = newIdsMap();
        var items = list.map(function (p, i) {
            return { title: mark(p, inst, nw), subtitle: line(p, inst), plugin: p, selected: i === (state.idx || 0) };
        });
        if (!items.length) { noty('Ничего не найдено'); return back && back(); }
        Lampa.Select.show({
            title: title + ' (' + list.length + ')', items: items,
            onBack: function () { back && back(); },
            onSelect: function (a) {
                state.idx = items.indexOf(a);
                setTimeout(function () { showDetail(a.plugin, function () { showList(title, list, back, state); }); }, 10);
            }
        });
    }

    function infoRow(k, v) { return v ? '<div style="margin:.3em 0"><span style="opacity:.55">' + esc(k) + ':</span> ' + esc(v) + '</div>' : ''; }

    function showDetail(p, back) {
        var inst = installedMap()[p.id], pr = p.probe || {};
        var hist = history().filter(function (h) { return h.id === p.id; }).slice(0, 8);
        var html = $('<div class="about"></div>');
        var body = infoRow('Версия', p.version) + infoRow('Обновлён', p.updated) + infoRow('Автор', p.author) + infoRow('Категория', p.group) +
            infoRow('Статус', inst ? (inst.status ? 'установлен, включён' : 'установлен, выключен') : 'не установлен') +
            infoRow('Описание', p.descr) + infoRow('Адрес', p.url) + infoRow('Зеркала', (p.mirrors || []).join(', ')) +
            infoRow('Другие названия', (p.alt_names || []).join(', ')) + infoRow('Найден в', (p.sources || []).join(', ')) +
            infoRow('На lampaguide', p.status) + infoRow('Страница', p.page) +
            infoRow('GitHub', p.repo ? p.repo + (p.stars ? ' ★' + p.stars : '') : '') + infoRow('Репозиторий', p.homepage) + infoRow('Темы', (p.topics || []).join(', ')) +
            infoRow('Лицензия', p.license) + infoRow('Изменён в репозитории', p.pushed) +
            infoRow('Размер', pr.size ? Math.round(pr.size / 1024) + ' КБ' : '') + infoRow('Проверен', pr.checked) +
            (p.found ? '<div style="margin:.6em 0;opacity:.7">Найден автопоиском в GitHub — код не проверялся, ставьте на свой риск.</div>' : '');
        if (hist.length) body += '<div style="margin-top:.6em;opacity:.55">История:</div>' + hist.map(function (h) {
            return '<div style="margin:.15em 0">' + esc(h.date + ' — ' + (TYPE_TXT[h.type] || h.type) + (h.version ? ' (v' + h.version + ')' : '') + (h.extra && h.extra.from ? ' ' + h.extra.from + ' → ' + h.extra.to : '')) + '</div>';
        }).join('');
        html.append('<div style="font-size:.9em;line-height:1.35;word-break:break-word">' + body + '</div>');
        var btns = $('<div style="margin-top:1em;display:flex;flex-wrap:wrap"></div>');
        function btn(t, fn) {
            var b = $('<div class="simple-button selector" style="margin:.3em .6em .3em 0">' + esc(t) + '</div>');
            b.on('hover:enter', fn); btns.append(b);
        }
        var prev = controllerName();
        function close(cb) { Lampa.Modal.close(); setTimeout(function () { cb && cb(); }, 30); }
        if (!inst) btn('Установить', function () { install(p, function () { close(function () { showDetail(p, back); }); }); });
        else {
            btn(inst.status ? 'Выключить' : 'Включить', function () { toggle(p, function () { close(function () { showDetail(p, back); }); }); });
            btn('Удалить', function () { uninstall(p, function () { close(function () { showDetail(p, back); }); }); });
        }
        btn('Копировать адрес', function () { try { Lampa.Utils.copyTextToClipboard(p.url, function () { noty('Адрес скопирован'); }, function () { noty(p.url); }); } catch (e) { noty(p.url); } });
        html.append(btns);
        Lampa.Modal.open({ title: p.name, html: html, size: 'medium', onBack: function () { close(back); } });
    }

    function showHistory(back) {
        var h = history();
        if (!h.length) { noty('История пока пуста'); return back(); }
        var items = h.slice(0, 200).map(function (e) {
            return { title: e.date + ' · ' + e.name + (e.version ? ' v' + e.version : ''), subtitle: (TYPE_TXT[e.type] || e.type) + (e.updated ? ' · обновлён ' + e.updated : '') + (e.descr ? '\n' + clip(e.descr, 100) : ''), entry: e };
        });
        Lampa.Select.show({
            title: 'История (' + h.length + ')', items: items, onBack: back,
            onSelect: function (a) {
                var e = a.entry, c = buildCatalog().filter(function (p) { return p.id === e.id; })[0] || { id: e.id, name: e.name, url: e.url, version: e.version, descr: e.descr, author: e.author, group: e.group, sources: e.sources, updated: e.updated };
                setTimeout(function () { showDetail(c, function () { showHistory(back); }); }, 10);
            }
        });
    }

    function showSources(back) {
        var c = cache(), s = settings();
        var items = STORES.concat((s.stores || []).map(function (u, i) { return { name: 'custom' + (i + 1), url: u }; })).map(function (st) {
            var r = c.sources[st.name], seedS = (SEED && SEED.sources || []).filter(function (x) { return x.name === st.name; })[0];
            var state = r ? (r.ok ? '✓ ' + r.count + ' шт., ' + new Date(r.ts).toISOString().slice(0, 10) : '✗ ' + r.err) : (seedS ? 'из сборки: ' + seedS.count + ' шт. (' + (SEED.generated || '') + ')' : 'ещё не обновлялся');
            return { title: st.name, subtitle: state + '\n' + st.url };
        });
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

    function runRefresh(back, deep) {
        noty('Обновляю каталог…');
        refresh({ deep: deep }, function (err, r) {
            if (err === 'busy') noty('Уже обновляется'); else if (r) noty('Готово: ' + r.total + ' плагинов, новых ' + r.nNew + ', обновлений версий ' + r.nUpd + ', источников OK ' + r.ok + (r.bad ? ', недоступно ' + r.bad : ''));
            back && back();
        });
    }

    function groupsOf(list) { var g = {}; list.forEach(function (p) { g[p.group] = (g[p.group] || 0) + 1; }); return g; }

    function showCategories(back) {
        var s = settings(), all = buildCatalog().filter(function (p) { return !(s.hide_github && p.group === GH_GROUP); });
        var g = groupsOf(all), names = Object.keys(g).sort(function (a, b) { return a === GH_GROUP ? 1 : b === GH_GROUP ? -1 : g[b] - g[a]; });
        var items = [{ title: 'Все плагины', subtitle: all.length + ' шт.', all: true }].concat(names.map(function (n) { return { title: n, subtitle: g[n] + ' шт.', name: n }; }));
        Lampa.Select.show({
            title: 'Категории', items: items, onBack: back,
            onSelect: function (a) {
                var list = a.all ? all : all.filter(function (p) { return p.group === a.name; });
                list.sort(function (x, y) {
                    return (x.found ? 1 : 0) - (y.found ? 1 : 0) || (y.popular ? 1 : 0) - (x.popular ? 1 : 0) || x.name.toLowerCase().localeCompare(y.name.toLowerCase());
                });
                setTimeout(function () { showList(a.title, list, function () { showCategories(back); }); }, 10);
            }
        });
    }

    function showMain() {
        var all = buildCatalog(), c = cache(), inst = installedMap();
        var instCount = all.filter(function (p) { return inst[p.id]; }).length;
        var when = c.ts ? new Date(c.ts).toISOString().slice(0, 10) : (SEED && SEED.generated) || '—';
        var back = function () { try { Lampa.Controller.toggle('settings_component'); } catch (e) { /* ignore */ } };
        var again = function () { setTimeout(showMain, 10); };
        var items = [
            { title: 'Каталог', subtitle: all.length + ' плагинов без дублей · обновлён ' + when, k: 'cat' },
            { title: 'Поиск', subtitle: 'по названию, описанию, автору', k: 'search' },
            { title: 'Новое и обновлённое', subtitle: 'свежие по дате', k: 'new' },
            { title: 'Установленные', subtitle: instCount + ' шт.', k: 'inst' },
            { title: 'История', subtitle: history().length + ' записей: название, версия, дата, описание', k: 'hist' },
            { title: 'Обновить каталог', subtitle: 'магазины + автопоиск в GitHub', k: 'refresh' },
            { title: 'Источники', subtitle: 'какие магазины доступны', k: 'src' },
            { title: 'Настройки', k: 'set' }
        ];
        Lampa.Select.show({
            title: 'Хаб плагинов v' + HUB_VERSION, items: items, onBack: back,
            onSelect: function (a) {
                var s = settings();
                var cat = all.filter(function (p) { return !(s.hide_github && p.group === GH_GROUP); });
                setTimeout(function () {
                    if (a.k === 'cat') showCategories(again);
                    else if (a.k === 'search') Lampa.Input.edit({ title: 'Поиск плагина', value: '', free: true, nosave: true }, function (v) {
                        v = (v || '').toLowerCase().trim();
                        if (!v) return again();
                        var res = cat.filter(function (p) { return [p.name, p.descr, p.author, p.url, (p.alt_names || []).join(' ')].join(' ').toLowerCase().indexOf(v) >= 0; });
                        showList('Поиск: ' + v, res, again);
                    });
                    else if (a.k === 'new') showList('Новое и обновлённое', cat.filter(function (p) { return p.updated; }).sort(function (x, y) { return x.updated < y.updated ? 1 : -1; }).slice(0, 60), again);
                    else if (a.k === 'inst') showList('Установленные', all.filter(function (p) { return inst[p.id]; }), again);
                    else if (a.k === 'hist') showHistory(again);
                    else if (a.k === 'refresh') runRefresh(again, true);
                    else if (a.k === 'src') showSources(again);
                    else if (a.k === 'set') showSettings(again);
                }, 10);
            }
        });
    }

    /* ------------------------------------------------------------------ settings folder + boot */
    var ICON = '<svg viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="19" height="19" rx="2" fill="white"/><rect x="25" width="19" height="19" rx="2" fill="white"/><rect y="25" width="19" height="19" rx="2" fill="white"/><rect x="25" y="25" width="19" height="19" rx="2" stroke="white" stroke-width="3"/></svg>';

    function addFolder() {
        if (!Lampa.Settings.main || Lampa.Settings.main().render().find('[data-component="lampa_hub"]').length) return;
        var field = $('<div class="settings-folder selector" data-component="lampa_hub" data-static="true"><div class="settings-folder__icon">' + ICON +
            '</div><div class="settings-folder__name">Хаб плагинов</div></div>');
        Lampa.Settings.main().render().find('[data-component="more"]').after(field);
        Lampa.Settings.main().update();
    }

    function boot() {
        addFolder();
        Lampa.Settings.listener.follow('open', function (e) {
            if (e.name === 'main') {
                e.body.find('[data-component="lampa_hub"]').off('hover:enter').on('hover:enter', function () { showMain(); });
            }
        });
        var s = settings(), c = cache();
        if (s.auto && (!c.ts || Date.now() - c.ts > s.interval * 3600e3)) setTimeout(function () { refresh({}, function () { }); }, 15000);
    }

    window.lampa_hub = { version: HUB_VERSION, catalog: buildCatalog, refresh: refresh, history: history, open: showMain, key: keyOf };

    if (window.appready) boot();
    else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') boot(); });
})();

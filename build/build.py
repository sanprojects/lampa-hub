#!/usr/bin/env python3
"""Aggregate Lampa plugin stores into dist/catalog.json and bake it into dist/lampa-hub.js.

Sources (all merged, de-duplicated by normalised URL):
  lampaplugins   JSON store           https://lampaplugins.github.io/store/extensions.json
  k03mad         JSON store           https://k03mad.github.io/lampa/store.json
  skaztv         JSON store           https://skaztv.online/extensions.json (Wayback snapshot when unreachable)
  bylampa        in-code list         https://bylampa.github.io/addon.js
  lampaguide     HTML catalogue       https://lampaguide.com/plugins
  github         repo search          topic:lampa-plugin / lampa-plugins / lampa (+ jsDelivr file listing)

Every unique URL is then probed (alive, size, Last-Modified, version / name / description
parsed from the script header). Run:  python3 build/build.py [--no-github] [--no-probe]
"""
import argparse, concurrent.futures as cf, datetime as dt, email.utils, gzip, html, json, os, re, subprocess, sys
import urllib.request, urllib.parse, urllib.error
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = 'Mozilla/5.0 (lampa-hub build)'
NOW = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%d')

STORES = [
    ('lampaplugins', 'https://lampaplugins.github.io/store/extensions.json', 'json'),
    ('k03mad', 'https://k03mad.github.io/lampa/store.json', 'json'),
    ('skaztv', 'https://skaztv.online/extensions.json', 'json'),
    ('bylampa', 'https://bylampa.github.io/addon.js', 'bylampa'),
    ('lampaguide', 'https://lampaguide.com/plugins', 'lampaguide'),
]
WAYBACK = {'skaztv'}  # live host is unreachable from some networks: fall back to the newest Wayback snapshot
PRIORITY = ['lampaplugins', 'skaztv', 'k03mad', 'bylampa', 'lampaguide', 'github']


def get(url, timeout=20, limit=None, headers=None):
    req = urllib.request.Request(url, headers=dict({'User-Agent': UA, 'Accept-Encoding': 'gzip'}, **(headers or {})))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read(limit) if limit else r.read()
        if r.headers.get('Content-Encoding') == 'gzip' or data[:2] == b'\x1f\x8b':
            try:
                data = gzip.decompress(data)
            except Exception:
                pass
        return r.status, r.headers, data


# ---------------------------------------------------------------- normalisation
GROUPS = {'онлайн видео': 'Онлайн', 'онлайн': 'Онлайн', 'телевидение': 'ТВ', 'управление': 'Управление',
          'разное': 'Разное', 'мои': 'Разное', 'сообщество': 'Разное', 'интерфейс': 'Интерфейс', 'торренты': 'Торренты',
          'тв': 'ТВ', 'радио': 'Радио', 'музыка': 'Музыка', '18+': '18+', 'tmdb proxy': 'TMDB Proxy'}


def norm_group(g):
    if not g:
        return None
    g = g.strip()
    if g.startswith('@') or g.lower() == 'популярные':
        return None
    return GROUPS.get(g.lower(), g)


def key(url):
    u = url.strip().replace('cub.watch', 'cub.red').replace('bwa.to', 'bwa.ad')
    p = urllib.parse.urlsplit(u if '//' in u else '//' + u)
    host = p.netloc.lower()
    host = host[4:] if host.startswith('www.') else host
    q = [kv for kv in urllib.parse.parse_qsl(p.query, keep_blank_values=True) if kv[0].lower() not in ('v', 'ver', 'version', 't', '_', 'cache', 'rnd')]
    return host + p.path.rstrip('/') + ('?' + urllib.parse.urlencode(q) if q else '')


def valid_url(u):
    return bool(re.match(r'^https?://[^\s<>]+$', u.strip()))


# ---------------------------------------------------------------- collectors
def from_json(name, text):
    out = []
    for g in json.loads(text).get('results', []):
        for r in g.get('results', []):
            out.append(dict(url=r.get('link'), name=r.get('name'), source=name, descr=r.get('descr'), author=r.get('author'),
                            version=r.get('version'), group=norm_group(g.get('title')), popular=(g.get('hpu') == 'best') or None))
    return out


def from_bylampa(name, text):
    cat = {'interface': 'Интерфейс', 'management': 'Управление', 'music': 'Музыка', 'online': 'Онлайн', 'radio': 'Радио',
           'sisi': '18+', 'tmdb_proxy': 'TMDB Proxy', 'tv': 'ТВ', 'torrent': 'Торренты'}
    out = []
    for b in re.split(r'Lampa\.SettingsApi\.addParam\(', text):
        m = re.search(r"itemON\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]*)['\"]\s*,\s*['\"]([^'\"]*)['\"]", b)
        if not m:
            continue
        c = re.search(r"component:\s*['\"]add_(\w+?)_plugin['\"]", b)
        d = re.search(r"field:\s*\{[^}]*?description:\s*'((?:[^'\\]|\\.)*)'", b, re.S)
        out.append(dict(url=m.group(1), name=m.group(2), source=name, author=m.group(3),
                        descr=d.group(1).replace("\\'", "'") if d else None, group=cat.get(c.group(1)) if c else None))
    return out


class Guide(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.sec, self.cur, self.field, self.out = None, None, None, []

    def handle_starttag(self, tag, a):
        a = dict(a)
        if tag == 'section' and (a.get('id') or '').endswith('-plugins'):
            self.sec = a['id'][:-8]
        elif tag == 'div' and 'plugin-card' in (a.get('class') or '').split():
            self.cur = {'sec': self.sec, 'name': '', 'descr': '', 'url': '', 'status': None, 'page': None}
        elif self.cur is not None:
            if tag == 'a' and (a.get('href') or '').startswith('/plugins/'):
                self.cur['page'] = 'https://lampaguide.com' + a['href']
                self.field = 'name'
            elif tag == 'p':
                self.field = 'descr'
            elif tag == 'code':
                self.field = 'url'
            elif tag == 'span' and 'plugin-status' in (a.get('class') or ''):
                self.cur['status'] = (a['class'].split()[-1])

    def handle_endtag(self, tag):
        if tag in ('a', 'p', 'code'):
            self.field = None
        elif tag == 'section':
            self.sec = None
        if tag == 'div' and self.cur and self.cur['url'] and self.cur['name']:
            self.out.append(self.cur)
            self.cur = None

    def handle_data(self, data):
        if self.cur is not None and self.field:
            self.cur[self.field] += data


def from_lampaguide(name, text):
    sec = {'online': 'Онлайн', 'torrent': 'Торренты', 'tv': 'ТВ', 'interface': 'Интерфейс', 'tools': 'Инструменты',
           'integration': 'Интеграции', 'mediaserver': 'Медиасерверы', 'stores': 'Магазины', 'radio': 'Радио',
           'adult': '18+', 'special': 'Специальные', 'system': 'Системные'}
    p = Guide()
    p.feed(text)
    out = []
    for c in p.out:
        url = c['url'].strip()
        if not valid_url(url):
            continue  # "torr.to/<ключ>" style templates
        nm = re.sub(r'^[^\w\[(]+', '', c['name']).strip()
        ds = re.sub(r'\s*Плагин для Lampa: адрес для установки, статус и пошаговая инструкция\.?', '', c['descr']).strip()
        out.append(dict(url=url, name=nm, source=name, descr=ds or None, group=sec.get(c['sec']), status=c['status'], page=c['page']))
    return out


def collect():
    raw, report = [], []
    for name, url, kind in STORES:
        text, via = None, url
        try:
            text = get(url, 40)[2].decode('utf-8', 'replace')
        except Exception as e:
            if name in WAYBACK:
                try:
                    cdx = json.loads(get('http://archive.org/wayback/available?url=' + urllib.parse.quote(url.split('//')[1]), 30)[2])
                    ts = cdx['archived_snapshots']['closest']['timestamp']
                    via = 'http://web.archive.org/web/%sid_/%s' % (ts, url)
                    text = get(via, 60)[2].decode('utf-8', 'replace')
                    via += ' (wayback)'
                except Exception as e2:
                    report.append((name, 0, 'unreachable: %s / wayback: %s' % (e, e2)))
                    continue
            else:
                report.append((name, 0, 'unreachable: %s' % e))
                continue
        try:
            recs = {'json': from_json, 'bylampa': from_bylampa, 'lampaguide': from_lampaguide}[kind](name, text)
        except Exception as e:
            report.append((name, 0, 'parse error: %s' % e))
            continue
        report.append((name, len(recs), via))
        raw += recs
    return raw, report


# ---------------------------------------------------------------- merge
def merge(raw):
    byk = {}
    for r in raw:
        if not r.get('url') or not valid_url(r['url']):
            continue
        k = key(r['url'])
        e = byk.setdefault(k, dict(id=k, urls=[], names=[], descrs=[], authors=[], versions=[], groups=[], sources=[], pages=[], flags={}))
        if r['url'].strip() not in e['urls']:
            e['urls'].append(r['url'].strip())
        for f, dst in (('name', 'names'), ('descr', 'descrs'), ('author', 'authors'), ('version', 'versions'), ('group', 'groups'), ('page', 'pages')):
            v = (r.get(f) or '').strip() if isinstance(r.get(f), str) else r.get(f)
            if v:
                e[dst].append((PRIORITY.index(r['source']), v))
        if r['source'] not in e['sources']:
            e['sources'].append(r['source'])
        for f in ('popular', 'status', 'repo', 'stars', 'pushed', 'created', 'topics', 'found', 'license', 'homepage', 'archived'):
            if r.get(f) is not None:
                e['flags'][f] = r[f]
    out = []
    for e in byk.values():
        best = lambda lst, longest=False: (sorted(lst, key=lambda t: (-len(t[1]) if longest else t[0]))[0][1] if lst else None)
        https_first = sorted(e['urls'], key=lambda u: (not u.startswith('https'), len(u)))
        names = sorted(e['names'], key=lambda t: t[0])
        p = dict(id=e['id'], name=names[0][1] if names else os.path.basename(e['id']),
                 url=https_first[0], mirrors=https_first[1:] or None,
                 author=best(e['authors']), descr=best(e['descrs'], True), version=best(e['versions']),
                 group=best(e['groups']) or 'Разное', sources=sorted(e['sources'], key=PRIORITY.index),
                 alt_names=sorted({n for _, n in e['names'] if n != names[0][1]}) or None, page=best(e['pages']))
        p.update(e['flags'])
        out.append({k: v for k, v in p.items() if v not in (None, [], '')})
    return out


# ---------------------------------------------------------------- probing
RE_VER = [re.compile(p, re.I) for p in (
    r"@version\s+v?([\w.\-+]+)", r"\bversion['\"]?\s*[:=]\s*['\"]v?(\d[\w.\-+]*)['\"]",
    r"\bplugin_version\s*=\s*['\"]v?(\d[\w.\-+]*)['\"]", r"\bVERSION\s*=\s*['\"]v?(\d[\w.\-+]*)['\"]",
    r"//\s*v(?:ersion)?[:\s]\s*v?(\d+\.\d+[\w.\-+]*)")]


def probe(p):
    u = p['url']
    info = {'checked': NOW}
    try:
        st, h, body = get(u, 15, 400_000)
        info['http'] = st
        info['size'] = int(h.get('Content-Length') or len(body))
        lm = h.get('Last-Modified')
        if lm:
            info['updated'] = email.utils.parsedate_to_datetime(lm).strftime('%Y-%m-%d')
        txt = body[:120_000].decode('utf-8', 'replace')
        info['lampa'] = bool(re.search(r'\bLampa\b|Lampa\.', txt))
        for rx in RE_VER:
            m = rx.search(txt)
            if m:
                info['ver_parsed'] = m.group(1)
                break
        m = re.search(r"@description\s+(.+)", txt) or re.search(r"\bdescription['\"]?\s*:\s*['\"]([^'\"\n]{8,200})['\"]", txt)
        if m:
            info['descr_parsed'] = m.group(1).strip()
        m = re.search(r"@(?:author|autor)\s+(.+)", txt)
        if m:
            info['author_parsed'] = m.group(1).strip()
    except urllib.error.HTTPError as e:
        info['http'] = e.code
    except Exception as e:
        info['http'] = 0
        info['err'] = type(e).__name__
    return info


def probe_all(plugins):
    with cf.ThreadPoolExecutor(24) as ex:
        for p, info in zip(plugins, ex.map(probe, plugins)):
            p['probe'] = info
            if info.get('http') == 200:
                p.setdefault('updated', info.get('updated'))
                if not p.get('version') and info.get('ver_parsed'):
                    p['version'] = info['ver_parsed']
                if not p.get('descr') and info.get('descr_parsed'):
                    p['descr'] = info['descr_parsed']
                if not p.get('author') and info.get('author_parsed'):
                    p['author'] = info['author_parsed']
            if p.get('updated') is None:
                p.pop('updated', None)


# ---------------------------------------------------------------- github discovery
QUERIES = ['topic:lampa-plugin', 'topic:lampa-plugins', 'topic:lampa-tv', 'lampa plugin in:name,description fork:false']


def gh_api(path):
    tok = os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN')
    if not tok:
        try:
            tok = subprocess.run(['gh', 'auth', 'token'], capture_output=True, text=True, timeout=10).stdout.strip() or None
        except Exception:
            tok = None
    hd = {'Accept': 'application/vnd.github+json'}
    if tok:
        hd['Authorization'] = 'Bearer ' + tok
    return json.loads(get('https://api.github.com' + path, 30, headers=hd)[2])


def github_discover(known_keys, max_repos=60):
    repos = {}
    for q in QUERIES:
        try:
            d = gh_api('/search/repositories?per_page=50&sort=updated&q=' + urllib.parse.quote(q))
        except Exception as e:
            print('github search failed:', q, e, file=sys.stderr)
            continue
        for r in d.get('items', []):
            if r.get('fork') or r.get('archived'):
                continue
            repos[r['full_name']] = r
    out = []
    for name, r in list(repos.items())[:max_repos]:
        br = r.get('default_branch') or 'main'
        try:
            files = json.loads(get('https://data.jsdelivr.com/v1/package/gh/%s@%s/flat' % (name, br), 30)[2]).get('files', [])
        except Exception:
            continue
        cands = [f for f in files if f['name'].endswith('.js') and not f['name'].endswith('.min.js')
                 and 'node_modules' not in f['name'] and f['size'] < 800_000 and f['size'] > 400][:12]
        for f in cands:
            path = f['name'].lstrip('/')
            url = ('https://%s.github.io/%s/%s' % (r['owner']['login'].lower(), r['name'], path)) if r.get('has_pages') \
                else 'https://cdn.jsdelivr.net/gh/%s@%s/%s' % (name, br, path)
            if key(url) in known_keys:
                continue
            try:
                body = get(url, 15, 200_000)[2].decode('utf-8', 'replace')
            except Exception:
                continue
            if not re.search(r'Lampa\.(Plugin|Listener|Template|Settings|SettingsApi|Component|Manifest|Utils|Storage)', body):
                continue
            out.append(dict(url=url, name=os.path.splitext(os.path.basename(path))[0], source='github',
                            author='@' + r['owner']['login'], descr=r.get('description'), group='Найдено в GitHub',
                            repo=name, stars=r.get('stargazers_count'), pushed=(r.get('pushed_at') or '')[:10],
                            created=(r.get('created_at') or '')[:10], topics=r.get('topics') or None, found=True,
                            license=(r.get('license') or {}).get('spdx_id'), homepage=r.get('html_url')))
    return out


# ---------------------------------------------------------------- output
def bake(catalog):
    tpl = open(os.path.join(ROOT, 'plugin', 'lampa-hub.src.js'), encoding='utf-8').read()
    seed = json.dumps(catalog, ensure_ascii=False, separators=(',', ':'))
    js = tpl.replace('/*__SEED__*/null', seed, 1)
    open(os.path.join(ROOT, 'dist', 'lampa-hub.js'), 'w', encoding='utf-8').write(js)
    return len(js)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-github', action='store_true')
    ap.add_argument('--no-probe', action='store_true')
    a = ap.parse_args()
    raw, report = collect()
    for r in report:
        print('source %-13s %4d  %s' % r)
    plugins = merge(raw)
    print('raw %d -> unique %d' % (len(raw), len(plugins)))
    if not a.no_github:
        found = github_discover({p['id'] for p in plugins})
        print('github candidates', len(found))
        plugins = merge(raw + found)
    if not a.no_probe:
        probe_all(plugins)
        print('alive', sum(1 for p in plugins if p.get('probe', {}).get('http') == 200), 'of', len(plugins))
    plugins.sort(key=lambda p: (p['group'] == 'Найдено в GitHub', p['group'], p['name'].lower()))
    catalog = dict(generated=NOW, sources=[dict(name=n, url=u, count=c, via=v) for (n, c, v), (_, u, _) in zip(report, STORES)], plugins=plugins)
    os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
    json.dump(catalog, open(os.path.join(ROOT, 'dist', 'catalog.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    if os.path.exists(os.path.join(ROOT, 'plugin', 'lampa-hub.src.js')):
        print('baked dist/lampa-hub.js,', bake(catalog), 'bytes')


if __name__ == '__main__':
    main()

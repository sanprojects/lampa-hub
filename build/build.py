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
import argparse, concurrent.futures as cf, datetime as dt, email.utils, gzip, html, json, os, re, subprocess, sys, time
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


# ---------------------------------------------------------------- screenshots
SCREENS_URL = 'https://tv-ch.ru/lampa-interface/'


def pick_img(tag):
    """Largest srcset candidate up to 800px wide, else src."""
    src = re.search(r'\ssrc="([^"]+)"', tag)
    best = src.group(1) if src else None
    ss = re.search(r'srcset="([^"]+)"', tag)
    if ss:
        cands = []
        for part in ss.group(1).split(','):
            bits = part.split()
            if len(bits) == 2 and bits[1].endswith('w') and bits[1][:-1].isdigit() and int(bits[1][:-1]) <= 800:
                cands.append((int(bits[1][:-1]), bits[0]))
        if cands:
            best = max(cands)[1]
    return best if best and best.startswith('https://') and best.isascii() else None


def fetch_screens():
    """plugin key -> screenshot URL, parsed from the tv-ch.ru article (heading, image(s), plugin .js links)."""
    try:
        text = get(SCREENS_URL, timeout=30)[2].decode('utf-8', 'replace')
    except Exception as e:
        print('screens: unavailable', e)
        return {}
    start = text.find('wp-block-heading')
    ends = [i for i in (text.find('id="comments"', start), text.find('Комментарии</span>', start), text.find('<footer', start)) if i > 0]
    end = min(ends) if ends else -1
    body = text[start:end if end > 0 else None]
    out, img, urls = {}, None, []

    def flush():
        if img:
            for u in urls:
                out.setdefault(key(u), img)

    for m in re.finditer(r'<h[23][^>]*>|<img\b[^>]*>|href="(https?://[^"]+\.js)(?:\?[^"]*)?"', body):
        t = m.group(0)
        if t.startswith('<h'):
            flush()
            img, urls = None, []
        elif t.startswith('<img'):
            img = img or pick_img(t)
        elif 'tv-ch.ru' not in m.group(1):
            urls.append(m.group(1))
    flush()
    return out


def apply_screens(plugins, screens):
    n = 0
    for p in plugins:
        if not p.get('img') and p['id'] in screens:
            p['img'] = screens[p['id']]
            n += 1
    return n


# ---------------------------------------------------------------- probing
RE_VER = [re.compile(p, re.I) for p in (
    r"@version\s+v?([\w.\-+]+)", r"\bversion['\"]?\s*[:=]\s*['\"]v?(\d[\w.\-+]*)['\"]",
    r"\bplugin_version\s*=\s*['\"]v?(\d[\w.\-+]*)['\"]", r"\bVERSION\s*=\s*['\"]v?(\d[\w.\-+]*)['\"]",
    r"//\s*v(?:ersion)?[:\s]\s*v?(\d+\.\d+[\w.\-+]*)")]


BODIES = {}  # plugin id -> script text (build time only, never written to the catalog)


def probe(p):
    u = p['url']
    info = {'checked': NOW}
    try:
        st, h, body = get(u, 15, 1_000_000)
        info['http'] = st
        info['size'] = int(h.get('Content-Length') or len(body))
        lm = h.get('Last-Modified')
        if lm:
            info['updated'] = email.utils.parsedate_to_datetime(lm).strftime('%Y-%m-%d')
        full = body.decode('utf-8', 'replace')
        txt = full[:120_000]
        BODIES[p['id']] = full
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


# ---------------------------------------------------------------- static safety scan
# Heuristic only: it looks for patterns that deserve a human look, it cannot prove a script is safe.
SAFE_HOSTS = re.compile(r'(?:^|\.)(?:github\.io|github\.com|githubusercontent\.com|jsdelivr\.net|cub\.(?:red|watch|rip)|lampa\.(?:mx|stream)|'
                        r'themoviedb\.org|tmdb\.org|imdb\.com|kinopoisk\.(?:ru|dev)|w3\.org|googleapis\.com|gstatic\.com|google\.com|'
                        r'cloudflare\.com|unpkg\.com|youtube\.com|youtu\.be|ytimg\.com|apple\.com|mozilla\.org|mozilla\.com|jquery\.com|'
                        r'example\.com|schema\.org|bwa\.(?:to|ad)|skaz\.tv|skaztv\.online|spotify\.com|shikimori\.(?:one|io|me))$', re.I)
RE_URLHOST = re.compile(r"""['"`](?:https?:)?//([a-z0-9][a-z0-9.-]{1,60}\.[a-z]{2,12}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/'"`?#]|$)""", re.I)
SCAN_RULES = [  # (code, severity, regex)
    ('miner', 'risk', re.compile(r'coinhive|cryptonight|coin-?imp|minero|webminer', re.I)),
    ('stealer', 'risk', re.compile(r"""Lampa\.Storage\.get\(\s*['"](?:account(?:_user|_token)?|cub_token|torrserver_(?:password|login)|iptv_(?:password|login))['"]"""
                                   r"""|localStorage\.getItem\(\s*['"](?:account|token|cub_token)""", re.I)),
    ('eval', 'warn', re.compile(r"""(?<![\w.$])eval\s*\(|new\s+Function\s*\(|setTimeout\(\s*['"]|setInterval\(\s*['"]""")),
    ('obf', 'warn', re.compile(r'_0x[0-9a-f]{4,}|eval\(function\(p,a,c,k,e|\\x[0-9a-f]{2}(?:\\x[0-9a-f]{2}){12,}', re.I)),
    ('cookie', 'warn', re.compile(r'document\.cookie')),
    ('beacon', 'warn', re.compile(r'sendBeacon\s*\(')),
    ('write', 'warn', re.compile(r'document\.write(?:ln)?\s*\(')),
    ('ipurl', 'warn', re.compile(r"""['"]https?://\d{1,3}(?:\.\d{1,3}){3}""")),
    ('loader', 'info', re.compile(r"""putScript\s*\(|\$\.getScript|importScripts\s*\(|createElement\(\s*['"]script['"]\s*\)""")),
]


def scan(txt, url):
    """-> {'v': 'ok'|'warn'|'risk', 'f': [codes], 'h': [external hosts], 'n': host count}."""
    found = {}
    for code, sev, rx in SCAN_RULES:
        if rx.search(txt):
            found[code] = sev
    if url.startswith('http://'):
        found['http'] = 'warn'
    hosts = sorted({m.group(1).lower() for m in RE_URLHOST.finditer(txt) if not SAFE_HOSTS.search(m.group(1))})
    if found.get('stealer') and not hosts:
        del found['stealer']  # reading local settings with nothing to send them to is not an exfiltration pattern
    sev = 'risk' if 'risk' in found.values() else 'warn' if 'warn' in found.values() else 'ok'
    return {'v': sev, 'f': sorted(found), 'h': hosts[:8], 'n': len(hosts)}


def header_about(txt):
    """First block comment of the script, trimmed (None when there is none worth showing)."""
    m = re.match(r'\s*/\*+([\s\S]{20,1500}?)\*/', txt)
    if m:
        t = re.sub(r'^\s*\*+ ?', '', m.group(1), flags=re.M)
        t = re.sub(r'[ \t]+', ' ', t).strip()
        if len(t) >= 20:
            return t[:700]
    return None


# ---------------------------------------------------------------- GitHub: source resolution, metadata, README
def gh_from_url(url):
    """(owner, repo|None, branch|None, path) for URLs that point into GitHub (raw / jsDelivr / Pages / blob)."""
    p = urllib.parse.urlsplit(url)
    h, path = p.netloc.lower(), p.path.lstrip('/')
    if h == 'raw.githubusercontent.com' and path.count('/') >= 3:
        o, r, b, rest = path.split('/', 3)
        return o, r, b, rest
    if h == 'cdn.jsdelivr.net' and path.startswith('gh/'):
        m = re.match(r'gh/([^/@]+)/([^/@]+)(?:@([^/]+))?/(.+)$', path)
        if m:
            return m.group(1), m.group(2), m.group(3), m.group(4)
    if h in ('github.com', 'www.github.com'):
        m = re.match(r'([^/]+)/([^/]+)/(?:raw|blob)/([^/]+)/(.+)$', path)
        if m:
            return m.groups()
    if h.endswith('.github.io'):
        return h[:-len('.github.io')], None, None, path
    return None


_RC = {}


def gh_cached(path):
    if path not in _RC:
        try:
            _RC[path] = gh_api(path)
        except urllib.error.HTTPError as e:
            _RC[path] = {'_err': e.code}
        except Exception as e:
            _RC[path] = {'_err': str(e)}
    return _RC[path]


def resolve_repo(p):
    """Set p['repo'] (+ _branch / _path) when the plugin URL itself identifies a GitHub repository."""
    r = gh_from_url(p['url'])
    if not r:
        return
    owner, repo, branch, path = r
    if repo is None:  # <owner>.github.io/<repo>/<path>  or  <owner>.github.io/<path>
        seg = path.split('/', 1)
        cands = [(seg[0], seg[1])] if len(seg) == 2 else []
        cands.append((owner + '.github.io', path))
        for rn, rest in cands:
            if gh_cached('/repos/%s/%s' % (owner, rn)).get('full_name'):
                repo, path = rn, rest
                break
        if not repo:
            return
    p['repo'] = '%s/%s' % (owner, repo)
    if branch:
        p['_branch'] = branch
    p['_path'] = path


GENERIC = {'index', 'plugin', 'main', 'all', 'app', 'script', 'lampa', 'plugins', 'test', 'a', 'e', 'f', 'l', 'o', 't', 'tv', 'tmp', 'my', 'num', 'x'}


def norm_body(t):
    return re.sub(r'\s+', '', t)


def search_source(p, budget):
    """Plugin on a third-party host: look for the very same file on GitHub (code search by file name + exact body match)."""
    body = BODIES.get(p['id'])
    base = os.path.basename(urllib.parse.urlsplit(p['url']).path)
    if not body or not base.endswith('.js') or os.path.splitext(base)[0].lower() in GENERIC or budget[0] <= 0:
        return
    budget[0] -= 1
    time.sleep(6.5)  # code search: 10 requests / minute
    d = gh_cached('/search/code?per_page=10&q=' + urllib.parse.quote('filename:%s Lampa' % base))
    want = norm_body(body)
    best = None
    for it in d.get('items', [])[:8]:
        repo = it['repository']['full_name']
        raw = 'https://raw.githubusercontent.com/%s/HEAD/%s' % (repo, urllib.parse.quote(it['path']))
        try:
            got = get(raw, 15, 1_000_000)[2].decode('utf-8', 'replace')
        except Exception:
            continue
        if norm_body(got) == want:
            meta = gh_cached('/repos/' + repo)
            if meta.get('fork'):
                continue
            sc = meta.get('stargazers_count', 0)
            if not best or sc > best[0]:
                best = (sc, repo, it['path'], meta.get('default_branch') or 'main')
    if best:
        p['repo'], p['_path'], p['_branch'] = best[1], best[2], best[3]
        p['_exact'] = True


def jsd(repo, branch, path):
    return 'https://cdn.jsdelivr.net/gh/%s@%s/%s' % (repo, branch, path)


BADGE = re.compile(r'shields\.io|badgen|badge|travis-ci|codecov|codacy|forthebadge|visitor-badge|seeyoufarm|/workflows/|\.svg(?:[?#]|$)|'
                   r'buymeacoffee|ko-fi|patreon|paypal|opencollective|sponsor|avatars\.|/logo|favicon|emoji', re.I)
GH_BLOB = re.compile(r'^https://github\.com/([^/]+/[^/]+)/(?:blob|raw)/([^/]+)/(.+?)(?:\?raw=true)?$')


def readme_image(md, repo, branch, rpath):
    """First real picture of the README (badges / svg / logos skipped), as an https URL the Lampa WebView can load."""
    base_dir = os.path.dirname(rpath)
    for m in re.finditer(r'!\[[^\]]*\]\(\s*<?([^)\s>]+)|<img\b[^>]*?\ssrc=["\']([^"\']+)', md, re.I):
        u = (m.group(1) or m.group(2) or '').strip()
        if not u or BADGE.search(u):
            continue
        g = GH_BLOB.match(u)
        if g:
            u = jsd(g.group(1), g.group(2), g.group(3))
        elif not re.match(r'^[a-z]+:', u) and not u.startswith('//'):
            rel = u.lstrip('/') if u.startswith('/') else os.path.normpath(os.path.join(base_dir, u))
            u = jsd(repo, branch, rel)
        if u.startswith('https://') and u.isascii() and re.search(r'\.(?:png|jpe?g|gif|webp)(?:[?#]|$)|githubusercontent\.com|github\.com/user-attachments', u, re.I):
            return u
    return None


def enrich_repo(repo):
    """Repo + owner metadata and the README, or None when the API does not know the repo."""
    d = gh_cached('/repos/' + repo)
    if not d.get('full_name'):
        return None
    out = dict(repo=d['full_name'], stars=d.get('stargazers_count', 0), forks=d.get('forks_count', 0), pushed=(d.get('pushed_at') or '')[:10],
               created=(d.get('created_at') or '')[:10], archived=bool(d.get('archived')) or None, license=(d.get('license') or {}).get('spdx_id'),
               topics=d.get('topics') or None, homepage=d.get('html_url'), issues=d.get('open_issues_count'), branch=d.get('default_branch') or 'main',
               gdescr=d.get('description'), fork=bool(d.get('fork')) or None)
    if out['license'] == 'NOASSERTION':
        out['license'] = None
    o = gh_cached('/users/' + d['owner']['login'])
    if o.get('login'):
        out.update(owner_created=(o.get('created_at') or '')[:10], owner_type=o.get('type'), owner_followers=o.get('followers'), owner_repos=o.get('public_repos'))
    rd = gh_cached('/repos/%s/readme' % repo)
    if rd.get('content'):
        import base64
        try:
            md = base64.b64decode(rd['content']).decode('utf-8', 'replace')
        except Exception:
            md = ''
        out['readme_path'] = rd.get('path') or 'README.md'
        out['rimg'] = readme_image(md, repo, out['branch'], out['readme_path'])
    return out


# ---------------------------------------------------------------- categories for plugins found on GitHub
CATS = [  # (group, regex) — matched in this order against name / description / topics / header, then repo description, then the script
    ('18+', r'\b(?:porn\w*|xxx|nsfw|adult|sisi|erotic\w*)\b|18\+|порно|эрот'),
    ('Торренты', r'torrent|torrserver|jackett|prowlarr|kinozal|rutor|rutracker|transmission|торрент'),
    ('TMDB Proxy', r'tmdb[ _-]?proxy|proxy[ _-]?tmdb'),
    ('Радио', r'\bradio\b|радио'),
    ('Музыка', r'\bmusic\b|spotify|deezer|музык'),
    ('Медиасерверы', r'jellyfin|\bplex\b|\bemby\b|medi[ao]server|медиасервер'),
    ('Интеграции', r'trakt|simkl|shikimori|\bmal\b|myanimelist|telegram|discord|mqtt|home ?assistant|webhook|\bsync\b|синхрон|интеграц'),
    ('ТВ', r'iptv|\bepg\b|tv ?channels?|телевид|телеканал|плейлист'),
    ('Онлайн', r'online|онлайн|balanser|балансер|rezka|filmix|kodik|collaps|alloha|videocdn|lampac|vkvideo|vk ?видео|kinopub|stream|парсер'),
    ('Управление', r'remote|пульт|управлен|hotkey|keyboard|клавиатур|gamepad|\bmouse\b|navigation|навигац|bookmark|закладк|backup|resume|продолж'),
    ('Интерфейс', r'interface|интерфейс|\bui\b|theme|\bтем[аы]\b|skin|style|\bcss\b|rating|рейтинг|netflix|poster|постер|menu|меню|logo|логотип|color|цвет|animation|анимац|background|\bфон|studio|студи|collection|подборк|home ?screen|главн'),
    ('Инструменты', r'tool|utils?\b|debug|console|subtitle|субтитр|player|плеер|quality|качеств|fix|patch|исправ|filter|фильтр|speed|скорост|preload'),
]
CATS_RX = [(g, re.compile(rx, re.I)) for g, rx in CATS]


def infer_group(p, topics, repo_descr):
    head = ' '.join(x for x in (p.get('name'), p.get('descr'), ' '.join(topics or []), p.get('about'), os.path.basename(p.get('_path') or p['url'])) if x)
    for g, rx in CATS_RX:
        if rx.search(head):
            return g
    for g, rx in CATS_RX:
        if repo_descr and rx.search(repo_descr):
            return g
    body = (BODIES.get(p['id']) or '')[:30000]
    best, hits = None, 2
    for g, rx in CATS_RX:
        n = len(rx.findall(body))
        if n > hits:
            best, hits = g, n
    return best or 'Разное'


TRUSTED_SOURCES = ('lampaplugins', 'skaztv', 'k03mad', 'bylampa', 'lampaguide')  # the five stores the hub is built from


def sort_key(p):
    """trusted first, then GitHub stars (more first), then last update (newer first), then GitHub account age (older first)."""
    upd = p.get('updated') or p.get('pushed') or '0000-00-00'
    return (not p.get('trusted'), -(p.get('stars') or 0), [-ord(c) for c in upd], p.get('owner_created') or '9999-99-99', p['name'].lower())


def enrich(plugins, search_budget=40):
    """Resolve GitHub sources, pull repo / owner / README data, regroup discovered plugins, scan scripts, mark trusted."""
    for p in plugins:
        resolve_repo(p)
    budget = [search_budget]
    for p in plugins:
        if not p.get('repo'):
            search_source(p, budget)
    meta = {r: enrich_repo(r) for r in sorted({p['repo'] for p in plugins if p.get('repo')})}
    nsrc = nsw = 0
    for p in plugins:
        body = BODIES.get(p['id'])
        if body:
            p['scan'] = scan(body, p['url'])
            ab = header_about(body)
            if ab:
                p['about'] = ab
        m = meta.get(p.get('repo')) if p.get('repo') else None
        if p.get('repo') and not m:
            p.pop('repo')
        if m:
            nsrc += 1
            for k, v in m.items():
                if v is not None and k not in ('gdescr', 'readme_path', 'branch', 'rimg'):
                    p[k] = v
            if m.get('rimg') and not p.get('img'):
                p['img'] = m['rimg']
            if m.get('readme_path'):
                p['rd'] = '%s@%s/%s' % (m['repo'], m['branch'], m['readme_path'])
            if not p.get('descr') and m.get('gdescr'):
                p['descr'] = m['gdescr']
            if p.pop('_exact', False) and p.get('_path'):  # identical file on GitHub: install from there instead of a third-party host
                new = jsd(m['repo'], m['branch'], p['_path'])
                if key(new) != p['id']:
                    p['mirrors'] = [p['url']] + [u for u in (p.get('mirrors') or []) if u != p['url']]
                    p['url'] = new
                    nsw += 1
            if p.get('found'):
                p['group'] = infer_group(p, m.get('topics'), m.get('gdescr') if m.get('gdescr') != p.get('descr') else None)
        if p.get('found') and p['group'] == 'Найдено в GitHub':
            p['group'] = infer_group(p, p.get('topics'), None)
        if p.get('found') and m and (p['name'].lower() in GENERIC or len(p['name']) <= 2):  # generic file name -> prefer the repo name
            rn = m['repo'].split('/')[1]
            p['name'] = rn if p['name'].lower() in ('index', 'plugin', 'main') else '%s (%s)' % (rn, p['name'])
        h = urllib.parse.urlsplit(p['url']).netloc.lower()
        p['domain'] = h[4:] if h.startswith('www.') else h
        if p['domain'] == 'cdn.jsdelivr.net' and '/gh/' in p['url']:
            p['domain'] = 'github.com'  # jsDelivr is only the transport; the source is the GitHub repo
        p['trusted'] = True if any(s in TRUSTED_SOURCES for s in p.get('sources', [])) else None
        for k in [k for k in p if k.startswith('_') or p[k] is None]:
            del p[k]
    plugins.sort(key=sort_key)
    return nsrc, nsw


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
    ap.add_argument('--no-search', action='store_true', help='skip the GitHub code search for third-party hosted plugins')
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
    nsrc, nsw = enrich(plugins, 0 if a.no_search else 40)
    print('github repos for', nsrc, 'plugins; install url moved to GitHub for', nsw)
    print('screenshots for', apply_screens(plugins, fetch_screens()), 'plugins')
    catalog = dict(generated=NOW, sources=[dict(name=n, url=u, count=c, via=v) for (n, c, v), (_, u, _) in zip(report, STORES)], plugins=plugins)
    os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
    json.dump(catalog, open(os.path.join(ROOT, 'dist', 'catalog.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    if os.path.exists(os.path.join(ROOT, 'plugin', 'lampa-hub.src.js')):
        print('baked dist/lampa-hub.js,', bake(catalog), 'bytes')


if __name__ == '__main__':
    main()

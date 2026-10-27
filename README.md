# Lampa Hub

One Lampa plugin store that merges lampaplugins, k03mad, skaztv, bylampa and lampaguide, dedupes by normalized URL, auto-discovers plugins on GitHub, and keeps a per-plugin history (name, version, date, description, sources, install events).

- `build/build.py` — collects all sources, dedupes, probes URLs, GitHub discovery, bakes `dist/lampa-hub.js` (`--no-github`, `--no-probe`).
- `plugin/lampa-hub.src.js` — client template (`/*__SEED__*/null` is replaced by the catalog).
- `dist/lampa-hub.js` — the plugin to add in Lampa: `https://sanprojects.github.io/lampa-hub/lampa-hub.js` (rebuilt and deployed to Pages by `.github/workflows/build.yml` every 6 hours).
- `dist/catalog.json` — merged catalog.

Run: `python3 -I build/build.py`. Note: skaztv.online was unreachable at build time, so its seed comes from a Wayback snapshot; the plugin re-fetches the live list on the device.

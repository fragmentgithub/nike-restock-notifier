# Handoff for Claude

作業日: 2026-07-09 JST

## 概要

Nikeの商品リストック監視アプリです。ローカルではNodeサーバーで動き、GitHub Pagesでは静的ページとして直近ステータスを表示します。実際の定期監視とDiscord通知はGitHub Actionsで実行しています。

## 重要URL

- GitHub repo: https://github.com/fragmentgithub/nike-restock-notifier
- GitHub Pages: https://fragmentgithub.github.io/nike-restock-notifier/
- 監視対象: https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-8cpWgYfX/HQ4307-005

## 現在の状態

- Branch: `main`
- Local repo: `C:\Users\star_\Documents\ni_re`
- Latest commit at handoff: `b7f80c7 Improve Pages monitoring controls`
- Working tree: clean against `origin/main`
- Latest scheduled monitor run: success
- Last public status checked: `2026-07-08T20:47:27.848Z` / `2026-07-09 05:47:27 JST`
- Current stock status: `全サイズ在庫なし`
- Discord secret: `DISCORD_WEBHOOK` is set in GitHub Actions secrets
- Current size filter: empty, meaning all sizes

## Architecture

### Local app

- `server.js`
  - Serves `public/`
  - Provides `/api/state`, `/api/config`, `/api/start`, `/api/stop`, `/api/check`, `/api/test-discord`, `/api/events`
  - Uses Server-Sent Events for browser updates
  - Stores local runtime state under `data/*.json`

- `src/nike.js`
  - Core Nike stock checker
  - Parses Nike PDP `__NEXT_DATA__` first
  - Falls back to page text and older product feed API candidates
  - Current Nike page returns sizes 24-30 and product-level `OUT_OF_STOCK`

- `public/index.html`, `public/app.js`, `public/styles.css`
  - Shared UI for local app and GitHub Pages
  - In local mode, calls `/api/*`
  - In GitHub Pages mode, falls back to `status.json`

### GitHub Pages and Actions

- `.github/workflows/pages.yml`
  - Runs on push, workflow dispatch, and `*/5 * * * *`
  - Runs `scripts/monitor.js`
  - Deploys `public/` to GitHub Pages
  - Uses `.monitor-state/state.json` via Actions cache to avoid repeated Discord notifications for the same available size set

- `scripts/monitor.js`
  - Reads:
    - `PRODUCT_URL` variable, optional
    - `SIZE_FILTERS` variable, optional
    - `INTERVAL_SECONDS` variable, optional, minimum 300
    - `DISCORD_WEBHOOK` secret, optional but currently set
  - Writes:
    - `.monitor-state/state.json`
    - `public/status.json`
  - Sends Discord notification only when `result.inStock === true` and the current available size key differs from the cached previous key
  - Clears the cached stock key when out of stock, so a later restock notifies again

- `.github/workflows/discord-test.yml`
  - Manual workflow for testing Discord webhook
  - Runs `scripts/test-discord.js`
  - Last known test run succeeded

## Commands

Local app:

```powershell
node server.js
```

Manual local stock check:

```powershell
node scripts\monitor.js
```

Run GitHub monitor manually:

```powershell
gh workflow run pages.yml --repo fragmentgithub/nike-restock-notifier
```

Run Discord test:

```powershell
gh workflow run discord-test.yml --repo fragmentgithub/nike-restock-notifier
```

Check recent Actions:

```powershell
gh run list --repo fragmentgithub/nike-restock-notifier --limit 5
```

## GitHub Settings

Actions secrets:

- `DISCORD_WEBHOOK`: Discord webhook URL. Already set.

Actions variables:

- `SIZE_FILTERS`: optional, comma-separated, example `26,27`
- `PRODUCT_URL`: optional override for monitored product URL
- `INTERVAL_SECONDS`: optional display/config value, minimum 300 in script

GitHub Pages source is workflow-based. If Pages needs to be re-enabled:

```powershell
gh api --method POST repos/fragmentgithub/nike-restock-notifier/pages -f build_type=workflow
```

## Known Caveats

- GitHub Pages is static. It cannot run the Node server or securely store webhook settings in the browser. Monitoring must stay in GitHub Actions or another backend.
- GitHub scheduled workflows are not exact timers. The workflow is configured for every 5 minutes, but GitHub can delay runs.
- GitHub Actions currently shows a Node 20 deprecation warning from third-party action internals. The workflow still succeeds and GitHub forces those actions onto Node 24.
- PowerShell may display Japanese text as mojibake with `Get-Content`. Node/browser read the files as UTF-8 correctly.
- Local `git status` may warn about `C:\Users\star_/.config/git/ignore` permission in this sandbox. It has not blocked commit/push.
- Do not commit `data/*.json` or `.monitor-state/`; they are ignored intentionally.
- Nike can change its page structure. If stock parsing breaks, start in `src/nike.js`, especially `parseNextProductData`.

## Suggested Next Work

1. Multi-product support: store an array of product URLs and emit one Discord message per restocked product.
2. Better settings flow: add a GitHub Actions workflow with manual inputs to update repo variables for `SIZE_FILTERS` and `PRODUCT_URL`.
3. Notification channels: add LINE Notify replacement / Slack / email.
4. Status history: keep last N checks in `status.json` for a small trend/history table.
5. Failure alerting: send Discord warning after repeated Nike fetch failures.


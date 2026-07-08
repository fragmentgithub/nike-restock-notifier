# Handoff for Claude

作業日: 2026-07-09 JST

## 運用方針(重要)

**このアプリはローカルでは動かさない。監視・通知・表示はすべてGitHub上で完結させる。**

- 定期監視とDiscord通知: GitHub Actions (`pages.yml`)
- ステータス表示: GitHub Pages(静的ページ + `status.json`)
- 設定変更: GitHubのリポジトリ変数/シークレット(`gh` CLIまたはWeb UI)
- ローカルリポジトリはコード編集とpushのためだけに使う

リポジトリ内の `server.js` と `data/` はローカル実行用の遺物で、現行運用では使わない。

## 概要

Nikeの商品リストック監視アプリ。GitHub Actionsが定期的にNikeの商品ページを確認し、在庫が出たらDiscordへ通知する。結果はGitHub Pagesに静的表示される。

## 重要URL

- GitHub repo: https://github.com/fragmentgithub/nike-restock-notifier
- GitHub Pages: https://fragmentgithub.github.io/nike-restock-notifier/
- ライブステータス: https://fragmentgithub.github.io/nike-restock-notifier/status.json
- 監視対象: https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-8cpWgYfX/HQ4307-005

## 現在の状態

- Branch: `main`
- Local repo: `C:\Users\star_\Documents\ni_re`(編集・push用)
- Latest commit at handoff: `9579b47 Add Claude handoff notes`
- Working tree: 未コミットの変更あり — ループ方式の実装(`scripts/monitor.js`, `pages.yml`, `public/app.js`)とドキュメント改訂。**pushするまで本番には反映されない**
- Latest monitor run: success(2026-07-08T21:02:46Z = 2026-07-09 06:02 JST)
- Current stock status: `全サイズ在庫なし`(サイズ24-30、商品レベル `OUT_OF_STOCK`)
- Discord secret: `DISCORD_WEBHOOK` はGitHub Actions secretsに設定済み
- Current size filter: 空(= 全サイズ対象)
- 監視方式: **ループ方式**。1回のActions実行が約25分間動き続け、その中で約2分ごとにNikeをチェックする(下記Architecture参照)。cron自体は5分設定でGitHub側で20〜40分に遅延するが、ループ中は細かくチェックされるため、通知の実効間隔は約1分(`INTERVAL_SECONDS=60`設定済み)

## Architecture

### GitHub Actions + Pages(現行運用)

- `.github/workflows/pages.yml`
  - トリガー: push(main)、workflow_dispatch、cron `*/5 * * * *`
  - `scripts/monitor.js` を実行(約25分ループしてNike在庫を確認し続ける)
  - ループ終了後に `public/` をGitHub Pagesへデプロイ
  - `.monitor-state/state.json` をActions cacheで持ち回り、同じ在庫状態での重複Discord通知を防ぐ
  - `timeout-minutes: 355`(`LOOP_MINUTES` を大きくしても6時間の上限内で動くように)
  - cronの発火自体はGitHub側で20〜40分遅延するが、各実行が25分カバーするので隙間は小さい

- `scripts/monitor.js`(**ループ方式**)
  - 1回の実行で `LOOP_MINUTES` 分(デフォルト25分)ループし、`INTERVAL_SECONDS` 秒ごと(デフォルト120秒、下限60)にNikeをチェックする
  - 在庫が出たらループ内で**即座に**Discord通知(Pagesのデプロイを待たない)
  - 読み込み:
    - `PRODUCT_URL` variable(任意)
    - `SIZE_FILTERS` variable(任意、カンマ区切り)
    - `INTERVAL_SECONDS` variable(任意、チェック間隔秒。30〜1800、デフォルト120。現在60を設定済み)
    - `LOOP_MINUTES` variable(任意、1回の実行のループ分数。0〜340、デフォルト25。0で単発チェック=デバッグ用)
    - `DISCORD_WEBHOOK` secret(任意だが設定済み)
  - 書き込み(ループの各イテレーションで更新):
    - `.monitor-state/state.json`(Actions cacheのみ。gitには入れない。イベント履歴も持ち回る)
    - `public/status.json`(実行終了後にPagesへデプロイされる)
  - Discord通知条件: `result.inStock === true` かつ在庫サイズのキーが前回と異なる場合のみ
  - 在庫なしになるとキーをクリアするので、再入荷時はまた通知される
  - Discord送信に失敗した場合はキーを更新せず、次のチェックで再送を試みる
  - チェック処理が例外を投げてもループは継続する(エラーイベントを記録)

- `.github/workflows/discord-test.yml`
  - Discord webhookテスト用の手動workflow(`scripts/test-discord.js` を実行)
  - 直近のテスト実行は成功

- `src/nike.js`
  - Nike在庫チェックのコア
  - NikeのPDP `__NEXT_DATA__` を最優先でパース
  - フォールバック: ページテキスト解析、旧product feed APIの候補
  - パースが壊れたら `parseNextProductData` から調査する

- `public/index.html`, `public/app.js`, `public/styles.css`
  - Pagesで表示されるUI。`status.json` を読んで表示する
  - コード上はローカルモード(`/api/*` 呼び出し)も残っているが、運用では使わない

### 未使用(ローカル実行用の遺物)

- `server.js`: ローカルNodeサーバー。運用では使わない。Pagesにはデプロイされない
- `data/*.json`: ローカルサーバーのランタイム状態。gitignore済み

削除してもGitHub運用には影響しない(Suggested Next Work参照)。

## Commands

すべて `gh` CLIでGitHub上を操作する。ローカルでNodeは動かさない。

監視を手動実行:

```powershell
gh workflow run pages.yml --repo fragmentgithub/nike-restock-notifier
```

Discordテスト:

```powershell
gh workflow run discord-test.yml --repo fragmentgithub/nike-restock-notifier
```

直近の実行確認:

```powershell
gh run list --repo fragmentgithub/nike-restock-notifier --limit 5
```

ライブステータス確認:

```powershell
curl.exe -s https://fragmentgithub.github.io/nike-restock-notifier/status.json
```

設定変更(リポジトリ変数/シークレット):

```powershell
gh variable set SIZE_FILTERS --repo fragmentgithub/nike-restock-notifier --body "26,27"
gh variable set PRODUCT_URL --repo fragmentgithub/nike-restock-notifier --body "https://www.nike.com/jp/t/..."
gh variable set INTERVAL_SECONDS --repo fragmentgithub/nike-restock-notifier --body "120"
gh variable set LOOP_MINUTES --repo fragmentgithub/nike-restock-notifier --body "25"
gh secret set DISCORD_WEBHOOK --repo fragmentgithub/nike-restock-notifier
```

デバッグ用途に限りローカルで単発チェックを実行できる(Node >= 20 必須)。実行後は追跡ファイルを元に戻すこと:

```powershell
$env:LOOP_MINUTES='0'; node scripts/monitor.js
git checkout -- public/status.json
```

運用はGitHub Actionsのみ。

## GitHub Settings

Actions secrets:

- `DISCORD_WEBHOOK`: Discord webhook URL。設定済み

Actions variables:

- `SIZE_FILTERS`: 任意、カンマ区切り。例 `26,27`
- `PRODUCT_URL`: 任意、監視対象URLの上書き
- `INTERVAL_SECONDS`: 任意。ループ内の**実際のチェック間隔(秒)**。30〜1800、デフォルト120。**現在60を設定済み。** 30まで下げられるがNikeブロックのリスクが上がる
- `LOOP_MINUTES`: 任意。1回のActions実行がチェックし続ける分数。0〜340、デフォルト25

GitHub PagesのソースはWorkflowベース。再有効化が必要な場合:

```powershell
gh api --method POST repos/fragmentgithub/nike-restock-notifier/pages -f build_type=workflow
```

## Known Caveats

- **git内の `public/status.json` は古いスナップショット。** monitor.jsがActions実行中に上書きしてPagesへデプロイするだけで、gitにはコミットバックしない。最新データはPages上の `status.json` にしかない。git内のファイルの日付や `discordWebhookSet: false` を見て混乱しないこと。
- **60日ルール:** GitHubはリポジトリに60日間アクティビティがないとscheduled workflowを自動無効化する。コミットなしで長期運用する場合、これが最も現実的な停止リスク。定期的にpushするか、無効化されたらActionsタブから再有効化する。
- **スケジュール遅延:** cronの発火は5分設定でも実測20〜40分間隔。GitHubの仕様であり異常ではない。ループ方式なら各実行が約25分カバーするので影響は小さいが、実行と実行の間に数分〜十数分の隙間は出うる。
- **Nikeのレート制限リスク:** 同一ランナーIPから2分間隔でアクセスする。Nike(Akamai)にブロックされてチェック失敗(403等)が続く場合は `INTERVAL_SECONDS` を上げる。
- **ループ中はpushのデプロイが待たされる:** concurrency groupが同じなので、監視実行中(最大約25分)にpushしても、Pagesへの反映は現在の実行が終わるまで待つ。
- **Pagesの表示はループ単位でしか更新されない:** Discord通知はループ内で即時だが、`status.json` のデプロイは実行終了時。ページ上のデータは最大で `LOOP_MINUTES` 分古い。
- **Actions cacheは7日間未使用で消える。** workflowを1週間以上止めて再開すると `.monitor-state` が消え、在庫ありの場合に重複通知が1回出る可能性がある(実害は小さい)。
- GitHub ActionsでNode 20系のdeprecation warningがサードパーティaction内部から出るが、workflowは成功しており、GitHubがNode 24へ強制している。
- Nikeがページ構造を変えると在庫パースが壊れる。その場合は `src/nike.js` の `parseNextProductData` から調査。
- ローカルでの編集作業時: PowerShellの `Get-Content` は日本語をmojibakeで表示することがある(ファイル自体はUTF-8で正常)。`git status` が `C:\Users\star_/.config/git/ignore` の権限警告を出すことがあるが、commit/pushは阻害されない。
- `data/*.json` と `.monitor-state/` はコミットしない(意図的にignore済み)。

## Suggested Next Work

1. ローカル実行コードの整理: `server.js` と `data/` を削除、`public/app.js` のローカルモード分岐を除去して、GitHub専用構成に一本化する。
2. Multi-product対応: 商品URLの配列を持ち、再入荷した商品ごとにDiscord通知を送る。
3. 設定変更フロー改善: manual inputs付きのworkflowを追加して `SIZE_FILTERS` / `PRODUCT_URL` のリポジトリ変数をGitHub上だけで更新できるようにする。
4. 通知チャネル追加: LINE Notify代替 / Slack / メール。
5. ステータス履歴: `status.json` に直近N回のチェック結果を残して簡単な履歴表を表示する。
6. 失敗アラート: Nike取得の連続失敗時にDiscordへ警告を送る。

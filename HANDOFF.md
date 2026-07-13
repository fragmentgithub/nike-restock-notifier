# Handoff for Claude

作業日: 2026-07-09 JST

## 運用方針(重要)

**このアプリはローカルでは動かさない。監視・通知・表示はすべてGitHub上で完結させる。**

- 定期監視とDiscord通知: GitHub Actions (`pages.yml`)
- ステータス表示: GitHub Pages(静的ページ + `status.json`)
- 設定変更: GitHubのリポジトリ変数/シークレット(`gh` CLIまたはWeb UI)
- ローカルリポジトリはコード編集とpushのためだけに使う

ローカルの `npm start` は `scripts/serve-pages.js` でPages表示だけをプレビューする。監視と設定変更はGitHub Actions専用。

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
- Discord secret: `DISCORD_WEBHOOK` はGitHub Actions secretsに設定済み
- Current size filter: 空(= 全サイズ対象)
- 監視方式: **ループ方式**。全商品を順番に確認し、巡回完了後に `INTERVAL_SECONDS` 秒待つ。**全商品の取得が失敗したサイクル**が続く場合のみ最大10分まで自動バックオフする(1商品だけの失敗ではフリート全体の間隔を延ばさない)。
- 直近のrun結果・在庫状況・現在のコミットは時間で変わるためここには固定しない。次で確認する:
  - コミット/ツリー: `git log --oneline -5` / `git status`
  - 監視run: `gh run list --repo fragmentgithub/nike-restock-notifier --limit 5`
  - 在庫: `curl.exe -s https://fragmentgithub.github.io/nike-restock-notifier/status.json`

## Architecture

### GitHub Actions + Pages(現行運用)

- `.github/workflows/pages.yml`
  - トリガー: push(main)、workflow_dispatch、cron `7,37 * * * *`
  - `scripts/monitor.js` を実行(約25分ループしてNike在庫を確認し続ける)
  - ループ終了後に `public/` をGitHub Pagesへデプロイ
  - `.monitor-state/state.json` をActions cacheで持ち回り、同じ在庫状態での重複Discord通知を防ぐ
  - `timeout-minutes: 355`(`LOOP_MINUTES` を大きくしても6時間の上限内で動くように)
  - **自己連鎖**: `queued` / `pending` / `waiting` / `requested` の待機runがない場合だけ `gh workflow run` で次を起動する。待機runがあれば追加せず、concurrencyによる不要なキャンセルを避ける。
  - **テストは実行しない**。テスト失敗が在庫監視・通知・Pages更新を止めないよう、`npm test` は `test.yml` に分離済み。

- `.github/workflows/test.yml`
  - `npm test` を push(main) / PR / 手動で実行するだけのCI。監視の可用性とは独立。

- `scripts/monitor.js`(**ループ方式**)
  - 1回の実行で `LOOP_MINUTES` 分(デフォルト25分)ループし、全商品巡回後に `INTERVAL_SECONDS` 秒待つ(デフォルト120秒、下限30秒)
  - 在庫が出たらループ内で**即座に**Discord通知(Pagesのデプロイを待たない)
  - 読み込み:
    - `PRODUCT_URL` variable(任意)
    - `SIZE_FILTERS` variable(任意、カンマ区切り)
    - `INTERVAL_SECONDS` variable(任意、巡回完了後の待機秒。30〜1800、デフォルト120。現在120を設定)
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
  - 設定変更APIは持たない読み取り専用UI

### ローカルプレビュー

- `scripts/serve-pages.js`: `public/` の読み取り専用ローカルプレビュー

## Commands

運用操作は `gh` CLI、ローカル検証は Node 24で行う。

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

デバッグ用途に限りローカルで単発チェックを実行できる(Node 24)。実行後は追跡ファイルを元に戻すこと:

```powershell
$env:LOOP_MINUTES='0'; node scripts/monitor.js
git checkout -- public/status.json
```

運用はGitHub Actionsのみ。

## GitHub Settings

Actions secrets:

- `DISCORD_WEBHOOK`: Discord webhook URL。設定済み

Actions variables(すべて任意。範囲/デフォルトは `scripts/monitor.js` の `clampNumber` に一致):

- `SIZE_FILTERS`: カンマ区切り。例 `26,27`(空なら全サイズ)
- `PRODUCT_URL`: 監視対象URLの上書き
- `PRODUCT_URLS`: 追加の監視URL。カンマ区切りまたは改行区切り
- `INTERVAL_SECONDS`: 全商品巡回後の待機秒。30〜1800、デフォルト120。全商品失敗が続くと最大10分まで自動バックオフ
- `LOOP_MINUTES`: 1回のActions実行がチェックし続ける分数。0〜340、デフォルト25(0で単発チェック=デバッグ用)
- `DISCOVERY_URL`: 新カラー探索に使うNike公式一覧URL(通常は未設定で可)
- `DISCOVERY_INTERVAL_HOURS`: 新カラー探索間隔。1〜168、デフォルト6
- `DISCOVERY_RETRY_MINUTES`: 探索失敗時の再試行間隔。5〜360、デフォルト30
- `PRODUCT_CHECK_DELAY_MS`: 商品間のアクセス待機ミリ秒。0〜30000、デフォルト1500

GitHub PagesのソースはWorkflowベース。再有効化が必要な場合:

```powershell
gh api --method POST repos/fragmentgithub/nike-restock-notifier/pages -f build_type=workflow
```

## Known Caveats

- **git内の `public/status.json` は古いスナップショット。** monitor.jsがActions実行中に上書きしてPagesへデプロイするだけで、gitにはコミットバックしない。最新データはPages上の `status.json` にしかない。git内のファイルの日付や `discordWebhookSet: false` を見て混乱しないこと。
- **60日ルール:** GitHubはリポジトリに60日間アクティビティがないとscheduled workflowを自動無効化する。コミットなしで長期運用する場合、これが最も現実的な停止リスク。定期的にpushするか、無効化されたらActionsタブから再有効化する。
- **スケジュール遅延:** cronは毎時7分・37分のバックアップ。自己連鎖があるため通常運用ではcronに依存しない。待機runが存在する場合は自己連鎖を追加しない。
- **runner確保失敗:** GitHub側の混雑で「job was not acquired by runner」となり実行がcancelled/failureになることが稀にある(2026-07-09に1回発生)。コードの問題ではない。連鎖が切れてもcronで自動復旧する。
- **Nikeのレート制限リスク:** 商品ごとのアクセス間隔と巡回後待機に加え、全商品の取得が失敗するサイクルが続く場合は最大10分まで自動バックオフする。
- **ループ中はpushのデプロイが待たされる:** concurrency groupが同じなので、監視実行中(最大約25分)にpushしても、Pagesへの反映は現在の実行が終わるまで待つ。
- **Pagesの表示はループ単位でしか更新されない:** Discord通知はループ内で即時だが、`status.json` のデプロイは実行終了時。ページ上のデータは最大で `LOOP_MINUTES` 分古い。
- **Actions cacheは7日間未使用で消える。** workflowを1週間以上止めて再開すると `.monitor-state` が消え、在庫ありの場合に重複通知が1回出る可能性がある(実害は小さい)。
- GitHub ActionsでNode 20系のdeprecation warningがサードパーティaction内部から出るが、workflowは成功しており、GitHubがNode 24へ強制している。
- Nikeがページ構造を変えると在庫パースが壊れる。その場合は `src/nike.js` の `parseNextProductData` から調査。
- ローカルでの編集作業時: PowerShellの `Get-Content` は日本語をmojibakeで表示することがある(ファイル自体はUTF-8で正常)。`git status` が `C:\Users\star_/.config/git/ignore` の権限警告を出すことがあるが、commit/pushは阻害されない。
- `.monitor-state/` はコミットしない(意図的にignore済み)。

## Suggested Next Work

1. 監視履歴をActions cacheより長期保存したくなった場合は、Firestore等の外部ストレージを検討する。
2. 必要に応じて、商品ごとの長期在庫履歴とグラフ表示を追加する。
3. 設定変更フロー改善: manual inputs付きのworkflowを追加して `SIZE_FILTERS` / `PRODUCT_URL` のリポジトリ変数をGitHub上だけで更新できるようにする。
4. 通知チャネル追加: LINE Notify代替 / Slack / メール。
5. ステータス履歴: `status.json` に直近N回のチェック結果を残して簡単な履歴表を表示する。
6. 失敗アラート: Nike取得の連続失敗時にDiscordへ警告を送る。

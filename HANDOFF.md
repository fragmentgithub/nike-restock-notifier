# Handoff for Claude

## Cloudflare移行作業（2026-09-05、以前の運用方針より優先）

ユーザーがCloudflareへの移行を依頼。Workers + SQLite Durable Objectの実装を追加し、移行先は `https://nike-restock-notifier.only-this-moment.workers.dev/`。本番切り替えは未実施で、GitHub監視は稼働継続中。

- `wrangler.jsonc` がCloudflareの構成。初期モードは `paused`。DOクラス `NikeMonitor`、識別名 `nike-jp`、migration tag `v1` は維持する。
- 監視エンジンは `src/monitor-engine.js`。通常2分・発売前30秒を目安に、1回のalarmで1商品または探索1ページだけ確認する。
- 管理操作は `ADMIN_TOKEN` Secretで保護。Discord通知は `DISCORD_WEBHOOK` Secret。
- `npm run cloudflare:build` で公開なし検証、`npm run cloudflare:deploy` で公開する。
- GitHub側は `MONITOR_BACKEND=cloudflare` に切り替えると監視・自己連鎖をスキップし、Pagesを移転案内にする。health workflowはCloudflareのstatus.jsonを外側から確認する（GitHub監視の自動再起動は無効）。
- 2026-09-05にユーザーが移行先への新規 `ADMIN_TOKEN` と既存 `DISCORD_WEBHOOK` の登録を明示承認。`ADMIN_TOKEN` の登録は完了済み。Webhookの引き継ぎと本番切り替えは準備中。
- 手動 `cloudflare-transfer.yml` は既存Actions cacheの通知済み状態、許可した通常設定、RSA-OAEP SHA256で暗号化したWebhookを、GitHubから移行先 `/migration/transfer` へ直接送る。受信側はGitHub OIDCのリポジトリ・所有者ID・main・指定の手動workflow・audienceを検証し、paused時だけ取り込む。GitHubにCloudflareの管理キーを追加登録しない。
- GitHub artifactへの暗号化Webhookの追加保存は別途自動承認レビューで拒否されたため、`cloudflare-export.yml` は削除し、転送手順を直接送信へ変更した。`scripts/export-cloudflare-state.js` は検証用関数と既存テスト用に残るが、artifact workflowは使用しない。
- 転送された暗号文はCloudflareに非公開で一時保存される。`node scripts/cloudflare-admin.js credential .cloudflare-migration/credential/webhook.enc` で取得し、`node scripts/import-cloudflare-webhook.js .cloudflare-migration/credential` でWorkers Secretへ登録する。登録成功後に `node scripts/cloudflare-admin.js clear-credential` で一時保存した暗号文を削除する。
- 最終転送前はGitHubのhealthとpages workflowを無効化し、未開始の待機実行を取り消す。進行中の監視は状態保存まで自然終了させ、最終キャッシュの正確なキーを `cloudflare-transfer.yml` の `cache_key` に指定する。公開status.jsonからの通知状態再構成は不可。
- 接続確認では固定初期商品 `HQ4307-005` とFragmentページがCloudflare・GitHubの双方で404。一方、Cloudflareの商品探索は現行商品4件を取得できた。現行商品の個別取得を引き続き確認する。
- 移行手順と管理コマンドは [CLOUDFLARE.md](CLOUDFLARE.md)。旧GitHub監視は最終状態を保存するまで維持し、切り替え完了後に実施結果を記録する。
- `.cloudflare-migration/` はgit対象外の一時作業領域。既存キーを作り直さず利用する。ログ・ツール出力・公開ファイルへ内容を出さない。

以下は従来GitHub運用の記録。Cloudflare移行完了後に本節を更新する。

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
- Fragment監視対象: https://www.nike.com/jp/launch/t/mind-001-fragment-black / https://www.nike.com/jp/launch/t/mind-002-fragment-black

## 現在の状態

- Branch: `main`
- Local repo: `C:\Users\star_\Documents\ni_re`(編集・push用)
- Discord secret: `DISCORD_WEBHOOK` はGitHub Actions secretsに設定済み
- Current size filter: 空(= 全サイズ対象)
- 監視方式: **商品別due時刻方式**。`INTERVAL_SECONDS` は通常商品の商品ごとの再確認間隔。直近の時間窓で複数商品の取得がすべて失敗した場合だけ最大10分まで自動バックオフする(1商品だけの失敗ではフリート全体の間隔を延ばさない)。
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
  - **自己連鎖**: 監視対象があり、次の商品確認が「次runの実行時間内」かつ30分以内で、`queued` / `pending` / `waiting` / `requested` の待機runがない場合だけ `gh workflow run` で次を起動する。単発モード・監視対象なし・それより先の確認はcronへ任せ、待機runがあれば追加しない。
  - **テストは実行しない**。テスト失敗が在庫監視・通知・Pages更新を止めないよう、`npm test` は `test.yml` に分離済み。

- `.github/workflows/test.yml`
  - `npm test` を push(main) / PR / 手動で実行するだけのCI。監視の可用性とは独立。

- `.github/workflows/health.yml`
  - 15分ごとに公開 `status.json` の更新時刻を確認する独立watchdog。
  - デフォルト50分以上更新が止まるとDiscordへ1回だけ警告し、復旧時にも1回通知する。実効閾値は `max(HEALTH_STALE_MINUTES, LOOP_MINUTES + 20分)`。
  - `github-pages` environmentの承認待ちで監視runが90分以上 `waiting` のまま固まった場合、そのrunをキャンセルする。後続のactive runがなければ `pages.yml` を再起動する。
  - `.health-state` をActions cacheで持ち回り、同じ異常の重複通知を防ぐ。

- `scripts/monitor.js`(**商品別due時刻方式**)
  - 1回の実行で `LOOP_MINUTES` 分(デフォルト25分)ループし、通常商品は商品ごとに `INTERVAL_SECONDS` 秒間隔で再確認する(デフォルト120秒、下限30秒)
  - 在庫が出たらループ内で**即座に**Discord通知(Pagesのデプロイを待たない)
  - 読み込み:
    - `PRODUCT_URL` variable(任意)
    - `SIZE_FILTERS` variable(任意、カンマ区切り)
    - `INTERVAL_SECONDS` variable(任意、通常商品の商品ごとの再確認秒。30〜1800、デフォルト120。現在120を設定)
    - `LOOP_MINUTES` variable(任意、1回の実行のループ分数。0〜340、デフォルト25。0で単発チェック=デバッグ用)
    - `FRAGMENT_DISCOVERY_URLS` variable(任意、Fragment商品を探索するSNKRS一覧URL。通常は未設定)
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
  - SNKRS発売ページの `initialState` からFragment商品の発売状態・サイズ在庫をパース
  - フォールバック: ページテキスト解析、旧product feed APIの候補
  - パースが壊れたら `parseNextProductData` から調査する

- `src/monitor-policy.js`
  - 商品別設定、自動休止/復帰、在庫変化履歴、発売前スケジュール、品質メトリクスの純粋ロジック。

- `src/health.js`, `scripts/check-health.js`
  - Pages更新停止の判定とDiscordへの停止/復旧通知。

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

Actions variables(すべて任意):

- `SIZE_FILTERS`: カンマ区切り。例 `26,27`(空なら全サイズ)
- `PRODUCT_URL`: 監視対象URLの上書き
- `PRODUCT_URLS`: 追加の監視URL。カンマ区切りまたは改行区切り
- `INTERVAL_SECONDS`: 通常商品の商品ごとの再確認秒。30〜1800、デフォルト120。時間窓内の複数商品失敗が続くと最大10分まで自動バックオフ
- `LOOP_MINUTES`: 1回のActions実行がチェックし続ける分数。0〜340、デフォルト25(0で単発チェック=デバッグ用)
- `DISCOVERY_URL`: 新カラー探索に使うNike公式一覧URL(通常は未設定で可)
- `FRAGMENT_DISCOVERY_URLS`: Fragment探索に使うSNKRS一覧URL。カンマまたは改行区切り(通常は未設定で可)
- `DISCOVERY_INTERVAL_HOURS`: 新カラー探索間隔。1〜168、デフォルト6
- `DISCOVERY_RETRY_MINUTES`: 探索失敗時の再試行間隔。5〜360、デフォルト30
- `PRODUCT_CHECK_DELAY_MS`: 商品間のアクセス待機ミリ秒。0〜30000、デフォルト1500
- `PRODUCT_CONFIG_JSON`: 商品別の `sizes` / `notify` / `enabled` / `mention` を指定するJSON
- `DELIST_FAILURE_THRESHOLD`: 明示的な404/410の連続回数。3〜100、デフォルト12
- `PAUSED_RECHECK_HOURS`: 自動休止商品の再確認時間。1〜168、デフォルト24
- `UPCOMING_INTERVAL_SECONDS`: 発売前商品の確認秒数。15〜600、デフォルト30
- `UPCOMING_WINDOW_MINUTES`: 発売前優先期間。15〜1440、デフォルト180
- `DISCORD_MENTION`: Discordのユーザーまたはロールメンション
- `STATUS_URL`: health watchdogが読むstatus.json URL
- `HEALTH_STALE_MINUTES`: watchdogの更新停止閾値。10〜360、デフォルト50。実効値は `LOOP_MINUTES + 20分` 以上
- `MONITOR_WAITING_STALE_MINUTES`: Pages承認待ちの監視runを自動解除する時間。30〜1440分、デフォルト90分

GitHub PagesのソースはWorkflowベース。再有効化が必要な場合:

```powershell
gh api --method POST repos/fragmentgithub/nike-restock-notifier/pages -f build_type=workflow
```

## Known Caveats

- **git内の `public/status.json` は古いスナップショット。** monitor.jsがActions実行中に上書きしてPagesへデプロイするだけで、gitにはコミットバックしない。最新データはPages上の `status.json` にしかない。git内のファイルの日付や `discordWebhookSet: false` を見て混乱しないこと。
- **60日ルール:** GitHubはリポジトリに60日間アクティビティがないとscheduled workflowを自動無効化する。コミットなしで長期運用する場合、これが最も現実的な停止リスク。定期的にpushするか、無効化されたらActionsタブから再有効化する。
- **スケジュール遅延:** cronは毎時7分・37分のバックアップ。自己連鎖があるため通常運用ではcronに依存しない。待機runが存在する場合は自己連鎖を追加しない。
- **runner確保失敗:** GitHub側の混雑で「job was not acquired by runner」となり実行がcancelled/failureになることが稀にある(2026-07-09に1回発生)。コードの問題ではない。連鎖が切れてもcronで自動復旧する。
- **Nikeのレート制限リスク:** 商品ごとのアクセス間隔に加え、直近の時間窓で複数商品の取得がすべて失敗する場合は最大10分まで自動バックオフする。
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

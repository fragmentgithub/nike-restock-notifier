# Cloudflare 運用ガイド

**閲覧ページは本人限定です。監視・通知と長期保存はCloudflareで動き、PCの電源に依存しません。**

監視は2026-09-05にCloudflareへ移行済みです。本人限定ページと長期保存も反映し、healthy/active・既存通知キーと履歴の保持・入荷14件の引き継ぎ・自動取得の継続を確認しました。本人の実ログイン後の画面確認は未実施です。旧GitHub Pagesの公開を停止し、認証付きの外側health workflowを利用しています。最新のversionと確認結果は [HANDOFF.md](HANDOFF.md) に記録しています。

## 非公開の構成

閲覧先は [本人限定ページ](https://nike-restock-viewer.only-this-moment.workers.dev) です。Cloudflare Accessが本人メールだけを許可し、メールに届くワンタイムコードでログインします。スマートフォンからも利用できます。ページ・静的ファイル・閲覧APIのすべてで認証を要求します。

閲覧Worker `nike-restock-viewer` は、service bindingで監視Workerの名前付きエントリーポイント `MonitorViewer` に接続します。公開するRPCは `getStatus` と `getTrends` だけです。監視の停止・状態インポート・秘密値取得はできません。閲覧Workerは `ADMIN_TOKEN` や `DISCORD_WEBHOOK` を持ちません。

`src/viewer-worker.js` はCloudflareが検証した `ctx.access` のaudienceと本人メールを確認します。認証設定がない場合も拒否します。静的ファイルは固定5ファイルだけをビルドへ含め、認証より先に配信するAssets bindingは使いません。プレビューURLは無効です。

監視APIの接続先は `https://nike-restock-notifier.only-this-moment.workers.dev` です。こちらには閲覧ページを配信しません。

| 経路 | 利用条件 |
| --- | --- |
| `/`、`/index.html`、`/app.js` | 404。静的配信は削除済み。 |
| `/status.json`、`/admin/status` | `ADMIN_TOKEN` による管理認証。商品・履歴を含む詳細。 |
| `/admin/trends` | 管理認証。商品・期間で絞り込んだ長期集計。 |
| その他の `/admin/*` | 管理認証。状態取得・運転モード変更など。 |
| `/healthz` | 管理認証、または指定リポジトリの `health.yml` に限定したGitHub OIDC認証。商品・履歴を含まない正常性確認。 |

旧 `pages.yml` と移転案内の生成処理は削除しました。GitHub Pagesを再公開しないでください。`public/status.json` はGit管理対象外のローカル資料です。

閲覧Workerの `/status.json` と `/api/trends` はAccess認証を使います。同じパス名でも、監視Worker側の管理認証とは別です。閲覧Workerの応答は `private, no-store` とし、CORSで他サイトへ公開しません。

## 従来の端末専用ページ

`npm start` で `http://127.0.0.1:4173/` を起動します。サーバーはループバックだけで待ち受け、固定のCloudflare接続先から管理認証付きでステータスと長期集計を取得します。管理キーはブラウザーへ渡しません。成功した取得結果を60秒間共有し、取得できない場合に古い `public/status.json` を代用することはありません。Cloudflareの本人限定ページを使う場合、このローカルサーバーの起動は不要です。

## 長期トレンドの保存と集計

入荷を検出したイベントだけを独立したSQLテーブルへ保存します。同一商品・同一UTC時刻の検出を1件とし、サイズ数や全体・商品別履歴の重複で件数を増やしません。通常のstate保存と同じトランザクションで差分を追加し、変化のない保存ではarchiveへ再INSERTしません。

保持期間は最大730日、容量上限は100万件です。期限切れの削除は原則1日1回、集計時の期間判定は常に適用します。件数上限に達した場合は古いイベントから整理し、その事実をページに表示します。商品選択肢は最大1000件ですが、全商品集計には省略された商品も含みます。

集計はSQLで行い、日本時間の24時間帯を返します。商品別、直近7・30・90・365・730日のrolling期間、保存履歴全体を選べます。期間の開始境界と現在時刻を含み、将来の時刻は除きます。全イベントをブラウザーへ送ることはありません。

初回アクセスまたは最初の状態保存時に、残っている全体履歴（最大300件）と商品別履歴（各最大60件）から自動移行します。長期保存開始前の全履歴を復元できるわけではありません。ページは実保存開始日と、開始前の記録が一部であることを表示します。保存履歴の範囲は連続した監視期間を保証せず、実際の補充時刻や将来の入荷予測を示しません。

本番の長期保存開始は日本時間2026-09-05 02:32:38（UTC `2026-09-04T17:32:38.089Z`）です。反映時に入荷検出14件を引き継ぎました。この件数を以後の固定値として扱わないでください。

## 秘密値と設定

監視Workerの `ADMIN_TOKEN` と `DISCORD_WEBHOOK` はWorkers Secretです。ローカル操作ツールは `ADMIN_TOKEN` 環境変数、またはGit対象外の `.cloudflare-migration/admin-token` を読みます。

閲覧Workerには `ACCESS_AUD` と `VIEWER_EMAIL` をSecretとして設定します。前者は対象Accessアプリのaudience、後者は許可する本人メールです。Access側の許可ポリシーも本人メールだけに限定します。本人の実メールアドレスをリポジトリへ書かず、管理キーを閲覧Workerへ登録しないでください。秘密値や詳細ステータスをログ・公開ファイル・リポジトリへ記載しないでください。

対象サイズ、商品URL、確認間隔、`PRODUCT_CONFIG_JSON` などは移行時にDurable Objectへ保存した値を使い、Workersに同名の変数があればその値を優先します。商品別の `notify: false` は通知だけ停止し、`enabled: false` は商品確認を停止します。不正な設定JSONは監視・通知を停止する設定エラーです。

## 管理操作

```powershell
node scripts/cloudflare-admin.js health
node scripts/cloudflare-admin.js status .cloudflare-migration/status-private.json
node scripts/cloudflare-admin.js trends .cloudflare-migration/trends-private.json
node scripts/cloudflare-admin.js state .cloudflare-migration/state-backup.json
```

ステータスは閲覧用、`state` は通知済みキーなどを含む監視状態のバックアップです。監視状態の復元に閲覧用ステータスを使わないでください。

現在の `state` exportには独立した長期archiveは含まれません。`trends` の出力も集計結果であり、個別イベントのバックアップではありません。通常のstate importでは同じDO内の長期archiveを消しませんが、DOの作り直し・削除・別の識別名への移行は保全手段になりません。

運転モードを変更するときだけ、目的に合う操作を実行します。

```powershell
node scripts/cloudflare-admin.js mode paused
node scripts/cloudflare-admin.js mode shadow
node scripts/cloudflare-admin.js mode active
```

`paused` は監視全体を停止し、実行中の確認・通知が終了してから応答します。`shadow` は通知なしの検証、`active` は商品設定とWebhookに従う本番監視です。通常の再デプロイは保存済みモードを維持します。

## 保存・通知・確認間隔

DOクラス `NikeMonitor`、識別名 `nike-jp`、migration tag `v1` を維持し、同じDurable Objectの状態を使います。通常確認時の保存回数を減らし、起動時の全履歴再保存は廃止しました。通知候補の確定など、必要な保存は維持します。

通常は `INTERVAL_SECONDS`、発売前は `UPCOMING_INTERVAL_SECONDS` に基づくalarmで確認します。5分ごとのCronはalarm消失時の復旧用です。取得失敗が複数商品で続く場合はアクセス間隔を最大10分まで延ばします。カタログ再検査が3回連続で失敗した休止商品は、`PAUSED_RECHECK_HOURS`（既定24時間）での確認へ戻ります。

在庫が不明な観測では、通知済みキーと在庫履歴を保全します。通知先への送信とローカル状態の保存は単一の取引にできないため、送信成功直後の障害などでは重複する余地があります。デプロイ成功だけで監視成功と判断せず、認証付きhealthと商品取得時刻を確認してください。

履歴ブロックの読み込み途中で失敗した場合は、読み込めた部分だけを完全な履歴として扱いません。データ保存前の `sync()` 完了確認も維持します。

## 変更の検証と反映

```powershell
npm test
npm run cloudflare:build
npm run viewer:build
npm run cloudflare:test
```

今回の変更は263テストと実Workerdの認証・service binding・SQL集計検証を通過しています。実Workerd検証では、本番の秘密値を使わず外部通信を遮断します。

監視側の構成は `wrangler.jsonc`、閲覧側は `wrangler.viewer.jsonc` です。反映前に非公開の監視状態バックアップと長期集計を保存し、監視側の読み取り用エントリーポイントを先に反映してから閲覧側を反映します。Accessポリシー・audience・本人メールのSecret設定を維持してください。反映後は本人以外の拒否、本人の閲覧、運転モード・通知済みキー・短期履歴・長期集計の保持、自動確認の継続を確認します。

移行用 `cloudflare-transfer.yml` は無効化済みで、GitHubの一時公開鍵と転送した暗号文も削除済みです。通常運用には使いません。再移行時は既存の秘密鍵を維持し、workflowの有効化・公開鍵の再登録・最終内部状態の引き継ぎを行います。一時暗号文を削除するときは `node scripts/cloudflare-admin.js clear-credential "実行ID:試行番号"` に、対象転送の `migrationId` を指定します。

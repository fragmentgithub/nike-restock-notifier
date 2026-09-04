# Cloudflare 運用ガイド

**ページは非公開です。画面の過度な作り込みを避け、監視・通知ロジックの正確さと効率を優先します。**

監視は2026-09-05にCloudflareへ移行済みです。非公開化・ロジック改善の本番反映と旧GitHub Pagesの公開停止も完了し、監視はactive・正常です。認証付きの外側health workflowも再開し、正常判定を確認済みです。

## 非公開の構成

APIの接続先は `https://nike-restock-notifier.only-this-moment.workers.dev` です。公開ステータスページは配信しません。

| 経路 | 利用条件 |
| --- | --- |
| `/`、`/index.html`、`/app.js` | 404。静的配信は削除済み。 |
| `/status.json`、`/admin/status` | `ADMIN_TOKEN` による管理認証。商品・履歴を含む詳細。 |
| `/admin/*` | 管理認証。状態取得・運転モード変更など。 |
| `/healthz` | 管理認証、または指定リポジトリの `health.yml` に限定したGitHub OIDC認証。商品・履歴を含まない正常性確認。 |

旧 `pages.yml` と移転案内の生成処理は削除しました。GitHub Pagesを再公開しないでください。`public/status.json` はGit管理対象外のローカル資料です。

## この端末専用の閲覧ページ

`npm start` で `http://127.0.0.1:4173/` を起動します。サーバーはループバックだけで待ち受け、固定のCloudflare接続先から管理認証付きで閲覧用ステータスを取得します。管理キーはブラウザーへ渡しません。成功した取得結果を60秒間共有し、取得できない場合に古い `public/status.json` を代用することはありません。

リストック時間帯は、入荷を検出した時刻を日本時間の24時間帯に集計します。商品・直近7日・30日・保存履歴全体で絞り込めます。同一商品・同一時刻の検出はサイズ数にかかわらず1件です。全体最大300件と商品別最大60件の在庫変化履歴を重複排除して使います。表示する保存履歴の範囲は連続した監視期間を保証せず、将来の入荷予測ではありません。

## 秘密値と設定

`ADMIN_TOKEN` と `DISCORD_WEBHOOK` はWorkers Secretです。ローカル操作ツールは `ADMIN_TOKEN` 環境変数、またはGit対象外の `.cloudflare-migration/admin-token` を読みます。秘密値や詳細ステータスをログ・公開ファイル・リポジトリへ記載しないでください。

対象サイズ、商品URL、確認間隔、`PRODUCT_CONFIG_JSON` などは移行時にDurable Objectへ保存した値を使い、Workersに同名の変数があればその値を優先します。商品別の `notify: false` は通知だけ停止し、`enabled: false` は商品確認を停止します。不正な設定JSONは監視・通知を停止する設定エラーです。

## 管理操作

```powershell
node scripts/cloudflare-admin.js health
node scripts/cloudflare-admin.js status .cloudflare-migration/status-private.json
node scripts/cloudflare-admin.js state .cloudflare-migration/state-backup.json
```

ステータスは閲覧用、`state` は通知済みキーなどを含む内部状態のバックアップです。監視状態の復元に閲覧用ステータスを使わないでください。

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

履歴ブロックの読み込み途中で失敗した場合は、読み込めた部分だけを完全な履歴として扱いません。データ保存前の `sync()` 完了確認も維持します。デプロイ前は `npm test`・`npm run cloudflare:build`・`npm run cloudflare:test` で検証し、管理操作の `state` で非公開バックアップを保存してください。反映後は運転モード・通知済みキー・履歴の保持と、自動確認の継続を確認します。

移行用 `cloudflare-transfer.yml` は無効化済みで、GitHubの一時公開鍵と転送した暗号文も削除済みです。通常運用には使いません。再移行時は既存の秘密鍵を維持し、workflowの有効化・公開鍵の再登録・最終内部状態の引き継ぎを行います。一時暗号文を削除するときは `node scripts/cloudflare-admin.js clear-credential "実行ID:試行番号"` に、対象転送の `migrationId` を指定します。

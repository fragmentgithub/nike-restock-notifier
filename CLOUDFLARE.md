# Cloudflare 運用ガイド

移行先: https://nike-restock-notifier.only-this-moment.workers.dev/

2026-09-05 01:32 JSTに本番監視をCloudflareへ切り替えました。管理キー・既存Discord Webhookの登録と、GitHubの最終状態の引き継ぎが完了し、現在は通知が有効な `active` モードです。実際の定期起動と商品取得、監視の正常状態を確認しました。

GitHub側は `MONITOR_BACKEND=cloudflare` に設定済みで、旧監視は停止しています。旧GitHub Pages URLから新しいページへの自動遷移と、Cloudflareを外側から確認するhealth workflowの正常動作も確認済みです。`pages.yml` は移転案内の公開後に無効化し、`health.yml` は有効にしています。

移行用workflowは無効化し、GitHubの一時公開鍵、Cloudflareとローカルの一時暗号文は削除済みです。

## 構成

- Workers が `public/` の画面と `/status.json` を配信します。
- Durable Object が監視状態を保存し、次回の確認時刻に合わせて監視処理を起動します。
- Nike の在庫判定、商品探索、商品別設定、通知済み判定、在庫履歴は既存の処理を利用します。
- GitHub はソースコードの管理に使います。Cloudflare 側での監視に、25分の Actions 実行の引き継ぎは不要です。

## 画面の見方

公開画面は閲覧専用です。閲覧していない間も監視は動作します。画面は1分ごとに `/status.json` を読み直すため、確認結果を見るための再デプロイは不要です。

| 表示 | 意味 |
| --- | --- |
| 自動監視中 | 本番の監視。Webhook と商品別の通知設定に従って通知します。 |
| 検証中・通知OFF | 在庫情報の取得を検証するモード。Discord 通知は行いません。 |
| 一時停止中 | 監視全体を停止している状態。過去の確認結果は引き続き表示します。 |
| 更新遅延 | 予定した確認時刻を過ぎてもステータスが更新されていない可能性があります。 |
| 取得失敗 | ブラウザーが最新のステータスを取得できませんでした。取得済みのデータがあれば、その内容を残します。 |

商品カードの「自動休止」は監視全体の一時停止と異なります。長期間確認できない商品などを個別に休止し、設定した間隔で再確認します。

「最終確認」は商品の最終取得時刻です。成功率・平均応答時間は直近24時間の取得履歴から計算します。ステータスの更新だけをもって Nike への取得成功とは扱いません。

## 確認間隔

通常の確認間隔は `INTERVAL_SECONDS`、発売前の優先確認は `UPCOMING_INTERVAL_SECONDS` を使います。設定値は確認の目安であり、取得処理にかかる時間や失敗時の待機により実際の確認時刻は変わります。

複数商品の取得失敗が続く場合は、既存の待機調整によりアクセス間隔を最大10分まで延ばします。画面の更新遅延判定は最低10分を許容し、次回確認の予定時刻が後になる場合は、その時刻からさらに2分を待ちます。

## 状態と設定

通知済みの在庫、追跡商品、休止状態、在庫変化履歴、品質集計用の記録は Durable Object に保存します。通知済み状態は再デプロイ後も引き継ぐ前提のため、同じ監視用の Durable Object を利用してください。

商品URL、対象サイズ、確認間隔、商品別設定などは、移行時にDurable Objectへ保存した設定を使用します。Workersに同名の変数を設定すると、その値を優先します。`DISCORD_WEBHOOK` と `ADMIN_TOKEN` はWorkers Secretとして保存します。公開ステータスに出すのは通知設定の有無だけです。Webhook や管理用の認証情報を `public/`、ソースコード、公開 JSON に記載しないでください。

既存の `PRODUCT_CONFIG_JSON` の形式を引き続き使います。`notify: false` は商品確認を続けて通知だけ止め、`enabled: false` はその商品の確認を停止します。不正な JSON は設定エラーとして扱います。

## 移行と切り戻し

以下は移行を再実施する場合の手順です。現在は `cloudflare-transfer.yml` が無効で、GitHubの移行用公開鍵も削除されています。再実施にはworkflowの有効化と公開鍵の再登録が必要です。既存の管理キー・暗号化用秘密鍵は引き続き使います。

1. `npm run cloudflare:build`、`npm test` を実行し、`npm run cloudflare:deploy` でCloudflare版を公開・更新します。新規作成時は一時停止ですが、更新時は既存の運転モードを維持します。
2. 移行先へ専用 `ADMIN_TOKEN` を登録し、`node scripts/cloudflare-admin.js probe mind`、`probe fragment`、`probe catalog` で商品・発売ページ・探索を検証します。固定の商品URLが404の場合は、探索で見つかった現行商品でも確認します。
3. 暗号化用鍵が未作成なら `node scripts/prepare-cloudflare-key.js` で作ります。公開鍵 `.cloudflare-migration/export-public.pem` だけをGitHub variable `CLOUDFLARE_MIGRATION_PUBLIC_KEY` に登録します。秘密鍵はこの端末に保管し、作成済みの鍵は引き続き使います。
4. Cloudflareを `mode paused` にし、`main` の手動workflow `cloudflare-transfer.yml` を実行します。検証時は `cache_key` を空にすると最新のActions cacheを復元します。監視状態・通常設定・暗号化したWebhookを、GitHubから承認済みのCloudflareへ直接送信します。
5. ローカルに `.cloudflare-migration/credential/` を作成し、`node scripts/cloudflare-admin.js credential .cloudflare-migration/credential/webhook.enc` で暗号文を取得します。`node scripts/import-cloudflare-webhook.js .cloudflare-migration/credential` で復号してWorkers Secretに登録し、成功後に `node scripts/cloudflare-admin.js clear-credential "実行ID:試行番号"` でCloudflareに一時保存した暗号文を削除します。引数には転送結果の `migrationId` を指定します。Webhookの平文はファイル・コマンド引数・ログへ出しません。
6. `node scripts/cloudflare-admin.js mode shadow` で、通知なしの監視を検証します。
7. GitHubの `health.yml` と `pages.yml` を一時的に無効化します。監視の未開始の待機実行を取り消し、進行中の実行は最後の状態保存まで完了させます。保存の成功、対応するキャッシュの存在、監視実行が残っていないことを確認します。
8. Cloudflareを `mode paused` に戻します。`cloudflare-transfer.yml` の `cache_key` に、最後の監視実行が保存した正確なキー `nike-monitor-state-実行ID` を指定して再送信します。復元ログでそのキーとの一致を確認してください。**最後の通知済み状態**が反映されたことを確認し、再送されたWebhookの暗号文は `node scripts/cloudflare-admin.js clear-credential "実行ID:試行番号"` で削除します。引数は今回の転送結果の `migrationId` です。公開 `status.json` だけでは通知済み状態は復元できません。
9. `mode active` でCloudflare通知を有効化し、更新・取得結果を確認します。GitHub variable `MONITOR_BACKEND=cloudflare` を設定し、`pages.yml` を再有効化して1回実行し、旧URLを移転案内にします。旧監視workflowはその後無効化できます。
10. `health.yml` を再有効化します。これはCloudflareの更新停止を外側から検知する役割だけになり、旧GitHub監視を再起動しません。ソースコードとCIもGitHubに残します。

直接転送の送信先は `/migration/transfer` です。CloudflareはGitHub OIDCで発行元、送信先、リポジトリと所有者のID、`main`、指定の手動workflowを検証します。この転送のためにCloudflareの管理キーをGitHubへ登録する必要はありません。転送データはGitHub artifactには保存しません。

切り戻す場合は、Cloudflare を一時停止してから GitHub の監視を再開します。古い状態のまま再開すると、移行後に通知済みの在庫が再通知される可能性があるため、最新の通知済み状態を引き継いでください。

## 管理操作

公開画面に設定変更APIはありません。管理APIはBearer認証が必須で、未登録のキーでは操作できません。ローカル操作ツールは `ADMIN_TOKEN` 環境変数、またはgit対象外の `.cloudflare-migration/admin-token` を読み込みます。

```powershell
node scripts/cloudflare-admin.js health
node scripts/cloudflare-admin.js mode paused
node scripts/cloudflare-admin.js mode shadow
node scripts/cloudflare-admin.js mode active
node scripts/cloudflare-admin.js state .cloudflare-migration/state-backup.json
```

`paused` の応答は実行中の確認・通知が終了してから返ります。状態のimportと直接転送はpausedでのみ受け付け、同じmigrationIdの再送は重ねて適用しません。通知は外部サービスへの送信と保存を単一の取引にできないため、送信成功直後の障害などで重複する余地はあります。

5分ごとのCronは次回alarmが失われた場合の復旧用です。在庫確認の通常間隔はalarmが管理します。無料枠には実行・読み書きの上限があるため、移行後に実使用量を確認します。

公開URLと移行の実施結果は [README.md](README.md) と [HANDOFF.md](HANDOFF.md) に記録します。

# Handoff for Claude

## 現在の方針（2026-09-05、過去の方針より優先）

**ページは非公開。ページは重要ではなく、過度な作り込みは不要。監視・通知ロジックの正確さと効率を優先する。** 公開画面・GitHub Pages・移転案内を復活させない。

## 最新の品質改善とデプロイ（2026-09-05）

コード `a376b3f` をCloudflareへ反映済み。現在のWorkers versionは `f8b9a6c9-9cde-4826-8519-7364e55da008`。SNKRSの商品全体の売切れより残存SKU在庫が優先される誤判定、履歴ブロックの解析失敗後に途中までの履歴を再利用する不具合、古い・不正・在庫不明のステータス表示を修正した。保存形式とDO識別名は変更していない。

232テスト、ビルド、実Workerdでの認証とSQLite1万件保持、ブラウザー表示確認に成功。CI `33899418301` も成功。実Workerd検証は `npm run cloudflare:test` で再実行でき、CIに追加済み。本番キーを使わず、外部通信はモックで遮断する。

反映前後でactiveモード、8商品の通知済みキー・商品別履歴、全体履歴28件、設定の保持を確認。未認証の静的ページ404、status/health/adminstatusの401を再確認し、デプロイ後の現行4商品の自動取得成功とエラー0件も確認済み。認証付きhealth run `33899583152` は成功。非公開バックアップは `.cloudflare-migration/quality-deploy-before-state.json` に保存した。

## 非公開閲覧ページ

追加依頼により、`npm start` で開くこの端末専用ページ（`http://127.0.0.1:4173/`）にリストック時間帯トレンドを用意した。Cloudflareの閲覧用ステータスをローカルサーバーが管理認証付きで取得し、管理キーはブラウザーへ渡さない。公開配信は復活させていない。`public/restock-trends.js` が全体・商品別履歴を重複排除して日本時間で集計し、`public/trend-view.js` が商品・7日・30日・保存履歴全体の切り替えを表示する。入荷検出の記録であり、補充時刻の断定や予測ではない。

追加後は223テスト成功。実ブラウザーで全履歴14件・4時台6件、商品変更、期間外の0件表示を確認した。管理キーがローカルHTTP応答に含まれないことも検証済み。閲覧機能のみの変更なので、Cloudflareの再デプロイは不要。

初回の本番移行では、Cloudflare Workers + SQLite Durable Objectへの移行、非公開化とロジック最適化を反映した（当時のWorkers version `b17f5fc9-18cc-40f9-9bc8-94232735457e`）。旧GitHub Pages削除と旧URLの404、Cloudflareの静的ページ404・未認証のstatus/health/adminstatusへの401を確認した。認証付きhealth run `33897075825` とCI run `33897048497`、当時の206テストは成功。最新の稼働版・検証結果は上記の品質改善欄を参照。

## 構成とアクセス

- API接続先: `https://nike-restock-notifier.only-this-moment.workers.dev`。公開ページのURLとして案内しない。
- 静的配信を削除し、`/`、`/index.html`、`/app.js` は404。`/status.json` と `/admin/status` は管理認証必須。
- `/healthz` は `ADMIN_TOKEN` または `health.yml` に限定したGitHub OIDC認証が必要で、商品・履歴は返さない。外側healthに管理キーを登録しない。
- `pages.yml` と旧移転案内の生成処理は削除済み。`public/status.json` はGit管理から除外し、ローカルに残す。
- `wrangler.jsonc` がCloudflareの構成。DOクラス `NikeMonitor`、識別名 `nike-jp`、migration tag `v1` を維持する。新規初期状態はpaused、再デプロイは保存済みの運転モードを維持する。
- `src/monitor-engine.js` が商品確認・探索・通知判断を担い、通常2分・発売前30秒を目安にalarmで動く。GitHubにはソースコード、CI、認証付きhealth workflowを残す。
- `ADMIN_TOKEN` と `DISCORD_WEBHOOK` はWorkers Secretとして登録済み。ユーザーはこのWorkerへの両Secret登録を明示承認済み。

## 今回のロジック改善

- 通常の商品確認で監視エンジンが保存する回数を3回から1回へ削減。Durable Object起動時の全履歴再保存も廃止。
- SKU在庫の欠落・未知状態を売切れと混同せず、通知済みキーと在庫履歴を保全。明示的な在庫なしを残存する購入可能表示より優先する。
- HTMLの全サイズ無効、`aria-disabled="false"`、一重引用符のサイズ欄の誤判定を修正。
- カタログで再検出した休止商品の再検査が3回連続で失敗すると、日次の再確認へ戻す。
- PDPで解析したJSONを関連商品探索へ再利用し、二重解析を削減。探索HTTPエラーの未使用本文を破棄。

## 操作と秘密情報

```powershell
node scripts/cloudflare-admin.js health
node scripts/cloudflare-admin.js status .cloudflare-migration/status-private.json
node scripts/cloudflare-admin.js state .cloudflare-migration/state-backup.json
```

操作ツールは `ADMIN_TOKEN` 環境変数または `.cloudflare-migration/admin-token` を読む。`.cloudflare-migration/` はGit対象外の作業領域。管理キー・秘密鍵・内部状態を公開・ログ出力しない。既存キーを作り直さない。

`mode paused` は確認・通知の終了を待って停止し、`mode shadow` は通知なし、`mode active` は本番監視。状態importはpaused限定。詳細は [CLOUDFLARE.md](CLOUDFLARE.md)。

## Cloudflare移行の記録（完了済み）

2026-09-04 16:32:30 UTC（2026-09-05 01:32 JST）にactive化し、alarm起動、商品取得、health正常、Webhook設定済みを確認した。

- 最終旧run `33893233043` は監視・状態保存・当時のPagesジョブが成功。`nike-monitor-state-33893233043` を2026-09-04 16:29:55 UTCに保存。自己連鎖だけが意図したworkflow無効化による422で終了した。
- 最終直接転送run `33895582921` は最終キャッシュに完全一致し、8商品、品質サンプル756件、在庫履歴28件、イベント80件を取り込んだ。通知済みキーは初回転送と一致。件数は転送時点の記録。
- 固定初期商品 `HQ4307-005` とFragmentの旧ページは両環境で404だったが、現行4商品の取得は成功。shadowでは3商品の自動休止解除と、通知済み状態・履歴の保持を確認した。
- 移行時の旧Pages転送run `33895727520` と外側health run `33895756834` は成功した。ただし公開ページ運用は今回の非公開方針で廃止済み。過去のPages再公開手順は使用しない。
- `cloudflare-transfer.yml` はGitHub OIDCで指定リポジトリ・所有者ID・main・手動workflow・audienceを確認してCloudflareへ直接送る方式。GitHub artifactへの暗号文保存は使用しない。
- 移行用workflowは無効化、一時公開鍵・Cloudflareとローカルの一時暗号文は削除済み。再移行にはworkflow有効化と公開鍵再登録が必要。内部状態を引き継ぎ、閲覧用ステータスから通知キーを再構成しない。
- 再移行時の一時暗号文削除は `node scripts/cloudflare-admin.js clear-credential "実行ID:試行番号"`。対象転送の `migrationId` を必ず指定する。

# Nike Restock Notifier

**ページは非公開とし、画面の作り込みより監視・通知ロジックを優先します。** Nike Mind 001のメンズ商品と、商品名にFragment／フラグメントを含むNike商品を追跡し、対象サイズの入荷をDiscordへ通知します。

2026-09-05に本番監視をCloudflareへ移行済みです。非公開化とロジック改善も本番へ反映し、旧GitHub Pagesの公開停止、認証なしでのステータス取得拒否、監視・商品取得の正常動作を確認しました。認証付きの外側health workflowも再開し、正常判定を確認済みです。

## 構成

- WorkersとSQLite Durable Objectが監視状態・通知済み情報・履歴を保存します。
- 通常は商品ごとに約2分、発売前は約30秒を目安に確認します。
- 新商品を探索し、確認不能な商品を自動休止・再確認します。
- GitHubにはソースコード・CI・認証付きのhealth確認を残します。

静的ページの配信は削除しました。`/`、`/index.html`、`/app.js` は404を返し、`/status.json` と `/admin/status` は管理認証が必要です。`/healthz` は管理認証または指定のGitHub health workflowのOIDC認証を要求し、商品情報や履歴を返しません。

## 状態の確認

管理キーを利用して、ステータスを非公開のローカルファイルへ保存します。

```powershell
node scripts/cloudflare-admin.js health
node scripts/cloudflare-admin.js status .cloudflare-migration/status-private.json
```

`public/status.json` はGit管理から除外し、ローカルにのみ残します。旧 `pages.yml` と移転案内の生成処理は削除済みです。

## 今回のロジック改善

- 通常の商品確認で行う監視エンジンの保存を3回から1回に減らし、Durable Object起動時の全履歴再保存も廃止しました。
- SKU情報の欠落・未知状態では通知済み情報を保持し、誤った売切れ・再入荷判定を防ぎます。
- カタログで再検出した休止商品が3回続けて確認できない場合は、通常の日次再確認へ戻します。
- 商品ページの解析済みJSONを再利用し、同じ内容の二重解析を減らしました。

運用・設定・保存上の制約は [CLOUDFLARE.md](CLOUDFLARE.md)、開発の引き継ぎは [HANDOFF.md](HANDOFF.md) を参照してください。

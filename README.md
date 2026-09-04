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

この端末専用の閲覧ページを起動できます。

```powershell
npm start
```

`http://127.0.0.1:4173/` を開くと、Cloudflareの最新ステータスとリストック時間帯のグラフを表示します。管理キーはローカルサーバーだけが使用し、ブラウザーには渡しません。ページを閉じてもCloudflareの監視は継続します。

グラフは日本時間の入荷検出件数を、商品別・直近7日・30日・保存履歴全体で絞り込めます。複数サイズの同時入荷は商品ごとに1件とし、全体履歴と商品履歴の重複は除外します。保存済み履歴のみを使うため、実際の補充時刻や将来の入荷確率を示すものではありません。

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
- SNKRSの商品全体の売切れ表示を、残っているサイズ在庫情報より優先し、誤通知を防ぎます。
- 履歴の一部が読み込めないとき、不完全な履歴を保存し直さないようにしました。
- 古いステータスはトレンドにも遅延を表示し、取得失敗や在庫不明を現在の在庫ありと混同しません。

運用・設定・保存上の制約は [CLOUDFLARE.md](CLOUDFLARE.md)、開発の引き継ぎは [HANDOFF.md](HANDOFF.md) を参照してください。

## 変更時の検証

```powershell
npm ci
npm test
npm run cloudflare:build
npm run cloudflare:test
```

CIでも同じ確認を行います。`cloudflare:test` は隔離したローカルのCloudflare実行環境で、非公開ルート、SQLiteへの1万件の観測履歴保存、通知済み情報の保持を検証します。本番キーを使わず、NikeやDiscordへの通信は行いません。

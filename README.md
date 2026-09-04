# Nike Restock Notifier

**本人限定のページで監視状況とリストック時間帯を確認できます。** Nike Mind 001のメンズ商品と、商品名にFragment／フラグメントを含むNike商品を追跡し、対象サイズの入荷をDiscordへ通知します。監視・通知はCloudflareで動き、PCの電源を切っても継続します。

2026-09-05に本番監視をCloudflareへ移行しました。本人限定ページと長期保存も本番へ反映し、監視の継続・既存履歴の保持・入荷14件の引き継ぎを確認しています。本人の実ログイン後の画面確認は未実施です。旧GitHub Pagesの公開は停止し、GitHubにはコード・CI・認証付きの外側health確認を残しています。詳細は [HANDOFF.md](HANDOFF.md) を参照してください。

## 構成

- WorkersとSQLite Durable Objectが監視状態・通知済み情報・履歴を保存します。
- 閲覧用Workerは本人限定のCloudflare Access認証で保護し、監視Workerから読み取り専用の接続でデータを取得します。
- 入荷検出の長期記録を短期履歴とは別に保存し、日本時間で集計します。
- 通常は商品ごとに約2分、発売前は約30秒を目安に確認します。
- 新商品を探索し、確認不能な商品を自動休止・再確認します。
- GitHubにはソースコード・CI・認証付きのhealth確認を残します。

監視API側の静的ページは配信しません。`/status.json` と `/admin/status` は管理認証が必要です。`/healthz` は管理認証または指定のGitHub health workflowのOIDC認証を要求し、商品情報や履歴を返しません。GitHub Pagesを含む一般公開ページは復活させません。

## 状態の確認

[本人限定の閲覧ページ](https://nike-restock-viewer.only-this-moment.workers.dev) を開き、登録した本人のメールに届くワンタイムコードでログインします。PCがオフでも、スマートフォンなどから確認できます。メールアドレスや管理キーをリポジトリへ記載する必要はありません。

グラフは入荷を検出した日本時間を24時間帯に集計し、商品別・直近7日・30日・90日・365日・730日・保存履歴全体で絞り込めます。同じ商品・同じ時刻の検出は、サイズ数にかかわらず1件です。記録は最大730日・100万件保持します。

長期保存の開始時は、残っている全体履歴と商品別履歴を取り込みます。過去の全履歴が揃うわけではありません。保存開始日とこの制約をページに表示します。実際の補充時刻や将来の入荷確率を示すものではありません。

従来の端末専用ページも利用できます。

```powershell
npm start
```

`http://127.0.0.1:4173/` はローカルサーバーの起動中だけ利用できます。管理キーはローカルサーバーだけが使用し、ブラウザーには渡しません。Cloudflare上の本人限定ページは、このサーバーに依存しません。

管理キーを利用して、ステータスを非公開のローカルファイルへ保存します。

```powershell
node scripts/cloudflare-admin.js health
node scripts/cloudflare-admin.js status .cloudflare-migration/status-private.json
node scripts/cloudflare-admin.js trends .cloudflare-migration/trends-private.json
node scripts/cloudflare-admin.js state .cloudflare-migration/state-backup.json
```

`state` は監視状態のバックアップで、独立した長期アーカイブは含みません。`trends` は集計結果であり、個別イベントのバックアップではありません。通常の状態インポートは、同じDurable Objectの長期アーカイブを消しません。`public/status.json` はGit管理から除外し、旧 `pages.yml` と移転案内の生成処理は削除済みです。

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
npm run viewer:build
npm run cloudflare:test
```

CIでも同じ確認を行います。`cloudflare:test` は隔離したCloudflare実行環境で、Access認証、読み取り専用の接続、長期SQL集計、SQLiteへの1万件の観測保存、通知済み情報の保持を検証します。本番キーを使わず、NikeやDiscordへの通信は行いません。今回の変更は263テストと実Workerdでの認証・接続検証を通過しています。

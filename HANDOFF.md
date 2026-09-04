# Handoff for Claude

## 現在の方針（2026-09-05、過去の方針より優先）

**ページは本人限定。Cloudflare上でPCがオフでも閲覧でき、長期リストックトレンドを確認する。** 過度な作り込みを避け、監視・通知ロジックの正確さと効率を優先する。一般公開画面・GitHub Pages・移転案内を復活させない。

## 最新変更：本人限定ページ、長期分析、別DOバックアップ、確認頻度の安全策

閲覧URLは `https://nike-restock-viewer.only-this-moment.workers.dev`。Cloudflare Accessの本人メール限定ポリシーとメールOTPで認証する。本人の実メールアドレスをリポジトリに記載しない。PCを停止してもCloudflareの監視・保存・閲覧は継続する。

閲覧Worker `nike-restock-viewer` は `wrangler.viewer.jsonc` / `src/viewer-worker.js`。`ACCESS_AUD` と `VIEWER_EMAIL` を閲覧WorkerのSecretに設定し、runtimeが検証した `ctx.access` のaudience・メールを一致確認する。設定なし・未認証・本人以外は全ページ/静的ファイル/APIで拒否する。`ADMIN_TOKEN` と `DISCORD_WEBHOOK` は閲覧Workerへ渡さない。

監視Workerの名前付きservice entrypoint `MonitorViewer` は `getStatus` と `getTrends` だけを公開する。閲覧Workerのservice bindingはこのentrypointを指定し、モード変更・import・内部state exportを呼べない。静的ファイルは `scripts/build-viewer-assets.js` で固定5ファイルだけをバンドルする。Static Assets routerは `ctx.access` を渡さないため使わず、プレビューURLも無効化する。`public/status.json` をビルドへ含めない。

長期保存は `src/worker-trend-storage.js` と `src/worker-storage.js`。入荷検出イベントを `monitor_restock_events` に同一商品+UTC時刻で重複排除して保存し、通常state/status保存と同じtransactionで差分追加する。短期ring・通知済みキーは維持する。checkpointはchunk対応の `trend-meta` 文書で、cold/warmとも変化なし保存時にarchive全体を読み込んだり再INSERTしたりしない。

保持は最大730日・100万件。期限削除は原則1日1回、集計の期間判定は毎回適用する。上限到達時は最古から整理し、注記する。`getTrends({styleColor:'all'|商品コード, days:'all'|7|30|90|365|730})` はSQLでJST24時間帯を集計する。商品候補は最大1000件だが全商品集計には省略商品も含む。

最初の閲覧またはstate保存で、既存の全体最大300件・商品別最大60件の短期履歴を自動backfillする。最初がstate置換でも置換前の履歴を先に取り込む。保存開始前の全履歴が揃うわけではないため、返却の `period.archiveStartedAt` / `notes.retentionLabel` に実保存開始日と部分記録の注記を含める。保存期間や検出時刻は連続監視や実際の補充時刻を保証しない。

分析は `src/worker-trend-analytics.js`。分析導入後の信頼できる観測から `monitor_product_coverage` と `monitor_sellout_episodes` を作る。旧入荷イベントの監視時間や売り切れ区間はbackfillしない。import、paused、長い空白、取得不能はboundaryとして区間を切る。

`getTrends` の `analytics` は次を返す。

- `weekdayHours`: 曜日×24時間の入荷件数、観測商品時間、100商品時間あたり頻度。分母なしは `null`、観測済み0件は頻度0として区別する。
- `sellout`: 完了区間の中央値・四分位・観測上下限と、途中で切れた打ち切り件数。打ち切りは所要時間から除外する。
- `comparison`: 最近30日と直前30日の補正頻度。各期間3件・24商品時間を満たさなければ `insufficient` とし、増減を返さない。
- `coverage`: 分析記録開始、実観測商品時間、信頼できる区間数、除外したgap数。旧履歴を都合よく補完しない。

商品filterは全分析、days filterは `weekdayHours` / `sellout` / `coverage` に適用する。`comparison` だけはdaysに依存せず、選択商品の最近30日と直前30日を比較する。

バックアップは `src/worker-backup.js`。監視DOとは別のSQLite DO `NikeBackup` へ日次世代を作り、最新30世代だけを残す。許可対象は `state` / `status` / `control` / `trend-meta` 文書、sample block、長期イベント、coverage、sellout episode、分析cursor/meta/gap。migration credential、`ADMIN_TOKEN`、`DISCORD_WEBHOOK`、Access資格情報は対象外。

復元は `NikeMonitor` がpausedの場合だけ許可する。manifest・schema・chunk件数・連鎖hashをすべて検証し、一時tableへ展開してからpausedを再確認し、単一transactionで置換する。検証失敗時は現行DBを変更せず、成功後もstatus/controlをpaused、`nextCheckAt` をnullに固定する。現在の資格情報は置換しない。復元後は状態、通知済みキー、短期履歴、長期集計を確認してからshadow/activeへ進める。

現在の手動 `state` exportは監視状態のみで、独立した長期archiveを含まない。`trends` 出力は集計結果であり個別イベントのバックアップではない。完全な保全は `NikeBackup` の日次世代を使う。通常のstate importでは既存archiveを消さない。DOクラス `NikeMonitor`、識別名 `nike-jp`、migration tag `v1` を維持し、追加migration `v2` は `NikeBackup` の作成だけに使う。バックアップDOの識別名 `nike-jp-backups` も維持し、どちらのDOも作り直さない。

確認頻度は通常の商品ごとに120秒、発売前対象が1〜2件なら30秒。発売前対象が同時に3件以上なら、その対象だけ60秒以上へ自動緩和する。発売日時が不明な `coming-soon` は初回観測時刻をstateへ保存し、4時間後に通常間隔へ戻す。旧stateは `lastSeenAt` を起点に移行し、後から発売日時を取得した場合は既存の発売180分前〜60分後の判定へ切り替える。

289テスト成功。実Miniflare/WorkerdでAccessの本人/他人/未設定/偽装拒否、読み取り専用service binding、全6期間のSQL集計、getTrends前後の1万件サンプル・通知キー・短期履歴の一致、別DOへの検証付きバックアップと復元を確認した。本番秘密値は使わず、外部通信は遮断している。100万件の保持上限とtransaction rollbackもNode SQLiteで検証済み。

### 最新デプロイの反映後確認

| 項目 | 結果 |
| --- | --- |
| 監視Worker version | `e7decc7f-45c2-4869-932e-2526d890f196` |
| 閲覧Worker version | `503286ff-70dd-42ff-b17d-8e59296ea3bd` |
| 本人限定Access設定・本人以外の拒否 | 本人メールだけの許可ポリシーを維持。未認証の `/`・`/trend-view.js`・`/api/trends`・`/admin/state` はすべてAccessログインへ302。監視Workerの `/` は404、status/healthは401。 |
| 本人ログイン後のページ・トレンド | 本人の実ログインは未確認。ローカル画面で全履歴14件、分析カード、曜日×時間帯168セル、データ不足表示を確認。 |
| active/通知キー/履歴/長期集計の保持・自動監視 | healthy/activeを維持。8商品の通知キーと商品別履歴、全体履歴38件が反映前後で完全一致。長期archiveは入荷19件。現行4商品の反映後の自動取得成功、監視時間9.077商品時間・4区間を確認。成功率99.4%、平均376ms、連続失敗0。 |
| 別DOバックアップ | 検証済み世代を3件作成。最新は8テーブル・46行で、分析coverageを含む。日次処理は同一UTC日には重複作成しない。 |

長期保存開始は `2026-09-04T17:32:38.089Z`（日本時間2026-09-05 02:32:38.089）、補正分析開始は `2026-09-04T18:23:42.890Z`。旧14件は補正分析へ混ぜず、以後の実観測だけを使う。監視Workerの未認証 `/status.json`・`/healthz` は401、`/` は404、閲覧Workerの未認証 `/`・`/api/trends` はAccessログインへ302を確認した。289テストと実Workerd検証も再実行して成功している。本人の認証済みブラウザー表示を確認するまでは、その項目だけ完了扱いにしない。

## 前回の品質改善とデプロイ（2026-09-05、履歴）

前回はコード `a376b3f` をCloudflareへ反映し、Workers versionは `f8b9a6c9-9cde-4826-8519-7364e55da008` だった。SNKRSの商品全体の売切れより残存SKU在庫が優先される誤判定、履歴ブロックの解析失敗後に途中までの履歴を再利用する不具合、古い・不正・在庫不明のステータス表示を修正した。当時は保存形式とDO識別名を変更していない。

232テスト、ビルド、実Workerdでの認証とSQLite1万件保持、ブラウザー表示確認に成功。CI `33899418301` も成功。実Workerd検証は `npm run cloudflare:test` で再実行でき、CIに追加済み。本番キーを使わず、外部通信はモックで遮断する。

反映前後でactiveモード、8商品の通知済みキー・商品別履歴、全体履歴28件、設定の保持を確認。未認証の静的ページ404、status/health/adminstatusの401を再確認し、デプロイ後の現行4商品の自動取得成功とエラー0件も確認済み。認証付きhealth run `33899583152` は成功。非公開バックアップは `.cloudflare-migration/quality-deploy-before-state.json` に保存した。

## 従来のローカル閲覧ページとの互換

`npm start` で開く端末専用ページ（`http://127.0.0.1:4173/`）も維持する。`scripts/serve-pages.js` は固定Cloudflare APIからステータスと長期集計を管理認証付きで取得し、キーはブラウザーへ渡さない。ループバック限定で、成功結果の60秒キャッシュ・同時取得共有・timeout/サイズ制限・古いローカルsnapshotへの代用禁止を維持する。PCを停止するとこのURLは使えないが、Cloudflare側の本人限定ページは使える。

`public/trend-view.js` は `/api/trends` のサーバー集計を使う。商品・全6期間の切り替え、条件と応答の照合、遅い旧応答の無視、同条件の前回集計に限った失敗時表示を実装する。`public/restock-trends.js` の旧短期集計関数は互換用に残るが、長期トレンドの現行データソースではない。以前のローカル表示確認では全履歴14件・4時台6件だったが、固定の現在値として扱わない。

初回の本番移行では、Cloudflare Workers + SQLite Durable Objectへの移行、非公開化とロジック最適化を反映した（当時のWorkers version `b17f5fc9-18cc-40f9-9bc8-94232735457e`）。旧GitHub Pages削除と旧URLの404、Cloudflareの静的ページ404・未認証のstatus/health/adminstatusへの401を確認した。認証付きhealth run `33897075825` とCI run `33897048497`、当時の206テストは成功。最新の稼働版・検証結果は冒頭の反映後確認欄を参照。

## 構成とアクセス

- API接続先: `https://nike-restock-notifier.only-this-moment.workers.dev`。公開ページのURLとして案内しない。
- 本人限定閲覧先: `https://nike-restock-viewer.only-this-moment.workers.dev`。Accessで本人メールOTP認証する。
- 静的配信を削除し、`/`、`/index.html`、`/app.js` は404。`/status.json` と `/admin/status` は管理認証必須。
- `/healthz` は `ADMIN_TOKEN` または `health.yml` に限定したGitHub OIDC認証が必要で、商品・履歴は返さない。外側healthに管理キーを登録しない。
- `pages.yml` と旧移転案内の生成処理は削除済み。`public/status.json` はGit管理から除外し、ローカルに残す。
- `wrangler.jsonc` がCloudflareの構成。DOクラス `NikeMonitor`、識別名 `nike-jp`、migration tag `v1` を維持する。新規初期状態はpaused、再デプロイは保存済みの運転モードを維持する。
- `src/monitor-engine.js` が商品確認・探索・通知判断を担い、通常2分・発売前30秒を目安にalarmで動く。発売前対象が同時に3件以上なら60秒へ緩和し、発売日時不明の優先確認は初回観測から4時間に限定する。GitHubにはソースコード、CI、認証付きhealth workflowを残す。
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
node scripts/cloudflare-admin.js trends .cloudflare-migration/trends-private.json
node scripts/cloudflare-admin.js state .cloudflare-migration/state-backup.json
```

操作ツールは `ADMIN_TOKEN` 環境変数または `.cloudflare-migration/admin-token` を読む。`.cloudflare-migration/` はGit対象外の作業領域。管理キー・秘密鍵・内部状態を公開・ログ出力しない。既存キーを作り直さない。

`mode paused` は確認・通知の終了を待って停止し、`mode shadow` は通知なし、`mode active` は本番監視。状態importはpaused限定。詳細は [CLOUDFLARE.md](CLOUDFLARE.md)。

検証は `npm test`、`npm run cloudflare:build`、`npm run viewer:build`、`npm run cloudflare:test`。監視側の `MonitorViewer` を先に反映し、閲覧側を続ける。Accessポリシー・audience・本人メールSecretを維持し、反映後確認欄は実際の結果で更新する。

## Cloudflare移行の記録（完了済み）

2026-09-04 16:32:30 UTC（2026-09-05 01:32 JST）にactive化し、alarm起動、商品取得、health正常、Webhook設定済みを確認した。

- 最終旧run `33893233043` は監視・状態保存・当時のPagesジョブが成功。`nike-monitor-state-33893233043` を2026-09-04 16:29:55 UTCに保存。自己連鎖だけが意図したworkflow無効化による422で終了した。
- 最終直接転送run `33895582921` は最終キャッシュに完全一致し、8商品、品質サンプル756件、在庫履歴28件、イベント80件を取り込んだ。通知済みキーは初回転送と一致。件数は転送時点の記録。
- 固定初期商品 `HQ4307-005` とFragmentの旧ページは両環境で404だったが、現行4商品の取得は成功。shadowでは3商品の自動休止解除と、通知済み状態・履歴の保持を確認した。
- 移行時の旧Pages転送run `33895727520` と外側health run `33895756834` は成功した。ただし公開ページ運用は今回の非公開方針で廃止済み。過去のPages再公開手順は使用しない。
- `cloudflare-transfer.yml` はGitHub OIDCで指定リポジトリ・所有者ID・main・手動workflow・audienceを確認してCloudflareへ直接送る方式。GitHub artifactへの暗号文保存は使用しない。
- 移行用workflowは無効化、一時公開鍵・Cloudflareとローカルの一時暗号文は削除済み。再移行にはworkflow有効化と公開鍵再登録が必要。内部状態を引き継ぎ、閲覧用ステータスから通知キーを再構成しない。
- 再移行時の一時暗号文削除は `node scripts/cloudflare-admin.js clear-credential "実行ID:試行番号"`。対象転送の `migrationId` を必ず指定する。

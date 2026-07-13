# Nike Restock Notifier

Nike Mind 001の全カラーを定期確認して、対象サイズが在庫ありになったらDiscordへ通知するアプリです。すべてGitHub上で動きます。

## 仕組み

- GitHub Actionsが各商品を巡回し、巡回完了後に約2分待って次の確認を始めます
- メンズ・ウィメンズを含む既知の全カラーを商品ごとに監視します
- Nike公式の商品一覧と各商品ページを探索し、新カラーを自動的に追跡対象へ追加します
- 在庫が出たらその場でDiscord webhookへ通知します
- 最新のステータスはGitHub Pagesに表示されます(ページの更新は実行単位なので最大25分程度遅れます。通知は即時です)

ステータスページ: https://fragmentgithub.github.io/nike-restock-notifier/

## 設定

GitHubのリポジトリ設定で以下を追加します。

- Secret: `DISCORD_WEBHOOK` Discord webhookのURL
- Variable: `SIZE_FILTERS` 例: `26,27`(空なら全サイズ対象)
- Variable: `PRODUCT_URL` 変更したい商品URLがある場合だけ
- Variable: `PRODUCT_URLS` 追加商品URL。カンマ区切りまたは改行区切り(任意)
- Variable: `INTERVAL_SECONDS` チェック間隔の秒数(デフォルト120、最小30)
- Variable: `LOOP_MINUTES` 1回の実行がチェックし続ける分数(デフォルト25)
- Variable: `DISCOVERY_URL` 新カラー探索に使うNike公式一覧URL(通常は未設定で可)
- Variable: `DISCOVERY_INTERVAL_HOURS` 新カラー探索間隔(デフォルト6時間)
- Variable: `DISCOVERY_RETRY_MINUTES` 新カラー探索失敗時の再試行間隔(デフォルト30分)
- Variable: `PRODUCT_CHECK_DELAY_MS` 商品間のアクセス待機時間(デフォルト1500ミリ秒)

`PRODUCT_URL`を設定しなくても、Mind 001の確認済みカラーが初期登録されます。検出した新カラーはActions cacheに保存され、以後の実行でも監視を継続します。

Secret設定後のテストは、GitHub Actionsの `Discord Test` workflowを手動実行します。

## 注意

- 実行が終わると次の実行を自動で起動します。待機中のrunがある場合は重複起動せず、そのrunへ引き継ぎます
- 異常終了時は30分間隔のスケジュール実行がバックアップとして再開します
- 取得失敗が続く場合は巡回間隔を最大10分まで自動的に延ばし、Nike側への連続アクセスを抑えます
- Nike側のページ仕様が変わると、在庫判定の調整(`src/nike.js`)が必要になることがあります

## ローカル確認

`npm start` はGitHub Pagesと同じ `public/` を読み取り専用でプレビューします。監視・通知・設定変更はGitHub Actionsだけで実行されます。

開発の引き継ぎ情報は [HANDOFF.md](HANDOFF.md) を参照してください。

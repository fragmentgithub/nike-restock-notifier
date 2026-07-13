# Nike Restock Notifier

Nike Mind 001の全カラーを定期確認して、対象サイズが在庫ありになったらDiscordへ通知するアプリです。すべてGitHub上で動きます。

## 仕組み

- GitHub Actionsが約2分ごとにNikeの商品ページを確認します(1回の実行が約25分間チェックし続けるループ方式)
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
- Variable: `PRODUCT_CHECK_DELAY_MS` 商品間のアクセス待機時間(デフォルト1500ミリ秒)

`PRODUCT_URL`を設定しなくても、Mind 001の確認済みカラーが初期登録されます。検出した新カラーはActions cacheに保存され、以後の実行でも監視を継続します。

Secret設定後のテストは、GitHub Actionsの `Discord Test` workflowを手動実行します。

## 注意

- 実行が終わると次の実行を自動で起動するため、監視はほぼ途切れません(異常終了時はGitHubのスケジュール実行が最大1時間程度で再開します)
- チェック間隔を短くしすぎるとNike側にブロックされる可能性があります。チェック失敗が続く場合は `INTERVAL_SECONDS` を上げてください
- Nike側のページ仕様が変わると、在庫判定の調整(`src/nike.js`)が必要になることがあります

開発の引き継ぎ情報は [HANDOFF.md](HANDOFF.md) を参照してください。

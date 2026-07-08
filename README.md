# Nike Restock Notifier

Nikeの商品ページを定期確認して、対象サイズが在庫ありになったらDiscordへ通知するアプリです。すべてGitHub上で動きます。

## 仕組み

- GitHub Actionsが約2分ごとにNikeの商品ページを確認します(1回の実行が約25分間チェックし続けるループ方式)
- 在庫が出たらその場でDiscord webhookへ通知します
- 最新のステータスはGitHub Pagesに表示されます(ページの更新は実行単位なので最大25分程度遅れます。通知は即時です)

ステータスページ: https://fragmentgithub.github.io/nike-restock-notifier/

## 設定

GitHubのリポジトリ設定で以下を追加します。

- Secret: `DISCORD_WEBHOOK` Discord webhookのURL
- Variable: `SIZE_FILTERS` 例: `26,27`(空なら全サイズ対象)
- Variable: `PRODUCT_URL` 変更したい商品URLがある場合だけ
- Variable: `INTERVAL_SECONDS` チェック間隔の秒数(デフォルト120、最小30)
- Variable: `LOOP_MINUTES` 1回の実行がチェックし続ける分数(デフォルト25)

Secret設定後のテストは、GitHub Actionsの `Discord Test` workflowを手動実行します。

## 注意

- GitHubのスケジュール実行は正確なタイマーではないため、実行と実行の間に数分〜十数分の隙間が出ることがあります
- チェック間隔を短くしすぎるとNike側にブロックされる可能性があります。チェック失敗が続く場合は `INTERVAL_SECONDS` を上げてください
- Nike側のページ仕様が変わると、在庫判定の調整(`src/nike.js`)が必要になることがあります

開発の引き継ぎ情報は [HANDOFF.md](HANDOFF.md) を参照してください。

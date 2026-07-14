# Nike Restock Notifier

Nike Mind 001の全カラーを定期確認して、対象サイズが在庫ありになったらDiscordへ通知するアプリです。すべてGitHub上で動きます。

## 仕組み

- GitHub Actionsが各商品を巡回し、巡回完了後に約2分待って次の確認を始めます
- メンズ・ウィメンズを含む既知の全カラーを商品ごとに監視します
- Nike公式の商品一覧と各商品ページを探索し、新カラーを自動的に追跡対象へ追加します
- 在庫が出たらその場でDiscord webhookへ通知します
- 発売前商品は個別に短い間隔で確認し、通常商品へのアクセス頻度は維持します
- 404/410が続く販売終了候補は自動休止し、定期再確認または公式ページでの再検出時に復帰します
- 在庫変化履歴と直近24時間の成功率・平均応答時間をGitHub Pagesに表示します
- 独立した `health.yml` がPagesの更新停止と復旧をDiscordへ通知します
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
- Variable: `PRODUCT_CONFIG_JSON` 商品別のサイズ・通知・有効/無効・メンション設定(JSON、任意)
- Variable: `DELIST_FAILURE_THRESHOLD` 明示的な404/410が何回続いたら自動休止するか(デフォルト12)
- Variable: `PAUSED_RECHECK_HOURS` 自動休止商品の再確認間隔(デフォルト24時間)
- Variable: `UPCOMING_INTERVAL_SECONDS` 発売前商品の確認間隔(デフォルト30秒)
- Variable: `UPCOMING_WINDOW_MINUTES` 発売日時の何分前から短間隔にするか(デフォルト180分)
- Variable: `DISCORD_MENTION` 全商品共通のDiscordユーザー/ロールメンション。例 `<@&123456789>`
- Variable: `STATUS_URL` watchdogが確認するstatus.json URL(通常は未設定で可)
- Variable: `HEALTH_STALE_MINUTES` 更新停止と判定する時間(デフォルト50分)

`PRODUCT_URL`を設定しなくても、Mind 001の確認済みカラーが初期登録されます。検出した新カラーはActions cacheに保存され、以後の実行でも監視を継続します。

Secret設定後のテストは、GitHub Actionsの `Discord Test` workflowを手動実行します。

### 商品別設定

`PRODUCT_CONFIG_JSON` はスタイルカラーをキーにします。`sizes` が空配列なら、その商品だけ全サイズ対象です。

```json
{
  "HQ4307-005": {
    "sizes": ["27", "28"],
    "notify": true,
    "enabled": true,
    "mention": "<@&123456789>"
  },
  "HQ4309-400": {
    "sizes": [],
    "notify": false
  }
}
```

`notify: false` は監視と履歴記録を続けたまま通知だけ止めます。`enabled: false` は商品確認そのものを停止します。
JSONが不正な場合は安全のため商品確認と通知を停止し、Pagesに設定エラーを表示します。既定設定へ暗黙に戻ることはありません。

## 注意

- 実行が終わると次の実行を自動で起動します。待機中のrunがある場合は重複起動せず、そのrunへ引き継ぎます
- 異常終了時は30分間隔のスケジュール実行がバックアップとして再開します
- 全商品の取得が失敗するサイクルが続く場合は巡回間隔を最大10分まで自動的に延ばし、Nike側への連続アクセスを抑えます
- 在庫履歴・品質サンプル・自動休止状態はActions cacheに保存されます。workflowが長期間停止してcacheが失効すると履歴はリセットされます
- Nike側のページ仕様が変わると、在庫判定の調整(`src/nike.js`)が必要になることがあります

## ローカル確認

`npm start` はGitHub Pagesと同じ `public/` を読み取り専用でプレビューします。監視・通知・設定変更はGitHub Actionsだけで実行されます。

開発の引き継ぎ情報は [HANDOFF.md](HANDOFF.md) を参照してください。

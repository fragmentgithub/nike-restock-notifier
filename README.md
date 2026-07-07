# Nike Restock Notifier

Nikeの商品ページを定期確認して、対象サイズが在庫ありになったら通知するアプリです。

## ローカルで使う

```powershell
node server.js
```

ブラウザで `http://localhost:4173` を開きます。

## GitHub Pagesで使う

GitHub Pagesは静的サイトなので、画面だけでは常時監視できません。このリポジトリではGitHub Actionsが5分ごとにNikeを確認し、結果をPagesに表示します。

Discord通知を使う場合は、GitHubのリポジトリ設定で以下を追加します。

- Secret: `DISCORD_WEBHOOK`
- Variable: `SIZE_FILTERS` 例: `26,27`
- Variable: `PRODUCT_URL` 変更したい商品URLがある場合だけ

## 通知

- ローカル版: ブラウザ通知とDiscord webhookに対応
- GitHub Pages版: GitHub ActionsからDiscord webhookへ通知

Nike側のページ仕様が変わると、在庫判定の調整が必要になることがあります。

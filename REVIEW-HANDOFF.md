# レビュー引継書 (2026-07-19)

対象: `git diff 51a025d..HEAD`(コミット 81ee351 / b450610 / f5b50a7 の3件、19ファイル +1,237行)
方法: マルチエージェントレビュー(8観点で検出25件 → 重複統合21件 → 各指摘を懐疑的検証エージェント2体で裏取り)。
初回結果: **19件 CONFIRMED / 2件 PLAUSIBLE(検証者の判定が割れた) / 反証0件**。

> 対応状況 (2026-07-19): 本書の確定指摘と、その後の再レビューで判明した問題は修正済み。以下は初回レビュー時点の記録として残す。

検証エージェントの全証跡(file:line引用付き)は
`C:\Users\star_\AppData\Local\Temp\claude\C--Users-star--Documents-ni-re\74b3a7ee-c944-4404-9d55-2153ec854a00\tasks\wtrp3sff5.output`
(セッション終了で消える可能性あり。恒久版は本書)。

---

## A. 実装バグ(修正推奨順)

### A1. 取得失敗での oosStreak リセットにより再入荷通知を恒久的に取り逃す【中〜高】
`src/monitor-state.js:48` — applyCheckState が `!result.ok` で `oosStreak = 0` にリセットするため、lastStockKey のクリア(OOS_CLEAR_THRESHOLD=2)には「失敗を挟まない連続2回の在庫なし確認」が必要になった。Nikeのボットブロックで失敗が断続混入すると「在庫なし→失敗→在庫なし→同サイズ再入荷」で shouldNotify=false のまま、直後に lastStockKey が再ラッチされ通知機会が恒久消失。一方 recordStockTransition は履歴に「入荷」を記録するので、ダッシュボードと通知が食い違う。検証2/2、Node再現済み。
**修正案**: 失敗時は oosStreak を**保持**(リセットも加算もしない)。`test/monitor-state.test.js:42-57`「取得失敗を挟んだ在庫なし確認は連続扱いしない」はこの挙動を固定しているので期待値を「凍結」に書き換える。

### A2. HEALTH_STALE_MINUTES と LOOP_MINUTES が独立で、範囲内設定で誤報が恒常化【中】
`scripts/check-health.js:11` / `src/health.js` — 公開 status.json の updatedAt は run 終了時の値で、経過は毎サイクル LOOP_MINUTES+ジョブオーバーヘッド+Pages CDNキャッシュ(max-age=600)まで伸びる。LOOP_MINUTES=60 + 閾値既定50 で毎時停止/復旧の誤報ペア。閾値下限10はデフォルト構成でも確実に誤報する値を許す。ドキュメントに依存関係の警告なし。検証2/2。
**修正案**: evaluateMonitorHealth に status.config.loopMinutes を渡し、実効閾値 = `max(staleMinutes, loopMinutes + 15〜20分)`。README/HANDOFF にも関係を明記。

### A3. recordStockTransition にフリッカ抑制がなく偽の入荷/在庫なし履歴が公開される【中】
`src/monitor-policy.js:126` — 通知側は OOS_CLEAR_THRESHOLD=2 で単発フリッカ(パーサ/フォールバック不一致)を吸収するのに、履歴側は1回の観測差で即 lastObservedStockKey を上書きし履歴+stock-changeイベントを生成。HTML経路(JSON断片サイズは常にavailable:false)とAPI経路が交互成功すると毎チェック偽ペアが積まれ、上限300の履歴から本物が押し出される。検証2/2、Node再現済み。
**修正案**: 在庫なし方向の遷移は oosStreak(または同等のストリーク)が閾値到達してから確定させる。

### A4. フォールバック成功が発売直前の30秒高速レーンを解除する【中】
`src/nike.js:236` — coming-soon/releaseAt を返せるのは parseNextProductData のみ。発売直前にPDPがブロック/シェル化してAPIフォールバックが ok:true('out-of-stock', releaseAt:null)を返すと lastResult が上書きされ、isUpcomingPriority が false になり、発売時刻をまたぐ間だけ間隔が120秒へ低下。検証2/2。
**修正案**: parseProductFeed で merchProduct.commerceStartDate 等から releaseAt/coming-soon を導出する、または「発売前状態」を lastResult とは別のエントリフィールド(例 upcomingUntil)に保持して1回の観測で消さない。

### A5. 全滅バックオフがジョブ途中の障害で発動しない【中】
`src/monitor-state.js:86` — due方式では定常サイクルが部分巡回(通常1商品)になり `checkedProducts !== totalProducts` でストリークが増えない。ジョブ途中で全面障害が始まると次のジョブまでバックオフ死文化(旧実装からの退行)。実害は「減速しない」だけでレート自体は増えない(検証者2名とも medium 判定)。検証2/2。
**修正案**: サイクル単位でなく時間窓ベース(直近N分間の全チェックが失敗、失敗商品が複数)でストリーク判定する。

### A6. 全商品休止で self-dispatch が空ループ連鎖【低〜中】
`scripts/monitor.js:155` + `pages.yml` の Queue next — 全商品 delisted 休止だと1サイクル目で即 break しジョブが数十秒で終了、pages.yml は無条件に次 run を dispatch するので、24時間の再確認まで数分間隔の無意味な run/デプロイが連鎖。検証2/2。
**修正案**: monitor.js 終了時に「次due までの分数」を GITHUB_OUTPUT へ出し、閾値超なら dispatch をスキップ(30分cronバックアップが拾う)。

### A7. 200シェル/リダイレクト型の販売終了では自動休止が到達不能【低】
`src/nike.js:188` — notFound は最初のPDP直接応答の404/410のみ。302→200やSEOシェルで消えた商品は ok:false/notFound:false となり、updateDelistState が毎回 missingStreak をリセットするため閾値12に永遠に達しない。検証2/2。
**修正案**: notFound以外の恒久失敗用に別カウンタ(unresolvedStreak)を設け、大きめの閾値で休止(理由 'unreachable')にする。

### A8. Discord通知に内部センチネル `__product__` が漏れる【低】
`src/monitor-state.js:26` + `scripts/monitor.js:311` — サイズ抽出失敗+カート文言のみのHTMLフォールバック(matchingSizes=[], inStock=true)の初回検知で、message と「新規サイズ」フィールドに生の `__product__` が表示される。formatPreviousStock/formatStockLabels には変換があるのにこの経路だけ漏れ。検証2/2。
**修正案**: 通知組み立て時に formatStockLabels 相当の変換を適用。

### A9. メンションの無警告破棄と暗黙フォールバック【低】
`src/monitor-policy.js:206` — `<@!id>`(ニックネーム形式)が無警告で '' に落ち、通知がピングなしになる。商品別 mention が無効化されると `settings.mention || global` でグローバルのロール/ユーザーへ意図せずピング。`"mention": ""` で商品単位のメンション無効化もできない。検証2/2。
**修正案**: 正規表現を `/^<@[!&]?\d+>$/` 系に拡張+無効値は console.warn。`Object.hasOwn(settings,'mention')` なら空文字でもグローバルへフォールバックしない。

### A10. status.json 取得の一時失敗だけで即「監視停止」誤報【低】
`scripts/check-health.js:23` — fetch例外/非2xxを即 unhealthy 化し、文書の「50分閾値」を適用しない。CDNの一時503が1回で停止→復旧の誤報ペア。検証2/2。
**修正案**: .health-state に連続失敗回数を持ち、2回連続(30分)で初めて unhealthy 化。

### A11. カタログ再出現の即時再確認が1回限り【低】
`src/monitor-policy.js:111` — 予約された再確認が一時失敗すると lastSeenAt が書き戻され、catalogPresent=true のため再予約されず、休止解除が最大24時間遅延。検証2/2。
**修正案**: reprobe を pending フラグとして持ち、成功するまで維持。

### A12. HANDOFF.md のループ説明が新スケジューラと乖離【低】
`HANDOFF.md:61`(33行・159行も) — 「全商品を順番に確認し巡回完了後にINTERVAL_SECONDS秒待つ」は旧方式。実際は商品ごとのdue時刻方式で、coming-soon商品があればサイクルは約30秒毎。検証2/2。
**修正案**: HANDOFF/README のループ説明・INTERVAL_SECONDS の意味(商品毎の再確認間隔)を更新。

## B. テストギャップ(全て CONFIRMED、追加推奨)

1. `test/monitor-policy.test.js:105`【中】 isUpcomingPriority の releaseAt ウィンドウ判定(発売前180分〜発売後60分)が一切未テスト(フォールバック分岐しか通らない)。
2. `test/nike.test.js:80`【低】 403/5xx が notFound にならないことを固定するテストがない(緩めるリファクタで全商品一斉休止の危険)。
3. `test/monitor-state.test.js:118`【低】 nextFailedCycleStreak の checked===total かつ completedSweep:false エッジ未テスト。
4. `test/monitor-policy.test.js:46`【低】 updateDelistState の休止中エントリ分岐(一時失敗でstreak保持・再404で'paused'再発火しない)未テスト。※この1件のみ検証1/1(相方がセッション上限で欠落)。
5. `test/monitor-policy.test.js:16`【低】 settingsForProduct のグローバルメンション継承と不正値除去が未テスト。
6. `test/monitor-policy.test.js:136`【低】 computeQualityMetrics のサンプル0件・未来時刻サンプル除外が未テスト。
7. `test/health.test.js:31`【低】 shouldNotifyHealthTransition(undefined→unhealthy) 未テスト。

## C. PLAUSIBLE(判定が1対1で割れた・修正は任意)

1. `src/monitor-policy.js:180` 発売日不明の coming-soon 商品が無期限に30秒間隔ポーリング。反対意見: テストと README がこの挙動を意図として明示しており設計判断。歯止め(上限日数など)を入れるかは運用判断。
2. `scripts/check-health.js:10` DISCORD_WEBHOOK 不正/未設定時に watchdog が無警告でサイレント無効化。反対意見: ログには出る・monitor側 validateWebhook と対称にするだけの小改善。console.warn 追加程度が妥当。

## 良かった点(検証済み)

- セキュリティ指摘ゼロ: 新UI(在庫履歴・品質パネル)の全挿入点がエスケープ済み、allowed_mentions は parse:[] でロック、webhook 秘匿(scrubWebhook)も新経路で維持。
- singleSweep(LOOP_MINUTES=0)の意味論、設定エラー時の安全側停止(暗黙デフォルト復帰なし)、健全性の設定エラー検知はいずれも正しく実装。
- 新規純ロジックの分離(monitor-policy.js)とテスト追加の方向性は良い。

## 対応後メモ

- A1〜A12とテストギャップを修正し、追加の再レビューも実施済み。
- 修正後は全テスト、構文確認、`git diff --check` を実行している。

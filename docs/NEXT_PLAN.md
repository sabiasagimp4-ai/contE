# contE 次期実装計画

更新日：2026-09-19  
対象：main の b64b28b80f3c14a1756365d7c2197bae7581dc3e 以降

この計画は、機能数を増やす順番ではなく、「編集中のデータを失わない」「大きなプロジェクトでも操作を止めない」「出力結果を再現できる」を先に満たすための実装順を定める。各段階は、実装・テスト・計測・ドキュメント更新までを含めて完了とする。

## 1. 現在地

直近の main では、次の基盤が実装済みである。

| 領域 | 現在の状態 |
|---|---|
| Asset安全性 | Asset参照の検証、到達可能性ベースのGC、孤立Assetの整理 |
| 編集境界 | EditorSession、ProjectIndex、選択・revision・古い非同期処理の無効化 |
| Timeline | Panel境界の二分探索、表示範囲計算、再生ヘッド追従、RenderScheduler |
| 出力整合性 | ExportSnapshotでProjectと行を固定し、紙コンテとAnimaticが同じスナップショットを使う |
| 配布形式 | 素材を含む自己完結Bundleの .contb。旧 .contp JSONも読み込み可能 |
| CI | Nodeテスト、build、browser smoke が main で成功 |

最終CI：[run 35451000045](https://github.com/sabiasagimp4-ai/contE/actions/runs/35451000045)

現在の保存ボタンは素材込みの .contb を出力する。旧 .contp は後方互換の読み込み形式として残す。これはまだ完成したデスクトップアプリではなく、ブラウザ上のローカルアプリである。

## 2. 棚卸しで見つかった根本課題

### A. Bundle読み込みが完全には原子的でない — 最優先

Bundle全体の検証は書き込み前に終わるが、Assetストアへの書き込みは現在1件ずつ行われる。そのため、後半のAsset書き込みが失敗した場合、Projectの差し替えは起きなくても、前半のAssetだけが孤立して残る可能性がある。読み込み中にSessionが変わった場合も、同じ問題を避ける境界が必要である。

### B. 1000〜5000 Panel＋実素材の実測がない — 最優先

既存のbenchは主に100/500 PanelとMemoryStorageを対象にしている。実画像・実音声のデコード、ブラウザのメモリ、IndexedDB、ZIP生成、入力遅延はまだ同じ条件で測れていない。Worker化やデスクトップ化の判断を先に行うと、測定前の最適化になる。

### C. app.jsにUI統合責務がまだ集中している — 高優先

TimelineやSessionの境界はできたが、DOMイベント、Asset入出力、Inspector、Timeline、出力起動の接続はapp.jsに残っている。まず性能計測で遅い経路を特定し、その経路だけをProjectIO、TimelineView、InspectorView、AssetControllerなどへ分離する。

### D. 制作フローの不足 — 中優先

Panelのコピー&ペースト、Timeline上のClip移動、CameraのCanvas直接操作とイージング、音量フェード・ミックス、複数Shotの見渡し、検索・テンプレートが未完了である。頻繁な操作から順に追加する。

### E. Windows固有条件が未計測 — 中優先

Windows Ink、ペン圧・傾き、音声時計、ファイルの直接入出力、数千Panelの常駐メモリ、オフライン動画エンコードはこの環境では確定できない。Electron/Tauri/WebView2/nativeの選択は、実機計測後に行う。

## 3. 実装フェーズと完了条件

### N0 — 仕様とドキュメントの同期（このPR）

実装済み機能とREADME・Architecture・Next Stepsの記述を一致させる。特に .contb と旧 .contp の関係、ExportSnapshot、現在のモジュール境界を明記する。

完了条件：

- 新規利用者が保存形式を誤解しない。
- 次の実装順と判断ゲートがリポジトリ内から辿れる。
- 未計測の項目を「対応済み」と表現しない。

### N1 — Atomic Bundle Import

Bundle読み込みを「検証 → staging → commit → Project差し替え」の段階に分ける。

実装内容：

- Manifest、Version、Asset ID、サイズ、MIME、CRC、SHA-256、パスを全件preflightする。
- 同一ID・同一ハッシュは再利用可能にし、同一ID・異なる内容は明確に拒否する。
- 一時import tokenを付けたstaging領域を用意する。
- すべてのAsset書き込みが成功したときだけcommitする。失敗・中止・Session変更時はstagingをロールバックする。
- Asset commit後、現在Sessionが同じ場合だけProjectを差し替える。
- 古いstagingを起動時または次回import前に安全に掃除する。
- エラー時に「旧Projectはそのまま」「新Assetも孤立しない」をUIとテストで保証する。

完了条件：

- 空のStorageからの正常import。
- 破損・未知Version・未知Asset・重複ID・同一ID異内容の拒否。
- 途中のput失敗、Quota不足、ユーザー中止、Session変更の各ケースで旧Projectが不変。
- import後に孤立Assetが残らない。
- legacy .contp の読み込みと通常保存を壊さない。
- Nodeテスト、browser smoke、build、CIが成功する。

### N2 — 大規模プロジェクト計測とUI境界の整理

実際のボトルネックを数値で確定する。

実装内容：

- 1000/2500/5000 Panelの再現可能なfixtureを作る。
- 複数サイズの画像と音声を含め、デコード済み・未デコードの両条件を測る。
- Panel編集、Scene移動、Timelineスクロール、Zoom、再生開始、Undo、autosave、Bundle import、紙/Animatic出力を測る。
- p50/p95の操作遅延、メモリ、長時間操作後の増加、キャンセル応答、入力落ちを記録する。
- 計測で遅い経路だけをProjectIO、TimelineView、InspectorView、AssetController等へ分割する。純粋な計算層はDOMから切り離す。

完了条件：

- 同じfixtureと手順で再測定できる。
- 主要操作のp95が現行501 Panelの基準を大きく悪化させない。
- 1000/2500/5000 Panelで、保存・再読込・復旧・出力の成功率と失敗理由を記録できる。
- Worker化を行うか延期するかを計測結果で決定する。

### N3 — Streaming Output

出力が完成Blobを長時間保持し続けない経路を作る。

実装内容：

- ExportSinkを定義し、write、close、abortを共通化する。
-対応環境ではFile System AccessまたはOPFSへ逐次書き込みし、非対応環境はBlob fallbackにする。
- PNG、紙コンテ、Animaticの中止時に一時出力を確実に破棄する。
- ZIPの容量上限や非対応条件を事前に検出し、無言の破損を避ける。
- 出力中はExportSnapshotを固定し、編集内容が混ざらない契約を維持する。

完了条件：

- 出力成功、途中中止、書き込み失敗、再試行の各テスト。
- 非対応ブラウザで従来のダウンロードに戻る。
- 大規模fixtureでピークメモリと完了時間を記録できる。
- 破損したZIPや未完了ファイルを成功扱いにしない。

### N4 — Worker化の判断と必要箇所だけの移動

N2の計測でUIスレッドが目標を超えた場合だけ実施する。

候補は、純粋なPanel/Camera評価、Canvas描画、PNGエンコードである。OffscreenCanvasが使えない場合はメインスレッドへ戻すfallbackを残す。Font、画像Bitmapの所有権、消しゴム合成、キャンセル、出力順を先にテストする。

完了条件：

- Workerあり・なしで同じProjectから同じ出力が得られる。
- Worker停止、例外、古いSessionの結果を画面へ反映しない。
- 対応環境が増えるだけで、非対応環境の操作を壊さない。
- N2の計測で改善効果を確認できる。改善が小さい場合はWorkerを採用しない。

### N5 — 制作フローの高頻度操作

次の順で追加する。

1. Panelのコピー&ペースト。新しいIDと順序を発行し、Assetは共有参照、音声・Camera・選択状態は明示的な規則で複製する。
2. 複数Shot・Scene間の複製と、参照切れのないUndo/Redo。
3. Timeline上のPanel/Audio Clip移動、Track折りたたみ、複数Shotの見渡し。
4. Camera枠のCanvas直接操作、キーの複製、イージング。

完了条件：

- すべての編集がEditorSession経由で履歴・自動保存される。
- ID衝突、Asset共有、Anchor移動、Panel削除後のClip整理をテストする。
- pointercancel、Undo/Redo、再読込後も同じ結果になる。
- browser smokeに制作シナリオを追加する。

### N6 — 音声・紙コンテの完成度

N5の制作フロー後に、出力品質を上げる。

候補：

- Audio Clipのfade in/out、gain curve、複数Clipのmixdown。
- 文字主体のPDFまたは印刷DOM。画像ベースPDFとの違いをUIに表示する。
- 紙コンテの行高可変、テンプレート保存、再利用可能な列セット。
- 検索、複数Projectの管理、復旧候補の選択性向上。

完了条件：

- 再生、紙コンテ、Animaticで音量・Clip境界の意味が一致する。
- 出力に使った設定とProjectのrevisionを追跡できる。
- 大規模fixtureで処理時間と中止応答を確認する。

### N7 — Windows実機ゲートとデスクトップ化

実機が用意できた段階で、次の表を埋めてからshellを選ぶ。

| 計測項目 | 記録する値 |
|---|---|
| 起動 | 起動から編集可能になるまで |
| 入力 | ペン遅延、圧力、傾き、pointercancel |
| 音 | 再生開始遅延、長時間ドリフト、録音経路 |
| ファイル | 開く、保存、上書き、失敗時の復旧 |
| メモリ | 500/1000/5000 Panel＋実画像・音声 |
| 動画 | 形式、速度、サイズ、キャンセル |

判断規則：

- WebView2で入力・音・ファイルが十分なら、最小のWebView2 shellを優先する。
- WebView2で要件を満たせず、Electronの実測値が必要条件を満たす場合だけElectronを選ぶ。
- native rewriteは、両方で満たせない要件が証明された場合に限る。
- H.264/ProResなどの形式は、技術・配布・ライセンス条件を確認してから選ぶ。初期の既定形式はブラウザで安定する形式を維持する。

### N8 — リリース硬化

最後に、実装済みの範囲を壊さず配布できる状態へ固める。

- .contbのformat仕様、Version、Migration、互換性テストを明文化する。
- 外部入力のパス・サイズ・MIME・ハッシュ・展開数を再確認する。
- 性能fixtureとbrowser smokeをCIで定期実行する。
- 失敗した保存・import・exportから復旧するUIを確認する。
- README、ARCHITECTURE、NEXT_STEPS、ROADMAPの記述を同じ状態へ更新する。

## 4. 実装PRの順番

1. N0：この計画とREADMEの同期
2. N1：Atomic Bundle Import
3. N2：1000〜5000 Panelの実測と、遅い経路の境界整理
4. N3：ExportSinkとStreaming Output
5. N4：計測結果が必要と判断した場合だけWorker化
6. N5：コピー&ペースト、Timeline操作、Camera直接操作
7. N6：音声フェード、紙コンテの文字出力・テンプレート
8. N7：Windows実機計測後のshell・オフライン出力
9. N8：互換性・性能・配布の硬化

各PRは小さく保ち、コード変更、Nodeテスト、browser smoke、build、ドキュメントを同じPRで完結させる。

## 5. 判断ゲート

- Bundleの途中失敗で旧Projectが変わらず、孤立Assetが残らないことをN1の終了条件にする。
- N2の数値が許容範囲内なら、Worker化を延期して機能開発を進める。
- 出力のピークメモリが問題なら、N5よりN3を優先する。
- WebCodecsや外部エンコーダは、実機と配布条件を確認してから採用する。
- 大規模fixtureで再現できない不具合は、機能追加より先にfixtureと観測性を改善する。
- フレームワーク移行、全面的なnative rewrite、Project schemaの大規模変更は、この計画の測定結果が必要性を示すまで行わない。

## 6. すべてのフェーズの完了定義

- 正常系だけでなく、中止・失敗・再試行・古いSessionの結果をテストする。
- npm test、npm run build、必要なbrowser smokeが成功する。
- 既存の .contp 読み込み、.contb 読み込み、Undo/Redo、復旧、紙コンテ、Animaticを壊さない。
- 変更内容、計測条件、既知の制約をドキュメントへ記録する。
- 失敗時にユーザーの旧Projectを守り、成功表示を早出ししない。
- 次のPRへ渡す境界と、採用しなかった案の理由を残す。

直近の実装対象はN1である。新機能を広げる前に、Bundle読み込みを本当に原子的な処理へ仕上げる。

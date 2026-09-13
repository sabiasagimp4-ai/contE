# contE — 絵コンテ制作の基礎実装

描く・Panelを増やす・尺を決める・Cameraを確認する・紙コンテへ出す、を一画面で試せる初期版です。**完成したデスクトップアプリではありません。** ブラウザ上でローカル動作します。音声の配置・波形・動画書き出し・筆圧・消しゴム・画像読み込みは未実装です。編集内容はブラウザ内へ自動保存され、次回起動時に復旧できます。配布可能なファイルは保存ボタンで別途書き出してください。

## 起動

Node.js 22以上で、このフォルダから実行します。依存パッケージのインストールは不要です。

```sh
npm start
```

http://127.0.0.1:8000 をChrome/Edgeで開いてください。`file://`での直接起動には対応しません。`npm run build`で`dist/`に静的アプリを生成します。

## 今回の実装

- Scene → Shot → Panel。Panel追加、複製、同Shot内移動、複数選択と一括尺/注記変更、削除、Shot分割/前Shotへの統合。
- Canvasで線を描画。描画と尺調整を同じ画面で実施。サムネイルは表示範囲で描画。
- 整数フレームのTimeline。端をドラッグしてリップル尺変更、空白部分でスクラブ、Zoom、再生/停止。
- Camera開始/終了の線形補間（X/Y/Zoom/Rotation）。今回は終了KeyframeのInspector設定のみ。
- 80段階のUndo/Redo。無効な編集は原子的に拒否。描画データは不変共有して履歴コストを削減。変更のない操作は履歴段数を消費せず、Undo/Redoで選択Panelと再生位置も戻ります。
- `.contp` JSON v2の保存/読み込み。v1ファイルは読み込み時にv2へMigrationします。破損データ・重複ID・未知Versionを拒否します。保存はブラウザのダウンロードで、既存ファイルへの直接上書きではありません。
- 変更の1.2秒後（最長8秒）にIndexedDBへ自動保存し、ヘッダーに保存状態を表示します。最大8世代を保持し、起動時に前回の作業を日時・タイトル・Panel数つきで提示して復旧/破棄を選べます。読めない保存データは削除せず読み飛ばし、直前の正常な世代を提示します。容量不足のときは古い世代を減らして一度だけ再試行し、それでも失敗した場合は失敗として表示します（成功表示にしません）。
- 素材（画像/音声）はIDとメタデータのみをプロジェクトに持ち、バイナリは別ストアに保存する構造にしました。取り込みUIはP1で実装します。
- 紙コンテ：コマ数、画像列幅、表示項目、余白、文字サイズ、ヘッダーを調整。CUT・画像・尺・台詞・SE/BGM注記・演出・Camera・階層番号。矢印、開始/終了枠、HOLDを描画。
- 紙コンテのPNG連番とブラウザ印刷/PDF保存。A4縦の初期実装です。自由な用紙サイズ・各テキスト列の独立幅・任意軌道は後続です。文字あふれがある場合は出力を止めます。印刷時は用紙A4、余白なし、ヘッダー/フッターなしを選択してください。PDFは画像ベースで文字検索できません。

## 操作

| 操作 | キー / 手順 |
|---|---|
| 新規Panel | N |
| 複製 | Ctrl/Cmd D |
| 前 / 次Panel | ← / → |
| 尺 ±1フレーム | [ / ] |
| 再生 / 停止 | Space |
| 終了Camera Keyframe設定 | K |
| Timeline Zoom | + / - |
| Undo / Redo | Ctrl/Cmd Z / Shift Z |
| Shot分割 / 前Shotへ統合 | Ctrl/Cmd K / Shift K |
| 保存（ファイル書き出し） | Ctrl/Cmd S（テキスト編集中は保存ボタン） |
| 複数選択 | Strip / TimelineをCtrl/Cmdクリック |
| 紙コンテ | 紙コンテ出力 → 印刷/PDF またはPNG連番 |

ショートカットはテキスト入力中に編集コマンドとして発火しません。Shot先頭での分割、Scene先頭Shotの統合は何も変更しません。最後のPanelは削除できません。別SceneのShot同士の統合は未対応です。

## 構成と次の段階

`src/model.js`：階層・検証・Migration・履歴、`src/repository.js`：保存/復旧/素材と自動保存、`src/storage.js`：IndexedDB/メモリのStorage Adapter、`src/playback.js`：時刻計算・Panel検索、`src/drawing.js`：描画Adapter、`src/paper.js`：ページ生成・Camera表記、`src/app.js`：UI/Timeline操作。

[次期開発資料・元プロンプト・添付UI](docs/NEXT_STEPS.md) / [ロードマップ](docs/ROADMAP.md) / [改善サイクルと検証](docs/DEVELOPMENT.md)。次は画像取り込みと描画ツール（P1）、その後にTimeline EngineとCamera Track、音声、Animatic出力です。Timeline UIは今後独立モジュールへ分離します。

```sh
npm test
npm run bench
npm run build
```

任意のブラウザテスト：別途PlaywrightとChromiumを用意し、`npm run test:browser`。`PLAYWRIGHT_MODULE`と`CHROMIUM_EXECUTABLE`で外部インストールを指定できます。これらはアプリ配布物には含まれません。

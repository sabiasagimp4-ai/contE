# contE — 絵コンテ制作の基礎実装

描く・Panelを増やす・尺を決める・Cameraを確認する・紙コンテへ出す、を一画面で試せる初期版です。**完成したデスクトップアプリではありません。** ブラウザ上でローカル動作します。音声の配置・波形・動画書き出し・筆圧・消しゴム・画像読み込みは未実装です。

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
- 80段階のUndo/Redo。無効な編集は原子的に拒否。描画データは不変共有して履歴コストを削減。
- `.contp` JSON v1の保存/読み込み。破損データ・重複ID・未知Versionを拒否。旧形式はまだないためMigration処理は未導入。保存はブラウザのダウンロードで、既存ファイルへの直接上書きではありません。自動保存は未実装です。
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
| 保存 | Ctrl/Cmd S（テキスト編集中は保存ボタン） |
| 複数選択 | Strip / TimelineをCtrl/Cmdクリック |
| 紙コンテ | 紙コンテ出力 → 印刷/PDF またはPNG連番 |

ショートカットはテキスト入力中に編集コマンドとして発火しません。Shot先頭での分割、Scene先頭Shotの統合は何も変更しません。最後のPanelは削除できません。別SceneのShot同士の統合は未対応です。

## 構成と次の段階

`src/model.js`：階層・検証・履歴、`src/playback.js`：時刻計算・Panel検索、`src/drawing.js`：描画Adapter、`src/paper.js`：ページ生成・Camera表記、`src/app.js`：UI/Timeline操作。

[次期開発資料・元プロンプト・添付UI](docs/NEXT_STEPS.md) / [ロードマップ](docs/ROADMAP.md) / [改善サイクルと検証](docs/DEVELOPMENT.md)。次は自動復旧と素材管理、その後に音声とAnimatic出力です。Timeline UIは今後独立モジュールへ分離します。

```sh
npm test
npm run bench
npm run build
```

任意のブラウザテスト：別途PlaywrightとChromiumを用意し、`npm run test:browser`。`PLAYWRIGHT_MODULE`と`CHROMIUM_EXECUTABLE`で外部インストールを指定できます。これらはアプリ配布物には含まれません。

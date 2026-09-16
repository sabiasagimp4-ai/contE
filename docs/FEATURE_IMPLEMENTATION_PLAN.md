# contE 機能追加と操作性の実装計画

作成日: 2026-09-16
状態: 実装進行中。完了した項目は各行の「前提」列に「実装済み」と記す。
未実装の項目は計画のまま。

この文書は「何を作るか」を決めた計画である。構造改善の計画は
[ARCHITECTURE_IMPLEMENTATION_PLAN.md](./ARCHITECTURE_IMPLEMENTATION_PLAN.md)（R00〜R20）に
あり、そちらの契約（保存形式、履歴の粒度、Command経由の編集、出力の内容固定）を
この計画も引き継ぐ。両者が同じファイルへ触る箇所は§8に列挙した。

現在の構造は [ARCHITECTURE.md](./ARCHITECTURE.md) が記録している。ここで「現状」と
書いた内容はその時点の実装を指す。

## 1. 共通の約束

新しい項目を足すときも、既に通っている規約を崩さない。

| 約束 | 内容 |
|---|---|
| 編集の入口 | UIの操作は`src/application/commands.js`のCommandを`EditorController.execute()`で実行する。Command内部で`await`しない |
| 副作用 | 1回の確定編集につき、dirty・保存予約・再描画は1回。失敗は成功と区別した結果で返し、履歴もrevisionも増やさない |
| 履歴の粒度 | ドラッグや連続操作は「離したときに1回」。途中の値を履歴へ積まない |
| 非同期 | 素材を伴う操作は`ImportController`を通し、開始時に対象とSessionを固定する |
| 保存形式 | v5を変える項目は§6へ集約し、1回の移行としてまとめて行う。それ以外は形式に触らない |
| 表示 | Projectが変わらない表示状態（オニオンスキン、クリップボード、プレゼンモード等）はProjectにもlayoutにも保存しない |
| 検証 | 純粋な計算はNodeテスト、UIの経路は`scripts/browser-smoke.mjs`。実ブラウザで確認できないものは「未確認」と記録する |
| 戻し方 | 1項目1コミット。挙動変更と移動を混ぜない。保存データの削除を戻し方にしない |

見積りの「規模」は次の目安とする。実測ではなく相対値である。

- **小** = 1コミット、既存の関数に足すだけ、新しい契約を作らない
- **中** = 1〜3コミット、新しいモジュールか新しいCommandが増える
- **大** = 複数のリリース境界にまたがる。単独で計画を持つ

## 2. 作業単位の一覧

| ID | 内容 | 規模 | 形式 | 前提 |
|---|---|---|---|---|
| A0 | Timelineのドラッグ並べ替え | 小 | 不要 | 実装済み |
| A1 | コマの左端（境界）ドラッグ | 小 | 不要 | 実装済み |
| A2 | 数値ドラッグ中のライブ表示 | 中 | 不要 | 実装済み |
| A3 | スナップ対象の追加とガイド線 | 中 | 不要 | 実装済み |
| A4 | ドラッグ中の自動スクロール | 小 | 不要 | 実装済み |
| A5 | 選択の拡張（Shift/Ctrl＋矢印） | 小 | 不要 | なし |
| A6 | Sceneの開閉状態を覚える | 小 | 不要 | なし |
| A7 | Undo/Redoの内容表示 | 小 | 不要 | なし |
| A8 | 数値のホイールとTab移動 | 小 | 不要 | なし |
| A9 | Timelineの行の高さ切り替え | 中 | 不要 | なし |
| A10 | Cameraキーの複数選択 | 中 | 不要 | なし |
| B1 | 尺の管理（総尺・目標・内訳） | 小 | 不要 | なし |
| B2 | 台詞・注記の検索 | 中 | 不要 | なし |
| B3 | 範囲再生・Shotループ | 中 | 不要 | なし |
| B4 | Cameraキーのコピー／貼り付け | 小 | 不要 | なし |
| B5 | 画像の差し替え | 小 | 不要 | なし |
| B6 | 尺の一括設定・等分 | 小 | 不要 | なし |
| B7 | 直線・矩形・矢印ツール | 中 | 不要 | なし |
| B8 | プレゼンモード | 中 | 不要 | なし |
| B9 | 保存履歴から選んで復元 | 中 | 不要 | E2が望ましい |
| B10 | 複製・貼り付けで音も持ち運ぶ | 中 | 不要 | なし |
| C1 | マーカー | 中 | **v6** | §6 |
| C2 | コマのラベル色 | 小 | **v6** | §6 |
| C3 | Cameraのイージング | 中 | **v6** | §6 |
| C4 | 画像の位置・拡大 | 中 | **v6** | §6 |
| C5 | ワークエリア（再生・出力範囲） | 中 | **v6** | §6, B3 |
| C6 | 紙面の縦書き | 中 | **v6** | §6 |
| D1 | 素材同梱の`.conte.zip` | 大 | 不要 | R18/R19 |
| D2 | 紙面PNGの逐次ZIP | 小 | 不要 | なし |
| D3 | 紙面のプリセット | 小 | 不要 | なし |
| D4 | 共有用のHTML書き出し | 中 | 不要 | なし |
| E1 | 保存を止めない（分割シリアライズ） | 中 | 不要 | なし |
| E2 | 保存・GCの直列化（R05） | 中 | 不要 | なし |
| E3 | Animatic出力の内容固定 | 小 | 不要 | なし |
| E4 | 複数タブの排他 | 中 | 不要 | E2 |

## 3. A群 — 操作感

### A1 コマの左端（境界）ドラッグ

**現状** `clips()`が作る`.clip`の右端にだけ`.handle`があり、`startResize()`が
そのPanelの`frames`を変える。左端はつかめない。

**設計** Panelは開始位置を持たず`frames`だけを持つので、左端は「前のPanelとの境界」
である。境界を動かす操作として定義し、**合計尺を変えない**。

- 左端を右へ動かす → 前のPanelが伸び、自分が同じだけ縮む
- 左端を左へ動かす → 前のPanelが縮み、自分が同じだけ伸びる
- どちらも1f未満にはできない。先頭Panelには左ハンドルを出さない
- 「前」は`flatten()`の全体順序で決める。Shot / Sceneをまたいでもよい

**変更**

- `src/application/commands.js` に `setBoundary({ leftId, rightId, leftFrames })`
  を追加する。2つのPanelの`frames`を同じ確定編集で変え、合計を保つ。
  `kinds: ["timing"]`、`panelIds: [leftId, rightId]`。
- `src/app.js` の `clips()` で`.handle.start`を追加（先頭Panel以外）。
  `startResize()`を`edge`引数つきに一般化し、左端では境界の絶対フレームを
  スナップ対象へ吸着させてから`setBoundary`を1回実行する。

**検証** Node: 合計尺が不変、1f未満を拒否、Undoで両方戻る、Anchor音声の絶対位置が
前のPanelの尺に追随する。browser smoke: 左端ドラッグで前後のラベルが変わり、
最終フレームが変わらないこと。

### A2 数値ドラッグ中のライブ表示

**現状** `ui/number-scrub.js`はドラッグ中は表示だけを動かし、離したときに1回
`change`を出す。Cameraの値を動かしている間、Stageは変わらない。

**設計** 履歴の粒度は変えない。確定しないままStageだけを一時的な値で描く。

- `src/app.js` に `let previewValues = null; // { panelId, camera:{x,y,zoom,rotation} }`
  を置き、`paint()`がこれを見て`cameraAt()`の結果へ上書きして描く。
- `scrubNumber(input, { onPreview, onCancel })` を拡張し、Camera の4入力に接続する。
  確定・中止のどちらでも`previewValues = null`に戻す。

**やらないこと** ドラッグ中に`edit`を繰り返して履歴をまとめる方式は採らない。
履歴を後から結合するAPI（`Store.edit(fn, { merge: true })`）が必要になり、
Undoの意味が変わる。必要になったら別項目として計画する。

**検証** browser smoke: Cameraのzoomをドラッグしている最中にStageの画素が変わり、
PointerCancelで元へ戻り、履歴が増えていないこと。

### A3 スナップ対象の追加とガイド線

**現状** `timeline.snapTargets(rows, fps, end, playhead)`はPanel境界・秒・
再生ヘッド・0・終端を返す。音クリップの端とCameraキーは対象外。吸着しても
どこへ吸ったかは見えない。

**変更**

- `src/timeline.js` の `snapTargets` へ省略可能な第5引数
  `{ clips = [], keys = [] }` を足す。既存の呼び出しはそのまま動く。
  `clips`は`resolveClips()`の結果、`keys`はCameraキーの絶対フレーム。
- `snap()`は吸着した対象値も返せるようにする（`snapAt(frame, targets, scale)`を
  追加し、既存の`snap()`はその薄い包みにする）。
- `src/app.js` はドラッグ中、吸着したフレーム位置へ`.snapline`を出す。

**検証** Node（`tests/timeline.test.js`）: 音の端とCameraキーが対象に入ること、
許容範囲の外では吸着しないこと、対象が増えても`snap`の優先順位（最も近い）が
変わらないこと。browser smoke: 音クリップの端へコマの端が吸着し、線が出ること。

### A4 ドラッグ中の自動スクロール

**現状** Strip・Timelineのドラッグは、見えている範囲の外へは運べない。

**変更** `src/ui/auto-scroll.js` を新設する。

```js
const stop = autoScroll(container, { edge: 40, speed: 12 });
// pointermoveごとに stop.track(clientX) を呼び、離すときに stop() する
```

RequestAnimationFrameで`scrollLeft`を送り、端からの距離で速度を決める。
`startReorder`（Strip）、`startClipReorder`・`startClipDrag`（Timeline）から使う。

**検証** browser smoke: 端へポインタを寄せたまま`scrollLeft`が増えること、
離すと止まること。

### A5 選択の拡張

**現状** 矢印キーは1つ隣へ選択を移すだけ。範囲選択はShift＋クリックのみ。

**変更** `src/app.js` のkeydownへ追加する。

- `Shift+←/→` 選択範囲を伸ばす・縮める（全体順序で連続した範囲）
- `Ctrl/Cmd+←/→` 前後のShotの先頭へ
- `Home / End` 最初・最後のPanelへ

いずれも`EditorController.select()`を通すので、履歴も保存も動かない。

**検証** browser smoke: Shift＋矢印で`#strip button.selected`が増減すること、
Ctrl＋矢印でShotをまたぐこと。

### A6 Sceneの開閉状態を覚える

**現状** `renderTree` / `markTree` が毎回`details.open = (アクティブなScene)`を
書くので、別のSceneを開いておけない。

**変更** `const openScenes = new Set()`（実行時のみ）を持ち、`summary`の`toggle`で
更新する。アクティブなSceneは常に開く。Project差し替えで空にする。

**注意** これは挙動の変更である。「選択したSceneだけが開く」現状に依存した
使い方があるかを確認してから入れる。

**検証** browser smoke: 2つ目のSceneを開いたまま1つ目のPanelを選んでも開いたまま、
Project差し替えで初期状態に戻ること。

### A7 Undo/Redoの内容表示

**現状** `Store.past` / `future` は`{ p, selection }`しか持たないので、
「何を元に戻すのか」を出せない。

**変更**

- `src/model.js` の `Store.edit(fn, kind)` が履歴へ`kind`も積む。
  `undo()` / `redo()` は戻した操作の`kind`を結果へ含める。
- `src/editor-session.js` はその`kind`を`undoneKind`として結果へ渡す。
- `src/app.js` は状態表示へ「元に戻す：尺の変更」のように出す。
  表示名はCommand名からの辞書を`src/application/commands.js`へ置く。

**注意** `Store`の履歴の形が変わる。保存形式ではないので互換の心配はないが、
`tests/model.test.js` と `tests/stability.test.js` の履歴比較に影響する。

**検証** Node: 編集→Undoで戻した操作の種類が取れること、無変更操作が履歴へ
積まれないこと。

### A8 数値のホイールとTab移動

**変更** `ui/number-scrub.js` に`wheel`を足す。フォーカスがあるときだけ
`preventDefault()`してページのスクロールを奪わない。刻みと修飾キーはドラッグと同じ。

**検証** Node（`scrubValue`の再利用なので追加は最小）、browser smoke:
フォーカス時のみ値が変わり、非フォーカス時はページが動くこと。

### A9 Timelineの行の高さ切り替え

**現状** 行の位置は`style.css`の`#clips`(28px) / `#cameraTrack`(86px) /
`#audioTrack`(116px) と`app.js`の`LANE_HEIGHT = 26`に分かれて書かれている。
`#rowNames`の各行もこの値に合わせてある。

**変更** すべてCSSカスタムプロパティへ移す（`--row-clip`, `--row-camera`,
`--row-audio`, `--lane-h`）。`app.js`は`getComputedStyle`から`--lane-h`を読む。
Timelineのバーに「行の高さ：小／中／大」を置き、`layout`と同じ仕組みで保存する。

**注意** この整理はA9をやらなくても価値がある（今は2箇所に同じ数字がある）。
先に「定数の一本化」だけ切り出してもよい。

**検証** browser smoke: 高さを変えても行名の列と時間グラフがずれないこと、
再読み込みで保たれること。

### A10 Cameraキーの複数選択

**現状** `cameraKey`は単一のindex。`setCameraValues` / `deleteCameraKey`も単一。

**変更** 選択を`Set<number>`（またはt値の集合）にし、Cameraトラック上での
矩形ドラッグで選ぶ。Commandを複数対応へ広げる。

- `setCameraValues({ panelId, indexes, values })`
- `deleteCameraKey({ panelId, indexes })`
- `moveCameraKeys({ panelId, indexes, deltaT })`

**注意** キーは並べ替えで index が変わる。複数操作の間はt値で持ち、確定時に
indexへ直す。`cameraKeyIndex(b, t)`が既にある。

**検証** Node: 複数キーの一括移動で順序と値が保たれること、重なったキーの扱い。

## 4. B群 — できること（保存形式はそのまま）

### B1 尺の管理

**変更** `src/derived/duration.js` を新設し、純粋関数として置く。

```js
summary(p, rows)      // { frames, seconds, panels, shots, scenes }
byShot(p, rows)       // [{ sceneId, shotId, frames, seconds, panels }]
selectionTotal(rows, ids)
gapTo(target, frames, fps)  // 目標尺との差（+ / -）
```

UIはTimelineのバーに総尺と目標尺の差、構成タブにShotごとの内訳を出す。
目標尺は実行時の入力（保存しない）。保存したくなったらC群へ。

**検証** Node: 端数の秒換算、空Shotがない前提の確認、2000 Panelでの計算時間。

### B2 台詞・注記の検索

**変更** `src/derived/search.js` に `searchPanels(p, query, { fields })` を置く。
`dialogue` / `sound` / `notes` / Scene名 / Shot名を対象に、
一致位置つきの行を返す。UIは`Ctrl+F`で開く小さな入力と結果一覧。選ぶと
`EditorController.select()`でジャンプする。

**検証** Node: 全角・半角、大文字小文字、複数一致の順序。browser smoke:
検索してジャンプし、Escで閉じること。

### B3 範囲再生・Shotループ

**現状** 再生は`$("play").onclick`の中で`endFrame()`まで進む。範囲の概念がない。

**変更** 再生の状態を`{ from, to, loop }`へ広げる。

- 「選択範囲だけ再生」＝`timeline.selectionRange(rows, ids)`
- 「このShotをループ」＝現在のShotの先頭から末尾
- 音の予約も`scheduleFor(resolved, from, fps, to)`で範囲を渡す（引数は既にある）

**注意** 再生制御は将来`application/playback-controller.js`（R15）へ移す。
ここでは`app.js`の中に閉じた状態として足し、R15で持っていく。

**検証** browser smoke: ループ再生で再生ヘッドが範囲の先頭へ戻ること、
停止で音が残らないこと。

### B4 Cameraキーのコピー／貼り付け

**変更**

- `src/app.js` に実行時のクリップボード（`cameraClipboard`）を持つ。
- `src/application/commands.js` に
  `pasteCameraKeys({ panelId, keys, mode: "replace" | "merge" })` を追加する。
  `replace`は既存キーを捨てて置き換え、`merge`は同じtのキーだけ上書きする。
  キーはtの比率なので、尺が違うPanelへ貼っても動きの形は保たれる。

**検証** Node: 比率が保たれること、`replace`でキーが1本以上残ること（0本にしない）、
Undoで戻ること。

### B5 画像の差し替え

**現状** 画像は取り込みと削除だけ。差し替えるには外して入れ直す必要がある。
音声はR07で新Asset IDへ付け替える方式になっている。

**変更** 同じ形にそろえる。

- `src/application/commands.js` に
  `replacePanelImage({ panelIds, asset, opacity })` を追加。新しいAsset IDを
  参照へ入れ、使われなくなった画像メタデータは`clearPanelImage`と同じ規則で外す。
- `src/app.js` はImportControllerの`key: "image:" + panelId`で取り込む。

**検証** Node: Undoで元の画像へ戻ること、他のPanelが同じ素材を使っていれば
メタデータが残ること。browser smoke: 差し替え→Undo。

### B6 尺の一括設定・等分

**変更** `distributeFrames({ ids, total })` を追加する。合計を指定して等分し、
端数は先頭から1fずつ配る（決め方を1つに固定する）。既存の`setPanelFrames`は
既に複数対応なので、「全部同じ尺にする」はそのまま使える。

**検証** Node: 合計が指定値と一致、1f未満を作らない、端数の配り方が決まっていること。

### B7 直線・矩形・矢印ツール

**現状** Strokeは`points`の列なので、直線も矩形も矢印も**今の形式のまま**表現できる。

**変更** ツール選択（ブラシ／消しゴムの隣）と、`pointerdown`→`pointerup`で
図形のpointsを生成する処理を`src/ui/shape-tools.js`に置く。

- 直線 = 2点
- 矩形 = 5点（閉じる）
- 矢印 = 本体2点 + かえし2本（3本のStrokeを1回の編集で足す）

`addStroke`コマンドを複数Stroke対応（`addStrokes({ panelId, strokes })`）へ広げる。

**検証** Node: 図形生成の純粋関数（Shift併用で水平・垂直・45度に吸着）。
browser smoke: 直線1本が履歴1段で入ること。

### B8 プレゼンモード

**変更** `body.presenting`クラスでStageだけを見せるレイアウトにし、
`←/→`でコマ送り、`Space`で再生、`Esc`で戻る。Fullscreen APIは任意（失敗しても
クラスだけで成立させる）。

**検証** browser smoke: クラスの付与と解除、キー操作でPanelが進むこと。
実際の全画面表示はヘッドレスで確認できないため「未確認」と記録する。

### B9 保存履歴から選んで復元

**現状** 起動時に`repo.latest()`の1件だけを提示する。過去の世代は`repo.list()`で
取れるが、UIがない。

**変更** 復旧Dialogに一覧を出す。各行は保存時刻・種別（自動／手動）・Panel数・
サイズ。選ぶと`repo.load(id)`して差し替える。読めない世代は理由つきで灰色にし、
削除はしない。

**注意** 復元は`replaceStore`＋`loadImages`の既存経路を使う。E2（保存とGCの直列化）
の後に入れると、一覧を見ている間の整理と競合しない。

**検証** Node（`tests/repository.test.js`）: 一覧の並びと壊れた世代の扱い。
browser smoke: 2世代作って古い方を復元できること。

### B10 複製・貼り付けで音も持ち運ぶ

**現状** `duplicatePanels`も`pastePanels`もPanelだけを複製し、Anchor音声は
複製しない。

**変更** 対象PanelにAnchorされたクリップも一緒に複製する選択肢を足す。

- `duplicatePanels({ ids, withAudio })`：内部で新旧IDの対応表を作り、
  `audio.duplicateClipsFor(p, idMap)`（`src/audio.js`へ追加）で複製する。
- `pastePanels({ ..., clips })`：クリップボードに音の情報も持たせる。
  素材メタデータの持ち運びは画像と同じ規則にする。

**注意** 今の`duplicatePanels`は`uid()`をCommandの中で作るので、対応表を返せる
形（生成したIDを引数で受ける、または`targets`で返す）へ変える必要がある。

**検証** Node: 音つき複製でクリップ数とAnchorが正しいこと、`withAudio`なしで
現状と同じであること、Undoで戻ること。

## 5. D群 — 出力・持ち運び

### D1 素材同梱の`.conte.zip`

構造改善計画のR18（writer）／R19（reader）をそのまま使う。仕様・検証・失敗時の
境界はあちらに書いてある。この計画では順序（§7）だけを決める。

### D2 紙面PNGの逐次ZIP

**現状** `app.js`の`$("png").onclick`は全ページのバイトを`files`配列へ貯めてから
`zip(files)`する。Animaticは既に`ZipBuilder`へ1枚ずつ追加している。

**変更** 紙面も`ZipBuilder`へ寄せる。1ページ描く→PNGにする→`builder.add()`→
Canvasを捨てる、の順にする。R17（Sink）の前段として、保持量だけ先に減らす。

**検証** browser smoke: 既存のZIP出力の検査（ファイル名・枚数）をそのまま通すこと。
可能なら`performance.memory`ではなく「保持している配列の長さ」で確認する。

### D3 紙面のプリセット

**現状** 用紙・向き・コマ数・余白・文字サイズ・列は既に設定できる。足りないのは
「よく使う組み合わせを呼び出す」こと。

**変更** プリセット（名前＋PaperSettings）を`repo.setLayout`と同じ`meta`ストアへ
保存する。Projectには入れない。既定のプリセットを2〜3個同梱する。

**検証** Node（`tests/repository.test.js`）: 保存と読み出し。browser smoke: 選択で
プレビューが変わること。

### D4 共有用のHTML書き出し

**変更** 1ファイルのHTMLへ、紙面のページ画像をdata URIで埋めて書き出す。
相手はブラウザで開くだけで見られる。ページめくりと印刷だけを持つ最小の作り。

**注意** サイズが大きくなる。ページ数×PNGサイズをそのまま抱えるので、
上限（例：60MB）を超えるときは事前に拒否して理由を出す。

**検証** Node: 生成したHTMLのdata URIが正しい形であること。browser smoke:
書き出したHTMLを開いてページ数が一致すること。

## 6. C群 — 保存形式を変える（Project v6）

C1〜C6はすべてProjectの構造を増やす。**1回の移行にまとめる**。バラバラに上げると
旧ファイルの互換確認が回数分増え、途中のVersionで書いたファイルが残る。

### 6.1 v6で増える項目

| 項目 | 場所 | 既定値 | 用途 |
|---|---|---|---|
| `markers` | Project直下 | `[]` | C1。`{ id, anchor, at, text, color }`。音声Clipと同じくPanelへAnchorする |
| `label` | Panel | `null` | C2。ラベル色のキー（固定の色表から選ぶ） |
| `ease` | CameraKey | `"linear"` | C3。`"linear" \| "easeIn" \| "easeOut" \| "easeInOut"` |
| `fit` / `offset` / `scale` | Panel.image | `"contain"` / `{x:0,y:0}` / `1` | C4。画像の収め方と位置 |
| `workArea` | Project直下 | `null` | C5。`{ from, to }`。再生と出力の既定範囲 |
| `vertical` | PaperSettings | `false` | C6。縦書き |

### 6.2 移行と検証

```js
// src/model.js
5: (p) => ({
  ...p,
  version: 6,
  markers: [],
  workArea: null,
  paper: { ...p.paper, vertical: false },
  scenes: p.scenes.map((s) => ({
    ...s,
    shots: s.shots.map((h) => ({
      ...h,
      panels: h.panels.map((b) => ({
        ...b,
        label: null,
        image: b.image ? { ...b.image, fit: "contain", offset: { x: 0, y: 0 }, scale: 1 } : null,
        camera: b.camera.map((k) => ({ ...k, ease: "linear" })),
      })),
    })),
  })),
}),
```

- `validate()`へ新項目の検査を足す。既定値のまま保存されたv6は、v5から移行した
  ものと同じ形になること。
- `sameProject()`へ新項目の比較を足す。ここを忘れると「変えたのに無変更」に
  なって保存されない。
- `cameraAt()`に`ease`を適用する。`"linear"`は現行と同じ式になることを試験で
  固定する（既存ファイルの再生位置・紙面の軌道・Animaticのフレームが1つも
  変わらないこと）。
- `flatten`・`resolveClips`・`layoutPages`・`renderFrame`は形が変わらない。
- 旧アプリでv6を開くと「未対応のプロジェクトVersion」で拒否される。これは
  既存の契約どおりで、壊れた読み込みにはしない。

### 6.3 コミットの切り方

1. **移行だけ**（migration + validate + sameProject + 既定値 + 互換試験）。
   UIは何も変わらない。ここで`tests/migration.test.js`へv5→v6を足す。
2. C2 ラベル色（小）— Tree・Strip・Timelineの色分け。
3. C1 マーカー（中）— Timelineの新しい行、Inspector、紙面への注記。
4. C5 ワークエリア（中）— B3の範囲再生をここへ接続し、出力の既定範囲にする。
5. C4 画像の位置・拡大（中）— Stage上のドラッグ。`drawing.drawImageInto`を拡張。
6. C3 イージング（中）— Cameraキーの右クリックメニューか、Inspectorの選択。
   `describeCamera`の表記に緩急を足すかは別途決める。
7. C6 紙面の縦書き（中）— `paper.js`の折返しと列の向き。

### 6.4 やらないこと

- 全ProjectのID正規化、Undoのコマンドログ化、音声offsetの単位変更は
  このv6に含めない（構造改善計画§18.10のまま）。
- v6で増える項目に「あとで意味を変える」余地を残さない。使い道が決まっていない
  項目は入れない。

## 7. E群 — 足回り

### E1 保存を止めない（分割シリアライズ）

**現状（実測）** 2000 Panelで`JSON.stringify`だけで236ms、保存全体で648ms
メインスレッドを止める。自動保存は連続編集中も4秒ごとに走る。

**変更** `src/serialize.js` を新設する。

```js
// Scene単位で文字列を作り、間で制御を返す。結果はJSON.stringifyと同じ文字列。
export async function serializeProject(p, { yieldEvery = 1, signal } = {})
```

`Autosaver`がこれを使う。`ProjectRepository.save()`は文字列を受け取れる形
（`save(p, { kind, json })`）にして、二重にJSON化しない。

**検証** Node: 生成した文字列が`JSON.stringify(p)`と**同一**であること（100 /
500 / 2000 Panel、画像・音声つき）、`load()`を通ること、中断できること。
browser smoke: 2000 Panelの自動保存中に、描画の応答が止まらないこと（長タスクの
最大値を記録する）。

**注意** 速くはならない。止まらなくなるだけである。目的を取り違えない。

### E2 保存・GCの直列化（R05）

構造改善計画のR05そのもの。`persist()`の`pruneAssets`とAutosaverの`save()`→
`#prune()`が同時に走りうる現状を、Repository内の直列キューへ寄せる。
Import・Export・保存中の原本を保護集合へ登録する。詳細はあちらに従う。

### E3 Animatic出力の内容固定

**現状** `animaticFrames()`はループの中で可変の`rows`と`images`を読み、
`animaticRecord()`は`resolved`・`store.p.fps`・`endFrame()`を読む
（`src/app.js`）。紙面出力は開始時に`exportProject` / `exportPaper` /
`exportImages`を固定している。

**変更** Animaticも開始時に固定する。Dialogはmodalなので手操作は入らないが、
遅い素材取り込みの完了は今もコミットされるため、出力の途中で絵が変わりうる。

**検証** browser smoke: 出力中に画像取り込みを完了させても、出力された絵が
開始時の内容であること（フレームの画素で確認する）。

### E4 複数タブの排他

**現状** 書き込みと永続GCのタブ間排他がないため、破壊的なGCを保留している
（構造改善計画§8.3）。

**変更** `navigator.locks`（Web Locks）で「書き込み」「GC」の名前つきロックを取る。
`BroadcastChannel`で他タブへ保存の発生を知らせ、復旧候補の提示を重複させない。
Web Locksが無い環境では今までどおり保留する。

**検証** 2つのページを開いた実ブラウザで、同時保存が直列化されること、
一方のGCが他方の未保存状態を壊さないこと。ヘッドレスでも2ページで確認できる。

## 8. 既存計画（R番号）との重なり

| この計画 | 構造改善計画 | 扱い |
|---|---|---|
| E2 | R05 | 同一。R05として実装し、ここからは参照するだけ |
| E3 | R16の一部 | R16全体（ExportController）より先に、内容固定だけ取る |
| D2 | R17の前段 | Sinkの前に保持量を減らす。R17でSinkへ置き換える |
| D1 | R18 / R19 | 同一 |
| B3 / C5 | R15 | 再生範囲は先に`app.js`へ入れ、R15でPlaybackControllerへ移す |
| A9 | R12 | 行の高さの定数一本化はR12（部分更新）の前にやると楽 |
| A2 | R13 | ライブ表示はStageキャッシュ（R13）と衝突しない範囲に留める |

同じファイルを同時に触らない。`src/model.js`はA7・C群が、`src/app.js`はほぼ全部が
触るので、1項目ずつ統合する。

## 9. 順序とリリース境界

日数は見積もらない。依存と「壊れたときの影響」で並べている。

| 境界 | 含める | ユーザーが受け取るもの |
|---|---|---|
| **S5 触り心地** | A1, A3, A4, A5, A8, B4, B5, B6 | 境界をつまむ、吸着が見える、端まで運べる、選択が伸びる、Cameraと画像を付け替えられる |
| **S6 事故を減らす** | E3, E1, E2 | 出力が混ざらない。大きい作品で固まらない。素材とスナップショットが消えない |
| **S7 見通し** | B1, B2, B9, A6, A7, A9, D2, D3 | 尺が見える、探せる、戻せる、紙面の設定を使い回せる |
| **S8 描く・見せる** | B7, B8, B10, A2, A10 | 図形が描ける、見せられる、音つきで複製できる |
| **S9 v6** | §6.3の順（移行 → C2 → C1 → C5 → C4 → C3 → C6） | マーカー・ラベル色・範囲・画像調整・緩急・縦書き |
| **S10 持ち運び** | D1, D4 | 素材ごと渡せる。相手はブラウザで見るだけ |

**S5とS6は並行できる。** S5はUIとCommand、S6は保存と出力で、触るファイルが
ほとんど重ならない（`app.js`の接続だけ順番に統合する）。

**S9（v6）はS6の後に置く。** 保存の足回りが不安定なまま保存形式を変えない。

## 10. 各項目の完了条件（共通）

1. 対象のNodeテストとbrowser smokeが通る。`npm run build`が通る。
2. 挙動を変えた場合は、変えた理由と旧挙動をコミットメッセージに書く。
3. 実ブラウザで確認できなかった部分を明記する（全画面、複数タブ、実機のペン入力、
   実プリンターなど）。
4. 形式に触った場合は、旧ファイルの読み込みと、出力（紙面・Animatic）の結果が
   変わらないことを試験で示す。
5. `docs/ARCHITECTURE.md`の該当箇所を、実装した範囲だけ更新する。

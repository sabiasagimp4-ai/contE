# contE 現行アーキテクチャ

この文書は、現在 `main` に存在する contE の実装構造だけを記録する。将来の設計案、採用を決めていないデスクトップ技術、未実装機能の仕様は含めない。コードを読むときの入口として、責務の境界、データの流れ、保存形式、UIイベント、テスト対象を一つにまとめる。

最終更新: 2026-09-14

## 1. 実行形態

contE は、Node.jsで静的ファイルを配信してブラウザで実行する、依存ライブラリなしのES Modulesアプリである。

```text
npm start
  └─ scripts/serve.mjs
       └─ index.html + style.css + src/*.js
            └─ ブラウザ
                 ├─ Project/編集状態（メモリ）
                 ├─ Canvas / DOM UI
                 ├─ IndexedDB（自動保存・素材）
                 ├─ Web Audio（再生・波形）
                 └─ MediaRecorder（WebM録画）
```

`npm run build` は `index.html`、`style.css`、`src/` を `dist/` にコピーするだけで、バンドルやトランスパイルは行わない。実行時の外部依存はない。Playwright、Chromium、Nodeのテスト用APIは検証環境だけが使用し、配布物には含まれない。

ブラウザ起動時の大まかな順序は次のとおり。

1. `src/app.js` が `EditorSession`（内部の`Store`を含む）、`AudioEngine`、表示用Map、編集状態を生成する。
2. 初期Projectを使って最初の `render()` を行う。
3. `ProjectRepository` をIndexedDBまたはMemoryStorageへ接続する。
4. 保存済みレイアウトを読み込む。
5. 最新の復旧候補を調べ、存在すれば復旧ダイアログを表示する。
6. 画像と音声のバイナリを別ストアから読み込み、表示・波形・再生キャッシュへ入れる。

IndexedDBが利用できない場合、UI編集は継続し、保存層だけが `MemoryStorage` に切り替わる。その場合、ブラウザを閉じた後の永続復旧はできない。

## 2. ディレクトリと責務

| パス | 現在の責務 |
|---|---|
| `index.html` | UIのDOM骨格。Toolbar、Canvas、Panel strip、Inspector、Timeline、紙コンテDialog、Animatic Dialog、復旧Dialogを定義。各領域は`data-dock`/`data-body`でパネルとして印を付ける |
| `style.css` | After Effects風のパネルUI。色のカスタムプロパティ、パネルとタブ、Timelineの行、Dialog、印刷用スタイル、レスポンシブ境界 |
| `src/app.js` | UIイベント、表示更新、ファイル選択、再生、Dialog、保存の接続。現在のアプリケーション統合層 |
| `src/editor-session.js` | 現在の`Store`の寿命、編集/選択/Undo/Redoの結果、変更範囲、実行時Session IDとrevision、Project差し替え後の古い非同期処理の識別 |
| `src/application/commands.js` | UI操作をStoreの一回の編集として表すコマンド集。DOM・Storage・awaitを持たない |
| `src/application/editor-controller.js` | コマンド実行、選択、Undo/Redo、Project差し替えの入口と、確定編集ごとの通知 |
| `src/application/import-controller.js` | 素材取り込みの非同期規約。開始時の対象固定、追い越し、作品切替時の破棄と解放 |
| `src/ui/number-scrub.js` | 数値入力の横ドラッグ（AEのホットテキスト）。値の計算はDOMを持たない純粋関数 |
| `src/ui/docks.js` | パネルの出し入れ。どのパネルを開き、どれを前面にするかだけを持つ |
| `src/ui/shortcuts.js` | キー操作の表。効くキーと画面に出る説明の唯一の出どころ |
| `src/ui/menu.js` | 押したときだけ出るメニュー。開いているのは常に1つ |
| `src/ui/panels.js` | パネルの表・ウィンドウメニューの並び・作業レイアウト。データだけ |
| `src/model.js` | Projectの生成・検証・Migration・履歴・選択・Panel移動・Cameraキー・紙面設定検証 |
| `src/playback.js` | 時刻からPanelを引く純粋関数。再生時計と二分探索 |
| `src/timeline.js` | Timelineのフレーム/px変換、可視Panel、目盛、スナップ、Zoom、追従、選択範囲 |
| `src/drawing.js` | Stroke、筆圧、消しゴム、画像、Camera/View変換をCanvasへ描くAdapter |
| `src/audio.js` | 音声クリップの解決、位置計算、予約、紙面用注記、波形ピーク、音声素材整理、Web Audio Engine |
| `src/paper.js` | 紙面の幾何、列テキスト、折返し、続き行、Camera表記、Canvasページ描画 |
| `src/exporter.js` | ページ/フレームの逐次処理、進捗、中止、ZIP、CRC32、Canvas→PNG変換 |
| `src/animatic.js` | Animaticのfps・解像度計画、Playbackと共通のフレーム評価、MediaRecorder補助 |
| `src/storage.js` | `MemoryStorage` と `IndexedDbStorage`。保存先のキー/値操作と複数Storeのbatch確定だけを担当 |
| `src/repository.js` | Snapshot、Project JSON、Asset、Quota再試行、復旧候補、Autosaverを統合 |
| `scripts/serve.mjs` | ローカル静的サーバー。127.0.0.1へ配信 |
| `scripts/build.mjs` | 実行に必要な静的ファイルを `dist/` へコピー |
| `scripts/bench.mjs` | Node上のモデル、保存、Timeline、紙面処理の簡易ベンチマーク |
| `scripts/browser-smoke.mjs` | Playwrightで描画、Panel、Timeline、音、紙、Animatic、復旧を通すE2E |
| `tests/*.test.js` | Node標準Test Runnerによる純粋関数・モデル・保存・出力のテスト |
| `docs/` | ロードマップ、開発サイクル、デスクトップ調査、現行構造資料 |

`app.js` は描画エンジンや保存エンジンそのものを実装するのではなく、DOMイベントと各モジュールを接続する統合層である。編集の計算は`src/application/commands.js`へ移したが、UIの状態管理、表示再構築、出力Dialogは同じファイルにあるため、現時点でも最も責務が集まっているファイルである。

`editor-session.js` と `src/application/` はDOM、IndexedDB、Web Audioを知らない。`EditorSession`は`Store`を保持し、編集結果に`kind`、変更有無、選択変更有無、確定した変更範囲、Session ID、revisionを付けて返す。`EditorController`がその結果を購読者へ一度だけ通知し、`app.js`がdirty化・自動保存予約・頭出し・DOM再構築を行う。Projectの差し替えではSession IDを更新し、素材取り込みは`ImportController`が開始時の対象とSessionを照合してから適用する。

## 3. Projectデータモデル

Project JSONの現在のVersionは **5**。画像・音声のバイナリはJSONに入らず、JSON内にはAsset IDとメタデータだけが入る。

```text
Project
├─ version: 5
├─ title: string
├─ fps: integer 1..120
├─ assets: AssetMeta[]
├─ audio: AudioClip[]
├─ paper: PaperSettings
└─ scenes: Scene[]
   └─ Scene
      ├─ id: string
      ├─ name: string
      └─ shots: Shot[]
         └─ Shot
            ├─ id: string
            ├─ name: string
            └─ panels: Panel[]
```

### 3.1 Panel

```js
{
  id: string,
  frames: integer,              // 1..864000
  dialogue: string,
  sound: string,                // 紙面用の手入力注記
  notes: string,
  strokes: Stroke[],
  image: null | { assetId, opacity },
  camera: CameraKey[]
}
```

`frames` はPanelの尺で、Project全体の時間はScene/Shot順にPanelを連結した値になる。Panelは最低1つ必要で、空Shotと空Sceneは検証で拒否される。

### 3.2 描画とCamera

```js
Stroke = {
  size: number,                 // BRUSH.min..BRUSH.max
  erase: boolean,
  points: Array<[x, y, pressure]>
}

CameraKey = {
  t: number,                    // Panel内の0..1の比率
  x: number,
  y: number,
  zoom: number,                 // 0.1..10
  rotation: number
}
```

Strokeの座標は0..1の正規化座標、筆圧も0..1で保存する。描画解像度に依存しないため、Canvas、サムネイル、紙面、Animaticで同じStrokeを使える。消しゴムStrokeも同じ配列に保存し、描画時の合成モードだけを変える。

CameraはPanelのフレーム番号ではなく比率 `t` で保存する。尺を変更してもキー間の相対位置が保たれ、再生、Inspector、紙面表記、Animaticは `cameraAt()` の線形補間を共有する。`setCameraKey()` は同じ時刻のキーを置換し、`moveCameraKey()` は衝突したキーを統合し、最後の1本は `removeCameraKey()` で削除できない。

### 3.3 AssetMetaとAudioClip

```js
AssetMeta = {
  id: string,
  kind: "image" | "audio",
  name: string,
  mime: string,
  bytes: integer,
  width?: integer,               // image
  height?: integer               // image
}

AudioClip = {
  id: string,
  assetId: string,
  track: "dialogue" | "se" | "bgm",
  anchor: Panel.id,
  at: integer,                   // anchor Panel開始からの相対フレーム
  frames: integer,
  offset: integer,               // 音声素材内の開始フレーム
  gain: number                   // 0..4
}
```

音声Clipは絶対フレームではなく、開始位置を含むPanelのIDと相対フレームで持つ。前のPanelの尺が変わるとClipも移動し、Anchor Panelが削除されると `pruneClips()` でClipも削除される。再生用の絶対位置は `resolveClips()` が毎回計算する。

### 3.4 PaperSettings

```js
{
  size: "A4" | "A3" | "B4" | "letter",
  orientation: "portrait" | "landscape",
  rows: 1..12,
  margin: number,
  font: number,
  header: string,
  footer: string,
  columns: [{ key, width }],
  duration: boolean,
  numbers: boolean,
  cameraMarks: boolean
}
```

列の順番と幅は設定値に従い、`cut`、`image`、`dialogue`、`sound`、`notes`、`camera`を任意の順番で表示できる。Projectに保存されるため、紙面設定の変更もUndo/Redo、自動保存、復旧の対象になる。

## 4. 検証・Migration・履歴

### 4.1 `validate()`

`model.js` の `validate()` は保存前、読み込み後、`Store.edit()` の適用前後に実行される。主な検証対象は以下。

- Version、fps、title、Scene/Shot/Panelの存在
- 全IDの型と重複
- Panelの尺、文字フィールド、Stroke形式、筆圧、座標範囲
- Cameraキーの比率、Zoom範囲、数値の有限性
- 画像参照がProject内のAssetを指していること
- PaperSettingsの用紙、行数、余白、列の重複と幅
- AudioClipのTrack、Asset、Anchor Panel、尺、Offset、Gain

検証済みのStroke配列は `WeakSet` で再検証を省略し、Stroke・points・各点をfreezeする。履歴から共有された描画配列を後から変更できないようにするためである。

### 4.2 Migration

`load()` はJSONをparseし、`migrate()`を通してから`validate()`する。

```text
v1 → v2  assets / panel.image を追加
v2 → v3  Shot名、Strokeのsize/erase/pressure形式を追加
v3 → v4  audio配列を追加
v4 → v5  paper設定を追加
```

Migrationは入力オブジェクトを直接変更せず、新しいオブジェクトを返す。未知Version、壊れたJSON、配列やnullなどProjectとして解釈できない値は拒否する。

### 4.3 StoreとUndo/Redo

`Store` は現在の `p`、現在の `selection`、`past`、`future` を持つ。

```text
Store
├─ p: Project
├─ selection: { active: Panel.id, ids: Panel.id[] }
├─ past:    [{ p, selection }]
└─ future:  [{ p, selection }]
```

`edit(fn)` はProjectを浅い構造コピーし、Assets、Paper、Audio、Scene、Shot、Panel、Cameraを編集可能な深さまで複製する。編集関数を実行し、検証し、`sameProject()`で変更の有無を判定する。

- 変更あり: 現在値をpastへ入れ、futureを消し、新Projectをcurrentにする。
- 変更なし: 履歴段数を消費せず、必要なら選択だけを正規化する。
- 検証失敗: current、past、futureを変更しない。
- Undo/Redo: Projectとselectionを同時に戻す。
- 履歴上限: 80段階。
- `normalizeSelection()` はactiveがids外にならないよう、残った選択Panelへ移す。

UI側の`edit()`は、変更があれば再生を停止し、dirtyを立て、自動保存を予約して`render()`する。変更のない操作は保存と履歴を発生させない。

### 4.4 EditorSessionとEditorController

`EditorSession`は実行中のProjectを開いている単位を表す。JSONへ保存するProject Versionとは別の、実行時だけの識別情報を持つ。

```text
EditorSession
├─ store: Store
├─ sessionId: string
└─ revision: integer
```

`edit()`、`undo()`、`redo()`はStoreの既存の検証・履歴処理を呼び、変更が確定した場合だけrevisionを1増やす。選択だけの変更は`selectionChanged`として返すが、Project revisionは増やさない。無変更操作は履歴とrevisionを消費しない。`replace()`は新しいStoreを作り、Session IDを更新してrevisionを0へ戻す。

非同期処理は`capture()`でSession IDとrevisionを取得し、完了時に`isCurrent()`または`isCurrentRevision()`を確認できる。古いSessionの素材読み込み結果は、キャッシュへの取得処理が完了しても現在画面の`render()`を呼ばない。保存完了やAsset GCはrevisionが一致するときだけ最新状態へ反映する。Sessionはデータ保存形式やProjectの意味を変更しない。

編集結果には確定した変更範囲`changes`が付く。`{ all, kinds, panelIds, assetIds }`の形で、コマンド経由の編集は宣言した種類（`structure` / `timing` / `text` / `visual` / `camera` / `audio` / `assets` / `paper` / `projectMeta`）と分かる範囲の対象IDを持つ。任意のcallbackを渡す互換経路とUndo/Redoは`all`になる。無変更操作と選択だけの変更は空の範囲を返す。現時点の`app.js`は`changes`の内容に関わらず全体`render()`を行う。部分更新の判断材料として先に契約だけを固定している。

`EditorController`は編集の入口をひとつにまとめる。`execute(name, args)`がコマンドを実行し、`edit(fn)`が変更範囲を判定できない互換経路、`select()`、`undo()`、`redo()`、`replace()`が残りの操作を担当する。確定編集・選択・失敗のいずれでも購読者への通知は一回で、検証に失敗した編集は`failed`と`error`を持つ結果として返り、履歴もrevisionも保存予約も増やさない。購読は解除関数を返す。

```text
DOM / Pointer / Keyboard
  → EditorController.execute(name, args)
  → commands[name].run(args)        （同期・DOMなし・awaitなし）
  → EditorSession.edit(fn, kind, changes)
  → Store.edit(fn) → validate + history + selection normalize
  → 購読者へ1回通知 → markDirty / Autosaver.schedule / render
```

## 5. UI構造とイベントの流れ

### 5.1 画面のDOM構造

画面はAfter Effects風のパネル構成にしている。各領域は`.dock`として枠を持ち、
先頭に`.panelBar`（タブ列）が付く。タブの`.on`が現在の面を示す。パネルは
`src/ui/docks.js`が出し入れし、閉じたものは「ウィンドウ」メニューから戻す。

```text
body
├─ header                           アプリ名 / #title / #fileMenuButton / #windowMenuButton / #savestate / #status
├─ #fileMenu .popupMenu            保存・読み込み・履歴からの復元（押したときだけ出る）
├─ #windowMenu .popupMenu          パネルの開閉メニュー（押したときだけ出る）
├─ nav                              Panel追加 / 複製 / Undo / Redo / 再生 / 紙コンテ / Animatic
├─ main
│  ├─ #projectPanel .dock           dock=left（tabs）
│  │  ├─ .panelBar > .tabs          「プロジェクト」タブ
│  │  └─ #tree                      Scene・Shot・Panelツリー（JSが中身を差し替える）
│  ├─ #stage .dock                  dock=center（tabs：コンポジション / 紙コンテ / Animatic）
│  │  ├─ .panelBar > .tabs          タブ列 / #breadcrumb（コンポジションのときだけ）
│  │  ├─ [data-body=composition]
│  │  │  └─ .stageStack             dock=stageStack（stack：開いている分を積む）
│  │  │     ├─ #tools               描画、消しゴム、画像、表示、#viewInfo
│  │  │     ├─ #viewer              暗いビューア。中央に#drawing（1280×720 Canvas）
│  │  │     └─ #strip               現ShotのPanel strip
│  │  ├─ [data-body=paper]          紙コンテ（設定・列・出力・#paperInfo・#pages）
│  │  └─ [data-body=animatic]      Animatic（設定・#animaticInfo・出力・#animaticPreview）
│  └─ #inspector .dock              dock=right（tabs）
│     ├─ .panelBar > .tabs          内容 / Camera / 音 / マーカー / 構成 / ショートカット
│     └─ .pane × 6                  尺・台詞・注記 / Cameraキー / 音声Clip / マーカー / Scene・Shot操作 / キー一覧
├─ #printArea                       印刷のときだけ中身が入る置き場（画面には出ない）
├─ #printPage                       用紙の大きさを@pageとして書き出す<style>
└─ footer .dock                     dock=bottom（tabs）
   ├─ .panelBar > .tabs             「タイムライン」タブ / #time / #range
   ├─ #timebar                      Zoom、Fit、Snap、追従
   └─ #timeBody
      ├─ #rowNames                  行名の列（コマ / Camera / #audioNames）。横スクロールしない
      └─ #timeline
         └─ #track
            ├─ #ruler
            ├─ #band
            ├─ #clips
            ├─ #cameraTrack
            ├─ #audioTrack
            └─ #head                再生ヘッド（上に掴み手の付いた線）
```

行の位置（`#clips`は上から28px、`#cameraTrack`は86px、`#audioTrack`は116px、音声
レーンは26px間隔）は`style.css`の`#rowNames`と対になっている。片方だけ変更しない。
音声のレーン名は`app.js`が`AUDIO_TRACK_ORDER`から作るので、トラックを増やしても
名前の列と行がずれない。

数値入力はAEのホットテキストに倣い、通常は青い文字として表示し、触れたときだけ
枠が出る。色は`:root`のカスタムプロパティにまとめてあり、個々の部品へ生の色を
書かない。

紙コンテは中央ドックのタブ（`data-body="paper"`）で、開いたまま編集できる。開いている
あいだだけ`render()`から`paperFollow()`が走り、用紙の設定欄（Undoで戻った分）と紙面を
作り直す。閉じているあいだは`layoutPages()`を一度も呼ばない。全Panelを走る処理なので、
見ていないのに打つたび走らせるとコマが増えるほど重くなる。用紙の設定欄をその場で
触っているときは作り直さない（打ち込みの途中でフォーカスが飛ぶ）。

印刷は`body`直下の`#printArea`へページを差し込んでから`window.print()`する。紙面の
パネルが画面のどこにあっても、印刷側の指定は「`#printArea`以外を消す」だけで済む。
用紙の大きさは`PAPER_SIZES[].mm`と向きから`#printPage`（`<style>`）へ`@page`として
書き出すので、印刷ダイアログで用紙を手で合わせる必要がない。

Animaticも同じ枠のタブ。出力中は`body[data-recording]`が立ち、Animaticのパネル以外を
`pointer-events: none`で触れなくしてキー操作も止める。録画は実時間で進むので、途中で
Projectや再生ヘッドが動くと映像も音も作り直しになるからで、モーダルが与えていた保証を
この形で保つ。**止めるのは人の操作だけ**で、開始前に走り出した非同期の取り込みは完了
してコミットされる（出力の中身は開始時点で固定してあるので混ざらない＝E3）。開いている
あいだは`render()`から見積り（`animaticInfo()`）だけを作り直す。形式やfpsの選択肢は
作り直さない（選んだものが既定へ戻ってしまう）。

復旧候補だけが`dialog`のまま残る。起動時に「復旧するか破棄するか」を決めてもらう場面
なので、ほかの操作を止めるのが正しい。低頻度設定はInspectorまたはパネルへ置き、高頻度操作はToolbar、ショートカット、Timeline上に置く構成になっている。

### 5.1.1 パネルの出し入れ（`src/ui/docks.js`）

ドックは4つ（left / center / right / bottom）。`tabs`のドックは開いているパネルを
1枚ずつ切り替えて見せ、`stack`のドックは開いている分を上から順に全部見せる。DOMとの
約束は`[data-dock]`・`[data-tabs]`・`[data-body]`・`[data-splitter]`の4つだけで、
`Docks`はどのパネルを開くかという状態だけを持つ。中身が1つも無いドックは仕切りごと
消え、`fixed`のパネル（`#viewer`）は閉じられない。最大化は`body[data-max]`と
`.maxed`で表す。

開閉と前面は画面の状態なのでProjectには入れず、幅や高さと同じ`layout`としてmetaストア
へ1件で保存する（`saveLayout()`）。読み戻しは知っているキーだけを範囲に収めて取り込み、
知らないIDは捨てる。最大化は「今だけ広げて見る」操作なので保存しない。

どのパネルがどのドックに属するか、ウィンドウメニューにどう並べるか、作業レイアウト
（AEのワークスペース）が何を開くかは`src/ui/panels.js`のデータで、DOMもDocksも
知らない。閉じられるパネルが必ずメニューに載っていること、作業レイアウトが知らない
IDを指していないことは`tests/panels.test.js`が確かめる。壊れた保存で画面が開けなく
なるのがいちばん困るので、「仕上げ（既定）」が逃げ道も兼ねる。

プレゼンモード（B8）は中央ドックの最大化の上に乗る。`body.presenting`が足すのは
ヘッダー・ツール列・コマを隠す分だけで、他は`body[data-max="center"]`が担う。

### 5.1.2 キー操作（`src/ui/shortcuts.js`）

効くキーと画面に出る説明は`SHORTCUTS`という1つの表から配る。`app.js`は表のidへ
実装を結び、`comboOf()`が押されたキーを表と同じ書き方へ直して引く。ショートカットの
パネルも同じ表から作るので、実装と説明が離れて食い違うことがない。キーの要らない
操作（ドラッグやホイール）は`GESTURES`に置く。

### 5.2 `render()`

`render()`は現在のProjectから表示用の派生値を作り直す。

1. `rows = flatten(store.p)` を作る。
2. `resolved = audio.resolveClips(store.p, rows)` を作る。
3. 直前に描いたProjectのオブジェクトと今のものを比べる。`Store.edit`は変更が
   あったときだけ新しいProjectを作るので、同一なら表示内容も同一とみなせる。
   同じならTreeとStripは作り直さず、選択の印（`.selected`と`details.open`）
   だけを付け替える。違えば作り直す。
4. Breadcrumd、Inspectorは毎回現在selectionに合わせて更新する。
5. Panel stripは、Projectが変わったときと所属Shotが変わったときに作り直す。
   遅延サムネイルのObserverはStripを作り直すときだけ張り直す。
6. `timeline()`でRuler、Panel Clip、Camera Track、Audio Track、Playheadを描く。
7. `paint()`でCanvasを描く。
8. active Panelが変わった場合だけStrip、Tree、Timelineを視界へ追従させる。

PanelサムネイルはIntersectionObserverで表示範囲に入ったものだけ描く。Timelineは`timeline.visible()`で表示範囲と余白に交差するPanelだけDOM化する。

Projectは変わらないのに絵が変わる経路（素材のデコード完了など）は
`invalidateViews()`を呼び、次の`render()`でTreeとStripを作り直させる。これを
省くと、復旧直後のサムネイルが素材なしのまま残る。

この部分更新で、500 Panelでの選択1回は9.1ms→3.5ms、矢印キーでの移動は
6.4ms→3.1msになった（同一環境の中央値）。Projectが変わる操作は従来どおり
全再構築で、費用も変えていない。

### 5.3 編集イベント

代表的なイベントは次のように接続される。

```text
DOM / Pointer / Keyboard
  → EditorController.execute(name, args)   （またはedit(fn)の互換経路）
  → commands[name].run(args)
  → EditorSession.edit(fn, kind, changes)
  → Store.edit(fn)
  → validate + history + selection normalize
  → 購読1回
      → markDirty()
      → Autosaver.schedule(() => store.p, editor.capture())
      → render()
```

画面側のUI状態（選択中のCameraキーなど）を確定後に更新する必要がある場合は、確定と描画の間に一度だけ走るフックで更新する。描画だけはPointerMoveごとに一時StrokeをCanvasへプレビューし、PointerUp時に一度だけProjectへcommitする。これにより、描画中の全PointerMoveがUndo段数や保存を消費しない。

数値入力の横ドラッグ（`ui/number-scrub.js`）も同じ考え方で、ドラッグ中は表示だけ
を動かし、離したときに一度だけ`change`を出す。1回のドラッグが1段のUndoになる。
3px動かすまではスクラブを始めないので、クリックしてキーボードで入力する操作は
そのまま使える。刻みは入力の`step`に従い、Shiftで10倍、Alt/Ctrlで1/10になる。

素材の取り込み（画像、音声の配置、音声の差し替え）は`ImportController`を通す。取り込み開始時に対象IDとSessionを固定し、デコードと原本保存が終わってから対象の存在とSessionを確認して一回の編集で適用する。作品を開き直した場合、対象が消えた場合、同じ対象へ次の取り込みが始まった場合は適用せず、デコード結果を解放する。無関係な編集や選択の変更では取り込みを捨てない。音声の新規配置は毎回別のクリップを作るため追い越し判定を行わない。

## 6. Timeline・時刻・再生

### 6.1 Timeline Engine

`timeline.js`はDOMを知らない純粋な計算層である。

- `SCALES`: 0.04〜24 px/frameの段階値
- `frameAt()` / `xOf()`: 画面座標とフレームの変換
- `visible()`: Viewport周辺のPanelだけを抽出
- `ticks()` / `tickStep()`: fpsに応じた目盛とラベル
- `snapTargets()` / `snap()`: Panel境界、秒、末尾、再生ヘッドへの吸着
- `anchorScroll()`: Zoom後もカーソル下のフレームを維持
- `follow()`: 再生ヘッドが端に来たときだけ追従
- `selectionRange()`: 複数選択の開始・終了・合計尺
- `fitScaleIndex()`: 全体をViewportに収める倍率

長尺Projectでは秒目盛の候補数を4096件以内に抑える。Panel境界はすべて残すため、細かいカット編集の吸着を保ちながら、極端な尺で候補生成が無限に膨らまない。

### 6.2 Playback

`playback.js`の`rowAtFrame()`は、Panelの累積開始/終了フレームを二分探索する。Panel境界では終了側を超えた次のPanelへ移り、再生とAnimaticで同じ境界規則を使う。

再生開始時、`app.js`は現在フレームからProject末尾までを`audio.scheduleFor()`で予約する。

- AudioClipがある: `AudioEngine.frameAt()`がAudioContext時計からフレームを算出。
- AudioClipがない: `frameAtTime()`が`performance.now()`からフレームを算出。
- 毎フレーム: frameをProject範囲にclampし、`paint(true)`でCameraを評価して描く。
- 末尾到達または停止: `stop()`がAnimationFrameと音源を停止する。

## 7. 描画エンジン

`drawing.js`はProjectデータを変更せず、Canvas 2Dへ描画する。

```text
draw(ctx, panel, width, height, camera, images, view)
  ├─ ViewのZoom/Pan変換
  ├─ Cameraの移動/回転/Zoom変換
  ├─ Strokeにeraseがある場合はscratch Canvasへ描画
  │   └─ destination-outをscratch内だけで使用
  └─ 画像 → Strokeの順で白紙へ描画
```

画像は`createImageBitmap()`で読み込み、長辺2048pxを超える場合は表示用Bitmapだけ縮小する。原本のバイナリはAssetストアに残る。表示用Bitmapは`app.js`の`images` MapにAsset IDで保持する。

消しゴムは出力Canvasへ直接穴を開けず、一時Canvasで合成してから白紙へ描く。これにより、紙コンテやAnimaticで透明な穴が残らない。

## 8. Audio Engine

### 8.1 純粋計算

`audio.js`のProject依存関数はWeb Audioなしで動作する。

- `resolveClips()`: Anchor Panel基準のClipを絶対フレームへ変換。AssetはMapで引く。
- `clipsInRange()`: Timeline/Inspectorに重なるClipだけ抽出。
- `scheduleFor()`: 再生開始フレーム、素材Offset、終端に合わせた予約情報を作る。
- `soundNotes()` / `soundText()`: Panelの台詞・手入力注記・配置済みClipから紙面文字列を作る。
- `peaks()`: PCMサンプルを列ごとのmin/maxへ変換。
- `addClip()` / `placeClip()` / `trimClip()` / `removeClips()`: Clip編集。
- `pruneClips()` / `pruneAudioAssets()`: Panel削除後のClipと未使用音声Asset整理。

### 8.2 Web Audio

`AudioEngine`は次をCacheする。

- `buffers`: Asset ID → decoded AudioBuffer
- `waves`: `assetId:columns` → Float32Arrayのmin/max波形
- `sources`: 現在予約しているAudioBufferSourceNode

`play()`は既存Sourceを停止してから予約を作り、同じClipが二重に鳴る状態を避ける。Animatic録画時は`MediaStreamDestination`へ接続し、CanvasのVideo Trackと同じStreamへAudio Trackを追加する。音声素材が見つからないClipはInspectorで差し替えられる。

## 9. 紙コンテRenderer

紙コンテはProjectを別形式へ変換するのではなく、同じTimeline rowsからページを計算する。

```text
layoutPages(project, paper, measureText, rows)
  ├─ pageGeometry()          用紙、余白、行高、列x/width
  ├─ resolveClips()         音の絶対位置
  ├─ columnText()            CUT、尺、台詞、音、メモ、Camera文字列
  ├─ wrapLines()             列幅に合わせた文字折返し
  ├─ 続き行生成              長文を次の行/ページへ送る
  └─ Page[][]                Panel順を保ったページ配列
```

`renderPage()`はページ配列をCanvasへ描く。画像列では描画画像とCamera表記を重ね、Camera表記は開始枠、終了枠、軌道、矢印、中間キー、HOLDを描画する。

出力は次の二つ。

- 印刷/PDF: ページCanvasをPNG化して印刷ダイアログへ渡す。PDF生成はブラウザの印刷機能に任せる。
- PNG連番ZIP: ページごとにCanvasをPNG化し、`ZipBuilder`へ逐次追加して一つのBlobをダウンロードする。

出力開始時にはProject、PaperSettings、Page配列、画像Mapを固定する。出力中に設定やProjectが変わっても一つのファイル内に新旧設定が混ざらない。紙面入力と出力ボタンはJob実行中に無効化される。

## 10. Animatic

`animatic.js`はフレーム計画と評価を担当し、実際の出力制御は`app.js`と`exporter.js`が担当する。

```text
plan(endFrame, projectFps, outputFps, resolution)
  └─ seconds / output frames / sourceFrame(i)

evaluate(rows, frame)
  └─ rowAtFrame + cameraAt

renderFrame(ctx, rows, frame, width, height, images)
  └─ evaluate + drawing.draw
```

- WebM: Canvas `captureStream()` + Audio `MediaStreamDestination` + `MediaRecorder`。実時間で録画する。
- PNG連番: 出力フレームごとに同じ `renderFrame()` を実行し、ZipBuilderへ追加する。音声は含まない。
- `Job`: 中止フラグを持ち、フレーム/ページ境界で中止を検知する。
- `Recorder`: `finish()`ではチャンクをBlob化し、`discard()`では中止時の途中チャンクを破棄する。

PNG連番は4フレームごとにブラウザへ制御を返す。各フレームの前に中止判定を行うため、出力速度と中止応答のバランスを取っている。

## 11. 保存・復旧・Asset

### 11.1 Storage層

`storage.js`はProjectの意味を知らず、Store名とKey/Valueだけを扱う。単一キーの`get`、`put`、`delete`に加えて、複数Storeの操作を一つの`batch(operations)`として確定する。

```text
IndexedDB object stores
├─ snapshots  保存メタデータ
├─ payloads   Project JSON文字列
├─ assets     画像/音声バイナリ
└─ meta       layout、復旧dismiss状態
```

`MemoryStorage`は同じAPIを持つテスト/フォールバック実装で、読み書き時に`structuredClone`を試みる。`IndexedDbStorage.open()`は複数の同時呼び出しを一つのopen requestへまとめ、決着した要求を片付けてから次の要求を受ける。open失敗の後も再試行でき、`close()`と別タブのVersion変更は接続を閉じたうえで世代を進める。失敗を返した後・close後・次の要求へ進んだ後に届いた接続は公開せずに閉じる。

`batch()`の操作は`{ type: "put" | "delete", store, key, value? }`で表す。`MemoryStorage`は失敗時に操作前の値へ戻し、`IndexedDbStorage`は対象Storeを一つのreadwrite transactionへまとめる。個別requestの成功ではなくtransaction完了を成功条件とする。未知Store、未知操作、Keyなしの操作は実行前に拒否する。

### 11.2 ProjectRepository

`save()`の処理は次の順序。

1. `validate(project)`。
2. JSON文字列化。
3. `snapshots`用メタデータを作る。Panel数、Version、サイズ、Asset ID一覧を含む。
4. `payloads`と`snapshots`を同じStorageのbatchで書く。IndexedDBでは同じreadwrite transactionとして確定する。
6. Quota不足なら古い保存を減らして一度だけ再試行する。
7. Snapshot上限を整理する。

通常は最新8件を残し、最新の手動保存がその範囲外なら手動保存も残す。そのため、設定によっては8件より1件多く残る。破損したpayloadは削除せず、`latest()`が読み飛ばして次の正常保存を復旧候補にする。

Asset GCは、現在Project、Undo/Redo履歴、保持中SnapshotのAsset IDを到達可能集合として計算する。新しいSnapshotはメタデータにAsset ID一覧を持つため、毎回すべてのProject JSONをparseしない。旧メタデータだけAsset ID一覧がない場合は、そのSnapshotを読み込んで後方互換性を保つ。

### 11.3 Autosaver

`Autosaver`は変更時の保存予約をまとめる。予約にはSession tokenを任意で付けられ、保存完了時に現在revisionと一致しない場合は成功表示を確定せず、最新予約を残して次の保存へ回す。

- 通常の遅延: 600ms
- 連続編集時の上限: 4000ms
- 状態: `idle` / `pending` / `saving` / `saved` / `failed`
- 保存中に編集された場合、保存開始時のProjectを確定し、新しい変更を次回保存へ残す
- 古いrevisionの保存完了では最新revisionを保存済みにせず、現在ProjectのAsset GCも実行しない
- 失敗時は成功表示にせず、次の編集または手動保存で再試行できる

## 12. テストと検証の境界

### 12.1 Nodeテスト

`npm test` はNode標準Test Runnerで、現在125テストを実行する。

| テスト | 対象 |
|---|---|
| `animatic.test.js` | fps変換、Frame plan、Camera評価、録画進捗、Codec選択 |
| `application.test.js` | Command経路、副作用一回、無変更・失敗、変更範囲、購読解除、素材差し替え、貼り付け |
| `audio.test.js` | Clip解決、Anchor移動、予約、波形の使用区間、AudioEngine二重再生防止 |
| `import-controller.test.js` | 取り込み対象の固定、追い越し、作品切替、対象削除、失敗後の再試行 |
| `editor-session.test.js` | 編集結果、Session revision、選択変更、Undo/Redo、Project差し替え、古いTokenの無効化 |
| `migration.test.js` | v1/v2入力、Migrationの非破壊性、未知Version |
| `model.test.js` | 構造、検証、履歴、選択、Panel移動、Camera、画像/音声分離 |
| `paper.test.js` | 用紙、列、折返し、続き行、Camera表記、ページ出力、ZIP、中止 |
| `playback.test.js` | 時計計算、Panel境界 |
| `repository.test.js` | 保存、Quota、Snapshot、Asset GC、Autosaver |
| `stability.test.js` | 24 seed × 90操作の再現可能なランダム編集、JSON往復、音、紙面 |
| `storage.test.js` | 複数Store batchの原子性、入力検証、IndexedDB接続の共有・再試行・close・versionchange |
| `timeline.test.js` | 変換、可視範囲、目盛、Snap、Zoom、追従、極端な長尺 |
| `ui.test.js` | 数値ドラッグの刻み・修飾キー・範囲 |

### 12.2 Browser smoke

`npm run test:browser` はPlaywrightで次を一本のシナリオとして確認する。

- 描画、消しゴム、画像、Panel追加、複製、尺、Undo/Redo
- Shift範囲選択、Strip並べ替え、Scene名、ペイン幅
- Timeline目盛、Zoom、スクラブ、Cameraキー、再生追従
- WAV読込、波形、Clip移動/Trim、再生同期、Panel削除とUndo
- Scene追加とUndo、素材のない音声クリップの差し替えとUndo
- 数値のドラッグ、オニオンスキン、Panelのコピーと貼り付け
- 選択ではTreeのDOMを作り直さず、尺の変更では作り直すこと
- A4/A3、縦横、長文継続、紙出力、PNG ZIP、中止
- PNG Animatic、WebM再生確認、音声存在、フレーム変化
- 500 Panelの表示、保存、リロード、復旧

直近の501 Panel測定値は、Panel尺変更20.4ms、Scene移動27.0ms、Timelineスクロール34.1ms、Zoom25.7ms、再生開始45.2ms、自動保存799.8ms（Linux + Chromium 1194、headless）。同期テストは4秒で94フレーム進み、ずれは-2フレーム。ページエラーは0件。実行環境が違えば数値も変わるため、環境をまたいだ比較には使わない。

Playwrightは配布物の依存ではない。この環境では `npm install --no-save playwright` と、既存のChromiumを指す `CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` で実行した。

### 12.3 ベンチマーク

`npm run bench` は100/500 Panelで以下を測る。

- flatten、duration編集＋Undo、JSON serialize/load
- MemoryStorage経由のRepository save/load
- Timeline visible/ticks/snap
- Paper layout

ベンチマークはNodeとMemoryStorage上の数値であり、IndexedDB、実画像のデコード、Windowsペン入力、実プリンターの性能を含まない。

## 13. 現在の境界と既知の挙動

これは未実装仕様ではなく、現行コードが持つ境界である。

- WindowsデスクトップShellは存在しない。直接ファイル上書きではなく、Project JSONのダウンロードとIndexedDB自動保存を使う。
- EditorSessionのSession IDとrevisionは実行時の値で、Project JSONや`.contp`へは保存されない。
- オニオンスキン（前後のコマを赤と青で薄く重ねる表示）とPanelのクリップボードは
  実行時のUI状態で、Projectにもlayoutにも保存しない。紙面・Animatic・サムネイルの
  描画には影響しない。
- Panelの貼り付けは参照している画像の素材メタデータを一緒に持ち運ぶ。原本は
  Asset IDで共有されるので中身は変わらない。持ち込めなかった画像参照は外す。
  音はPanelに属さないため、複製と同じく持ち運ばない。
- 編集結果の`changes`は契約として存在するが、画面更新はまだ全体`render()`である。部分更新と派生値キャッシュは未実装。
- 音声素材の差し替えは新しいAsset IDを作って参照を付け替える。原本は上書きしないので、Undoと過去のSnapshotは元の素材を指し続ける。旧原本の削除はAsset GCの到達可能性判定に従う。
- `.contp` JSONに画像/音声バイナリは同梱されない。別環境ではAssetの差し替えが必要になる。
- WebM AnimaticはMediaRecorderによる実時間録画。PNG連番はフレーム単位だが音声を持たない。
- ZIPは無圧縮。大きなPNG連番では完成Blobを作るまでエンコード済みバイトを保持する。
- 紙PDFはブラウザ印刷の画像ベースで、文字検索可能なPDFを直接生成する構造ではない。
- Camera補間は線形で、イージングはない。
- Waveform CacheはDecoded AudioBufferのChannel 0を列ごとのmin/maxへ変換する。クリップの波形は`offset`と尺から求めた素材内の区間だけを描き、素材の外は無音として描く。キャッシュは素材ID・列数・区間の組で持ち、表示列数には上限がある。推定バイト数による破棄は未実装。
- 描画、紙面、PNGフレームのCanvas処理はWorkerへ分離されていない。
- 実プリンター、Windows Ink、長時間の実機音声遅延、数千Panel＋実素材の常駐メモリはこの環境では測定していない。

## 14. 変更時に守るべき接続点

現行コードで同じ意味を二重実装しないための接続点は以下。

1. Panel順と時間は `flatten()` を基準にする。
2. Panel境界の検索は `rowAtFrame()` を使う。
3. Camera値は `cameraAt()`、Paper表記は `describeCamera()` を使う。
4. 音の絶対位置は `resolveClips()`、再生予約は `scheduleFor()` を使う。
5. Project変更は `EditorSession.edit()`経由で`Store.edit()`を通し、直接current Projectを変更しない。選択だけの変更は`EditorSession.select()`を使う。
6. 保存は`ProjectRepository`、保存遅延は`Autosaver`を通す。
7. Canvas描画は`drawing.draw()`、紙面ページは`paper.renderPage()`、Animaticフレームは`animatic.renderFrame()`を使う。
8. 出力の中止・進捗・逐次処理は`Job`/`forEachPage()`の規約を通す。

この8点が、編集画面、Timeline、再生、紙コンテ、Animatic、復旧の間でProjectの意味を一致させている現在の構造である。

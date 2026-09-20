# contE ロジック・UX監査（2026-09-20）

対象：`main` の `aed6808b2d78316048ee3a5a25e2c0da3130b71a`（作業ブランチ `claude/conte-logic-ux-audit-fs820b` の分岐元）。

目的は README冒頭のとおり「表示・操作・保存・出力が一貫しているか」「制作上の余分な操作や行き止まりがないか」「大規模化したとき構造的に重くなる箇所はどこか」を、コードと再現可能な自動テストから明らかにすること。**「全ての可能性を検証した」「完全に安全」とは表現しない**。各項目は「確認済み」「問題あり」「追加実測が必要」のいずれかに分類し、確認できた範囲と、確認できていない範囲を分けて書く。

## 0. 実行コマンドと再現手順

```sh
# Node側の既存テスト・新規テスト（113→116件、todoは1件）
npm test

# 既存ベンチ（100/500 Panel、MemoryStorage）
npm run bench

# 今回追加：1000/2500/5000 PanelのNode計測（MemoryStorage、Store.edit/Asset GC/ZIP保持量など）
npm run bench:scale

# 既存のPlaywright回帰（要Playwright別途導入。下記は本監査で使った環境変数の例）
PLAYWRIGHT_MODULE=<playwrightのentry .mjs> CHROMIUM_EXECUTABLE=<chromiumバイナリ> npm run test:browser
PLAYWRIGHT_MODULE=<...> CHROMIUM_EXECUTABLE=<...> npm run test:ux

# 今回追加：1000/2500/5000 Panelを実ブラウザ（実DOM・実IndexedDB）で計測
PLAYWRIGHT_MODULE=<...> CHROMIUM_EXECUTABLE=<...> npm run test:scale
```

本監査を実施した環境では、グローバルにインストール済みの `playwright@1.56.1`（`/opt/node22/lib/node_modules/playwright/index.mjs`）と、事前インストール済みのChromium（`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`）を使った。`test:scale`／`bench:scale` はこの監査で新規に追加したスクリプト（`scripts/browser-scale.mjs` / `scripts/bench-scale.mjs`）。

## 1. 基準状態

| 項目 | 内容 |
|---|---|
| 対象commit（main） | `aed6808b2d78316048ee3a5a25e2c0da3130b71a` |
| 作業ブランチ | `claude/conte-logic-ux-audit-fs820b`（このcommitから分岐） |
| AGENTS.md | リポジトリ内に存在しない（確認済み・作業指示は README / docs/*.md に記載） |
| 監査開始時のテスト | `npm test` → **113/113 pass**（既存の失敗は0件） |
| 監査後のテスト | `npm test` → **116件中115 pass・1 todo・0 fail**（todo1件は本監査で見つけた未修正の不具合の回帰テスト。詳細は4節・FIX_PLAN） |
| build | `npm run build` 成功（変更なし） |
| browser smoke / ux | 本監査が加えた `src/app.js`・`src/storage.js` の変更後も両方成功（後述） |

### ドキュメントと実コードの照合

README・docs/ARCHITECTURE.md・docs/UX_REVIEW_FIXES.md・docs/NEXT_PLAN.md を通読し、記載されている機能的な主張（Atomic Bundle Import、ExportSnapshotによる出力固定、IME安全な下書き、revisionガード付き自動保存、紙面列順の即時反映、狭幅Inspector、Camera直接操作など）をコードと突き合わせた。**機能的な主張と実コードの間に食い違いは見つからなかった**（＝「修正済み」表記が実際に効いていることをコードレベルで確認できた。詳細は2節）。

見つかった食い違いは軽微なもの1件のみ：

- `docs/ARCHITECTURE.md` 12.1「Nodeテスト」節に「現在83テストを実行する」とあるが、対象commit時点で実際は113件（本監査後は116件）。数値が更新されていないだけで、内容の誤りではない。→ FIX_PLANにドキュメント更新として記載。

`docs/NEXT_PLAN.md` が最優先事項として挙げている「B. 1000〜5000 Panel＋実素材の実測がない」は事実であり（既存 `scripts/bench.mjs` は100/500 Panelのみ、`scripts/browser-smoke.mjs` は501 Panelのみを対象）、本監査の5節で実測して埋めた。

## 2. 状態と不変条件

11項目を確認した。根拠は既存の自動テスト（ファイル名・テスト名）と、今回のコードリーディング・追加検証。

| # | 不変条件 | 分類 | 根拠・但し書き |
|---|---|---|---|
| 1 | 描画や文章編集は、ユーザーに示された対象へ適用される | **確認済み** | `src/app.js` の `$("drawing").onpointerdown` は `previewing`（スクラブ中）なら描画開始前に表示中Panelへ選択を同期してから線を確定する（`app.js:1061-1085`）。文章欄は `drafts.stage()` が押下時の `activeId()` を `target` として焼き付けるため、後から選択が変わっても混線しない（`src/text-drafts.js`, `tests/ux-safety.test.js: IME drafts survive...`）。 |
| 2 | 複数選択の操作範囲が表示と一致する | **確認済み** | 通常の文章編集は常にアクティブ1Panelのみに適用され（`drafts.stage` の `target:activeId()`）、一括適用は `$("bulkText")` の確認ダイアログ経由でのみ発火する（`app.js:874-880`）。`$("selectionInfo")` が対象説明を明示。`scripts/browser-ux.mjs` の「Mixed values are visible」区間で実ブラウザ確認済み。 |
| 3 | IME変換中・入力途中の値を再描画で失わない | **確認済み（例外あり）** | `displayValue()` はフォーカス中または下書き保留中・変換中のフィールドを再描画で上書きしない（`app.js:109-112`）。`tests/ux-safety.test.js` と `scripts/browser-ux.mjs`（実CompositionEvent）で確認。**例外**：`TextDrafts.schedule()`（`src/text-drafts.js`）は「いずれかのフィールドが変換中」を条件に自動flushタイマー全体を止めるため、既に変換を終えた**別フィールド**の下書きが、無関係なフィールドの変換が続く間ずっとflushされない。ドキュメント上の「最長1200ms」を超えて未保存状態が続き得る。これは値を失う不具合ではない（下書き自体は保持される）が、タブが強制終了された場合の消失リスクをわずかに広げる。再現テストを追加（`tests/ux-safety.test.js`「a finished draft in one field is not held hostage...」、`{todo:true}` で現状FAILを記録）。詳細はFIX_PLAN #1。 |
| 4 | Undo/RedoでProjectと必要な編集状態を復元できる | **確認済み** | `Store.edit/undo/redo`（`src/model.js`）は `{p, selection}` をペアで push/pop。`tests/editor-session.test.js`「undo and redo share the edit result contract」「replacing a project invalidates tokens...」、`tests/model.test.js`「undo restores the selection the edit started from」で確認。履歴上限80。 |
| 5 | 古いSessionの非同期結果が新しいProjectを変更しない | **確認済み** | `EditorSession.capture()/isCurrent()/isCurrentRevision()`、`AssetOperationCoordinator`（`src/asset-flow.js`）、`app.js` の画像/音声取り込み・`loadImages()`・Bundle importがすべて同じトークン方式。`tests/asset-flow.test.js`「a replaced editor session invalidates old operations」、`tests/ux-safety.test.js` のatomic import群で確認。 |
| 6 | 保存した版より後の編集を「保存済み」にしない | **確認済み** | `Autosaver.flush()` は保存開始時点の `source`／`sourceToken` と現在値を比較し、一致しない場合は `pending(stale:true)` のまま確定しない（`src/repository.js:274-311`）。`tests/repository.test.js`「a stale autosave does not report the latest revision as saved」「edits made while saving stay pending for the next write」。 |
| 7 | 保存可能なファイルは同じアプリで再度開ける | **確認済み** | `.contp`（v1〜v5 Migration、`tests/migration.test.js`）と `.contb`（`tests/bundle.test.js`「bundle round-trips project metadata and every asset binary」）の両方。`scripts/browser-smoke.mjs` で書き出し→復旧の実ブラウザ往復も確認。 |
| 8 | 失敗したImportで既存素材を壊さず、部分的な追加を残さない | **確認済み** | `ProjectRepository.importAssets()` は全件preflight→単一batch→`isCurrent`ガード。Quota失敗・ID競合・Session変更・batch完了直後の変更、いずれも`tests/ux-safety.test.js`で個別に反例テスト済み（既存）。 |
| 9 | GCは現在・履歴・復旧世代・処理中に必要な素材を消さない | **確認済み（設計上の非対称性あり、追加実測が望ましい）** | `pruneAssets()` は現在Project・Undo/Redo履歴・保持Snapshotの `assetIds`・`assetLeases` の和集合だけを保護（`src/repository.js:196-224`）。`prepareProjectDownload()`（`.contb`書き出し）は書き出し中に`repo.getAsset()`でストレージを読み直すため明示的に`retainAsset()`でリースを取る（`src/project-io.js`）。**一方、紙コンテ／Animatic出力（`app.js` の `exportPages`/`animaticRecord`/`animaticFrames`）はリースを取らない。** コードを読む限り、これらの出力は既にデコード済みの `images`/`sound` の in-memory キャッシュだけを使い、出力中に `repo.getAsset()` を呼び直さないため実害は見つからなかった（＝現状は確認済み）。ただしこれは「出力中はストレージを読み直さない」という実装の副作用による安全性であり、将来この経路が変わった場合に再検証が必要な、意図の見えにくい非対称性として明記する。 |
| 10 | 出力中の編集が、一つの出力へ混入しない | **確認済み** | `createExportSnapshot()` は `structuredClone` 後に深く `Object.freeze`（`src/export-snapshot.js`）。`tests/export-snapshot.test.js`「export snapshot is independent from later edits」「snapshot project is deeply read-only」。紙コンテ・Animaticともこのスナップショットのみを参照（`app.js:1746-1797`, `2022-2058`）。 |
| 11 | 中止・失敗後に次の処理を開始できる | **確認済み（UIレベルの明示的な回帰テストは無し）** | `exportPages()`／`$("animaticStart")` はいずれも `try/finally` で `job = null` / `animaticJob = null` を保証（`app.js:1746-1797`, `2022-2058`）。`Autosaver.flush()` も `finally { this.running = null }`。`scripts/browser-smoke.mjs` は中止後に他の操作を続けて成功させている（間接確認）。**「中止直後に同じ出力を再実行して成功する」ことだけを狙った専用アサーションは無い**（app.js自体にNode単体テストが無いことと同根。3節・5節参照）。 |

## 3. 制作シナリオの状態遷移

30Panel・複数Scene/Shot・画像・音声・Cameraキーを持つfixtureは、既存の `scripts/browser-ux.mjs`（3Panel、画像・音声・Camera・紙面設定を含む）と `scripts/browser-smoke.mjs`（501Panel、画像・音声・Camera・紙・Animaticを含む）が実質的にカバーしている。本監査ではこれを読み解き、A〜Hの操作列をコード上で追跡した。操作単位はクリック・キー入力・タブ移動をそれぞれ1操作として数える。

| シナリオ | 操作列 | 分類 | 主な根拠 | 操作数の note |
|---|---|---|---|---|
| A. コマ追加→台詞入力→複製→並べ替え→尺変更 | `acts.add`→`drafts.stage`→`acts.duplicate`→`startReorder`→`frames.onchange` | **確認済み** | いずれも`EditorSession.edit()`を経由し単一のUndo段。複製は選択中の元Panelをそのまま選択に残し、複製先は自動選択しない（`app.js:798-806`、意図的な設計、バグではない） | 「追加」「入力→blur」「複製」「ドラッグ1回」「尺入力→blur」で最短5操作 |
| B. 複数選択→個別編集→一括適用→Undo/Redo | Shiftクリック→`#notes`編集→`#bulkText`確認→Undo | **確認済み** | `scripts/browser-ux.mjs`で実ブラウザ確認済み（Mixed values / bulkTextの節） | 最短：選択2クリック＋編集1＋blur＋一括適用ボタン＋確認ダイアログ＝6操作 |
| C. スクラブ→描画→Camera編集→再生→停止 | `track.pointerdown`→`drawing.pointerdown`→Cameraタブ→`cameraFrame`drag→内容タブ→再生→停止 | **確認済み（必須の往復あり）** | Camera編集中は`cameraMode`が真の間`$("drawing").onpointerdown`が`return`するため描画できない（`app.js:1061-1064`）。README自身が「内容タブに戻ると描画できます」と明記する意図的な制約 | Camera調整と描画を1Panel内で往復するたび「タブ移動2回」が必須。30Panel全体をCamera調整してから描画、のようなワークフローでは往復回数がPanel数に比例する |
| D. 音声配置→Panel境界をまたいで移動→尺変更→削除→Undo | `audioFile`選択→`startClipDrag`（`placeClip`で再アンカー）→`startClipTrim`→`clipDelete`→Undo | **確認済み** | `tests/audio.test.js`「a clip follows its panel...」「moving a clip re-anchors...」「deleting a panel takes its clips with it...」 | 最短6操作。Undoで音声・Panel双方が同時に戻ることを確認済み |
| E. 入力中に保存→保存中に再編集→保存ファイルを再読込 | `#notes`入力→`Ctrl/Cmd+S`（ハッシュ計算中に編集）→再読込 | **確認済み** | `scripts/browser-ux.mjs`「Save delayed in hashing」区間で`crypto.subtle.digest`を人工的に遅延させ、保存開始後の編集が同じ書き出しに混入しないこと・`#filestate`が未保存のままであることを実ブラウザで確認 | — |
| F. 素材Import中に編集・Project切替・失敗 | `.contb`選択→（Quota失敗／Session変更／ID競合の注入） | **確認済み** | `tests/ux-safety.test.js`の5テストがNode側で網羅。`scripts/browser-ux.mjs`「Real IndexedDB transaction abort」で実IndexedDBのtransaction abortも確認 | — |
| G. 紙面設定→列移動→出力→中止→再実行 | `columnSettings`の↑↓→`#png`→`#cancelExport`→再度`#png` | **確認済み（再実行の専用アサーションなし）** | `scripts/browser-smoke.mjs`「PNGは1ファイルのZIPにまとめる」区間で中止と部分進捗を確認。中止直後に同じ出力ボタンを押して完了まで進む、という明示的な2回目実行の検証は無い（**追加実測が必要**） | — |
| H. 復旧→素材読み込み→編集→再保存 | reload→`#recoverDialog`→`#recover`→編集→保存 | **確認済み** | `scripts/browser-smoke.mjs`「自動保存と復旧」区間で実ブラウザ確認（reload・recover・画像再読込まで） | — |

### 「必須の往復」「到達不能」「対象の曖昧さ」として指摘できるもの

- **[確認済み・意図的] Camera編集と描画の往復（シナリオC）**：`cameraMode`中は描画キャンバスへのpointerdownを無視する。README自身が明記する仕様だが、操作数としては「Panelごとに最低2回のタブ切り替え」が構造的に必須になる。将来Camera直接操作を拡張する際の設計上の制約として明記（FIX_PLANのCameraイージング項目参照）。
- **[問題あり・今回修正] Shot分割/統合の無反応（対象の曖昧さ）**：`split(p, id)` はShotの先頭Panelで、`merge(p, id)` はSceneの先頭Shotで、それぞれ**無言で何もしない**（`src/model.js:503-514`）。`Store.edit()`は変更が無い場合Undo段も自動保存も消費しない設計だが、`app.js`側はこの「変更なし」を通知していなかったため、ショートカット（Ctrl/Cmd+K、Ctrl/Cmd+Shift+K）やボタンを押しても**エラーにも成功にも見えない**無反応状態になっていた。「最後のPanelは削除できません」など他の無効操作は`notice()`でメッセージが出るのに対し、この2つだけ無言だった非対称性を確認し、本監査で修正済み（`app.js` acts.split/merge、`scripts/browser-ux.mjs`に回帰テスト追加）。詳細はFIX_PLAN「今回実施した修正」。
- **[追加実測が必要] 到達不能の有無**：README「別SceneのShot同士の統合は未対応です」はコード上`merge()`が常に同一Scene内`shots[hi-1]`のみを対象にする構造上の制約であり、UIもそれ以外を提示しないため「到達不能な操作」ではなく「そもそも存在しない操作」。ただし狭幅Inspector（390px）やCamera操作など、実機のタッチ操作・スクリーンリーダーでの到達性は本監査の範囲外（Playwrightのポインタ操作のみ）で、追加実測が必要。

## 4. 反例テスト

今回追加したテスト（すべて `npm test` に含まれる。todoの1件を除き全てpass）。

| ファイル | テスト | 種別 | 結果 |
|---|---|---|---|
| `tests/storage.test.js` | `batch rollback restores each touched key to its own prior value, not just the whole store` | 反例→修正確認 | pass |
| `tests/storage.test.js` | `batch cost does not scale with unrelated data already in storage` | 性能の反例→修正確認（120MB前提データがあっても200ms未満） | pass |
| `tests/ux-safety.test.js` | `a finished draft in one field is not held hostage by composition in another field` | 反例（未修正、`{todo:true}`） | **FAIL（記録として意図的に残す）** |
| `scripts/browser-ux.mjs` | Shotの先頭Panelでの統合が理由付きで拒否されることを実ブラウザで確認 | 反例→修正確認 | pass |

境界条件のうち、既存テストで既に反例が用意されていたため重複して書かなかったもの（確認のみ行った）：

- 最初/最後のPanel・1Panelだけのプロジェクト・空Shot/空Sceneの拒否：`tests/model.test.js`
- Shot/Scene境界をまたぐ音声移動・末尾クリップのトリム：`tests/audio.test.js`, `tests/playback.test.js`
- Cameraキー端点（最後の1本は削除不可、`t`の0/1境界）：`tests/model.test.js`「camera keys can be added, moved and removed at any time」
- 素材の共有・重複ID・欠損素材：`tests/bundle.test.js`, `tests/ux-safety.test.js`, `tests/repository.test.js`「asset pruning preserves references from snapshots and undo history」
- 同時実行・完了順の逆転・二重クリック相当：`tests/asset-flow.test.js`「latest operation for a target wins」、`tests/editor-session.test.js`
- 処理の途中失敗・キャンセル：`tests/paper.test.js`「export runs page by page, reports progress and stops when cancelled」
- IME変換・フォーカス移動・再描画：`tests/ux-safety.test.js`, `scripts/browser-ux.mjs`

非同期処理の順序は既存テストが制御可能なPromise（`isCurrent`コールバックの差し替え）と障害注入（`storage.put`/`storage.batch`の差し替え）で再現しており、本監査もこの手法を踏襲した。ランダム操作テストは既存の `tests/stability.test.js`（24 seed × 90操作）を利用し、新規のシード追加は行っていない（**追加実測の余地：seed数を増やした長時間ランダム実行は未実施**）。

## 5. 性能構造の検証

### 5.1 定義

- N：Panel総数。S：1Panelあたりの描画点数（Strokeのpoints合計）。B：素材（画像/音声）のバイト数。F：出力フレーム/ページ数。

### 5.2 Node上の計測（`npm run bench:scale`、MemoryStorage、Node v22.22.2）

| 操作 | N=1000 | N=2500 | N=5000 | 計算量の見立て |
|---|---|---|---|---|
| `flatten(p)` | 0.17ms | 0.16ms | 0.29ms | O(N) |
| `buildProjectIndex(p)` | 0.47ms | 0.61ms | 1.50ms | O(N) |
| `Store.edit()`（1Panelの`frames`変更、全体の構造コピー含む） | 1.4ms | 5.5ms | 4.1ms | O(N)（Scene/Shot/Panel/Cameraまでの構造コピーが全件に及ぶため） |
| `movePanels()`（1件を末尾へ） | 0.31ms | 0.59ms | 0.59ms | O(N)（全Shot走査） |
| `audio.resolveClips()` | 0.24ms | 0.35ms | 0.72ms | O(N + audioClips) |
| `timeline.visible()`（対照区） | 0.002ms | 0.001ms | 0.001ms | O(log N)、Viewport分のみ。**Nに依存しないことを確認** |
| `repository.save()`（MemoryStorage、JSON化込み） | 295ms | 357ms | 794ms（p95 2.6秒） | 5.3節参照 |

「render()相当のツリーDOM件数」（Scene detail + Shot button + Panel button、`app.js`の`render()`が毎回無条件に作り直す件数）：N=1000で1179件、N=2500で2945件、N=5000で5890件。**Panel数と線形に増え、Viewportに制限されない**（5.4節）。

### 5.3 発見：`MemoryStorage.batch()` のロールバックが全ストアを毎回複製していた（修正済み）

`src/storage.js` の `MemoryStorage.batch()` は、失敗時に戻すためのバックアップとして**保存済みの全Store・全Keyを`structuredClone`で複製**してから操作を実行していた。これは保持世代が増えるほど、かつ無関係な既存データが大きいほど、1回のbatch呼び出しのコストが際限なく重くなることを意味する。

再現（修正前のコード、`payloads`ストアに19.5MBの文字列を1件ずつ追加しながら計測）：

```
save #1（既存0件）   40.3ms
save #5（既存4件）   440.9ms
save #10（既存9件）  1047.9ms
```

5000 Panel・8世代保持というProjectRepositoryの通常運用（`SNAPSHOT_LIMIT=8`）に相当する条件では、1回のautosaveが1秒を超えていた（`repository.save()`のp95が2.6秒という上表の数値もこれが主因）。

**影響範囲**：`MemoryStorage`はIndexedDBが使えないブラウザ（プライベートブラウズ等）でのフォールバック経路、および現在のNodeテスト・ベンチマーク全体の裏側で使われている。実ブラウザの主経路である`IndexedDbStorage.batch()`はネイティブTransactionのabortに任せる実装で、この問題は無い（コードレビューで確認、後述5.5節の実測とも整合）。

**修正**：操作対象のKeyだけを退避し、失敗時はそのKeyだけを元へ戻す方式に変更（`src/storage.js`）。ロールバックの正しさ（他のKeyに影響しないこと）と、無関係な大きいデータがあってもコストが増えないことをテストで確認（`tests/storage.test.js`の新規2件、5.2節の`Store.edit`計測はこの修正後の数値）。**今回のPRに含めて修正済み**（計画欄には含めない。FIX_PLAN「今回実施した修正」参照）。

### 5.4 発見：`render()`のツリー再構築がViewportに束縛されない（未修正・計画へ）

`src/app.js`の`render()`は、Timeline（`timeline.visible()`で表示範囲のみ）・Panel Strip（現在Shotのみ）をViewportやShotの範囲で絞る一方、左ツリー（`#tree`）は**Project全体のScene・Shot・Panelを毎回`replaceChildren()`で作り直す**（`app.js:210-267`）。Panel選択・1コマの尺変更・矢印キーでの隣接選択など、本来O(1)またはViewport相当で済むはずの操作すべてが、ツリー再構築を経由してO(N)になる。

実ブラウザでの計測（`npm run test:scale`、実Chromium・実DOM、Project構成はScene 15Shot×6Panel程度の入れ子）：

| N | ツリーDOM件数 | 隣接Panel選択（矢印キー） | 1Panel尺変更（`]`キー） | 使用JSヒープ |
|---|---|---|---|---|
| 1000 | 1179 | 31-33ms | 36-47ms | 約18-38MB |
| 2500 | 2945 | 49-50ms | 50-55ms | 約50-103MB |
| 5000 | 5890 | 51-72ms | 82ms | 約119-228MB |

対照として、Timelineのクリップ数（`.clip`要素）はN=1000/2500/5000のいずれでも12件で一定だった（Viewport制限が機能していることの確認）。

この数値はプロジェクトの階層形状（Shot数・Scene数）や実行環境に依存するため、「何倍遅い」という一般化はしない。ここで確認できるのは**構造として、選択やスクロールだけでもツリー全体を再計算している**という事実であり、`docs/ARCHITECTURE.md`が「PanelサムネイルはIntersectionObserverで表示範囲に入ったものだけ描く」「TimelineはViewportに交差するPanelだけDOM化する」と説明する設計方針が、ツリーには適用されていないことを意味する。再生中にPanel境界をまたぐたびにも同じ`render()`が呼ばれる（`app.js`の`tick()`、`app.js:947-951`）ため、大規模プロジェクトの再生では**カット送りのたびにこのコストが発生**する。

**未修正・FIX_PLANへ**：`app.js`には直接の自動テストが無く（後述5.6節）、UIの再設計に近い変更のため、本監査では実装せず計画として提示する（FIX_PLAN #2）。

### 5.5 実IndexedDBでの自動保存（対照計測）

`npm run test:scale`と同様の手順で、実ブラウザ・実IndexedDBでの自動保存レイテンシ（編集操作から`#savestate`が「ブラウザに保存」を表示するまで）を計測した：

| N | autosave（編集→保存済み表示） |
|---|---|
| 1000 | 654.8ms |
| 2500 | 685.5ms |
| 5000 | 745.1ms |

自動保存の遅延設定（通常600ms、連続編集時上限4000ms）が支配的で、Nに対してほぼ横ばい。5.3節の`MemoryStorage`とは対照的に、実IndexedDB経路ではこの規模で保存そのものが目に見えて重くなる兆候は見られなかった（**確認済み、ただし5000を超える規模・実画像/音声のデコードを伴う条件は未実測**）。

### 5.6 出力（ZIP）の保持量

`src/exporter.js`の`ZipBuilder`は`finish()`まで全チャンクを配列に保持する（`docs/ARCHITECTURE.md`も明記済みの既知の制約）。50KB相当のダミーページで実測：

| 枚数 | 保持量（finish前） |
|---|---|
| 300 | 15.4MB |
| 1000 | 51.2MB |

紙コンテ・PNG連番Animaticとも出力中はこのメモリを保持し続ける。ストリーミング出力（`docs/NEXT_PLAN.md`のN3）が未着手であることをこの実測で裏付けた。実際のPNGページはA4/300dpi相当でこのダミーより大きくなり得るため、数千Panelの紙コンテPNG出力ではさらに大きくなる（**実画像を使った上限の実測はしていない：追加実測が必要**）。

### 5.7 app.jsの直接テストが無いこと（構造上のリスクとして明記）

`src/app.js`（2301行、`src`ディレクトリで最大かつ唯一Node単体テストが無いファイル）は、選択・表示同期・ドラッグ操作・Camera直接操作・紙面/Animaticダイアログなど、本監査で確認した不変条件の多くを実際に実装している層である。現状の検証は

1. 純粋関数（`model.js`/`timeline.js`/`audio.js`/`paper.js`等）へのNode単体テスト、
2. `repository.js`/`storage.js`/`asset-flow.js`等の統合層へのNode単体テスト、
3. `scripts/browser-smoke.mjs`/`browser-ux.mjs`という2本の大きなPlaywrightシナリオ、

の3層に支えられているが、app.js自身の個々の関数（`render()`の構築ロジック、`startClipDrag`等の各ジェスチャー、`edit()`のフレーム更新など）を単体で狙い撃ちするテストは無い。5.4節の発見も、Node単体テストでは検出できず、実ブラウザでの計測で初めて確認できたものである。**これは今回発見した個別の不具合ではなく、今後app.jsを変更する際の検証コストと見落としリスクとして明記する**（FIX_PLANの前提条件）。

## 6. 未検証事項（明示的に「追加実測が必要」とするもの）

- Windows実機（Ink、ペン圧・傾き、pointercancel）、Safari固有挙動：本監査もこの環境では検証できない（既存ドキュメントの記載を踏襲）。
- 実画像・実音声のデコードを伴う1000〜5000 Panelの常駐メモリ・出力時間（本監査は軽量なダミーStroke/ダミーページで代替）。
- `test:browser`/`test:ux`に匹敵する規模のPlaywrightシナリオを1000Panel以上に対して回す完全な回帰（5.4節の`test:scale`は性能計測に特化しており、機能網羅はしていない）。
- シナリオGの「中止直後に同じ出力を再実行して成功する」ことの専用アサーション。
- `tests/stability.test.js`のシード数を増やした長時間ランダム実行。
- 512MiB付近の`.contb`実ブラウザ往復（Node側は51MBで確認済み。既存のUX_REVIEW_FIXES.mdの記載どおり上限値そのものはメモリ性能の保証ではない）。

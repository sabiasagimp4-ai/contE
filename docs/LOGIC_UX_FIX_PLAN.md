# contE ロジック・UX修正計画（2026-09-20）

`docs/LOGIC_UX_AUDIT.md`の検証結果を受けた優先順位・PR分割・完了条件。優先順位は指示どおり

**データ損失／誤編集 → 保存・出力の不整合 → 操作の行き止まり → 性能構造 → 利便性向上**

の順とする。**今回発見した不具合のうち、すでにこのブランチで修正実装したもの**（0節）と、**まだ手をつけていない計画項目**（1節以降）を明確に分ける。「全て検証した」「完全に安全」とは表現しない。

## 0. 今回すでに修正実装したもの（計画ではなく実施済み）

### 0.1 `MemoryStorage.batch()` のロールバックが無関係な既存データを毎回複製していた

- **重要度**：性能構造（ただし実運用への影響は限定的。0.3節参照）
- **発生条件と最短の再現手順**：`MemoryStorage`に大きな値（例：19.5MB文字列）を複数put→追加のbatchを1回呼ぶ。`tests/storage.test.js`「batch cost does not scale with unrelated data already in storage」参照。
- **ユーザーへの影響**：IndexedDBが使えない環境（プライベートブラウズ等でのフォールバック）で、Projectが大きく・保存世代（最大8）が積み上がるほど自動保存1回が数百ms〜1秒超に伸びる。IndexedDbStorageはネイティブTransactionのabortに任せる実装のため、この問題は無い（`docs/LOGIC_UX_AUDIT.md`5.3/5.5節）。
- **根拠となるファイルと処理**：`src/storage.js` `MemoryStorage.batch()`。修正前は失敗時のロールバック用に`this.#data`（全Store・全Key）を`structuredClone`で複製していた。
- **追加したテストと結果**：`tests/storage.test.js`に2件追加。「batch rollback restores each touched key to its own prior value, not just the whole store」（ロールバックの正しさ）、「batch cost does not scale with unrelated data already in storage」（120MB相当の無関係データがあっても200ms未満）。両方pass。
- **修正内容**：操作対象のKeyだけを退避し、失敗時はそのKeyだけを元の値（または未存在）へ戻す方式に変更。
- **完了条件**：`npm test`（`storage.test.js`含む）全pass、既存の原子性テスト（他ファイルのbatch経由テスト含む）に影響なし。→ 達成。
- **未検証事項**：実ブラウザでのMemoryStorageフォールパス自体（IndexedDB無効化環境）は本監査では未実測（`test:scale`は実IndexedDB経路のみ計測）。

### 0.2 Shotの先頭Panelでの分割・Sceneの先頭Shotでの統合が無言で無反応だった

- **重要度**：操作の行き止まり（対象の曖昧さ）
- **発生条件と最短の再現手順**：Shotの1コマ目を選択してCtrl/Cmd+K（分割）、またはSceneの最初のShotのPanelを選択してCtrl/Cmd+Shift+K（統合）。
- **ユーザーへの影響**：ショートカットやボタンを押しても成功も失敗も表示されず、操作が効かなかったのか単に何もしないのか区別できない。「最後のPanelは削除できません」等、他の無効操作は`notice()`でメッセージが出る中でこの2つだけ無言だった。
- **根拠となるファイルと処理**：`src/model.js` `split()`/`merge()` は該当条件で早期returnし何も変更しない（意図した仕様）。`src/app.js` の `acts.split`/`acts.merge` がその「変更なし」をUIへ伝えていなかった。
- **追加したテストと結果**：`scripts/browser-ux.mjs`に実ブラウザ回帰を追加（Ctrl+Shift+Kで`#errorNotice`に理由が表示されることを確認）。pass。
- **修正内容**：`acts.split`/`acts.merge`が実行前に同じ条件を判定し、無効なら`notice()`で理由を表示してから戻る（`src/app.js`）。
- **完了条件**：`npm run test:ux`成功、`npm run test:browser`（既存シナリオ）に影響なし。→ 達成。
- **未検証事項**：狭幅・タッチ操作での同メッセージの見え方は未確認。

以降は未着手の計画項目。

## 1. データ損失／誤編集

### 1.1 IME変換中、無関係な別フィールドの下書きがmaxDelayを超えて保留され続ける

- **重要度**：中（データは失われないが、documented latency保証を破り、タブの異常終了と重なった場合の消失リスクをわずかに広げる）
- **発生条件と最短の再現手順**：フィールドAに入力してdraftを作る→フィールドBでIME変換を開始し長く変換を続ける（例：`drafts.stage('dialogue',...); drafts.composition('notes', true);`）→AのdraftはBの変換が終わるまでflushされない。`tests/ux-safety.test.js`「a finished draft in one field is not held hostage by composition in another field」（`{todo:true}`で現状FAILを記録済み）。
- **ユーザーへの影響**：台詞欄を編集した直後に注記欄でIME変換を続けていると、台詞欄の自動保存が体感できるほど遅れる。ブラウザやOSがクラッシュした場合、この間の編集は自動保存にもファイル保存にも残らない可能性がある。
- **根拠となるファイルと処理**：`src/text-drafts.js` `TextDrafts.schedule()` が `this.composing.size`（＝いずれかのKeyが変換中か）でタイマー全体をゲートしている。`flush()`自体は明示呼び出し時に変換中のKeyも含め全件commitする設計（`tests/ux-safety.test.js`「save/visibility flush captures pending composition」で意図的にテスト済み・維持する必要がある）。
- **最小の修正案**：`schedule()`のゲート条件を「`entries`の中に`composing`に含まれないKeyが1件でもあるか」に変える（＝無関係なKeyの完了済みdraftがあればタイマーは動かす）。`flush()`自体の「明示呼び出しは変換中も含め全部commitする」という既存契約は変更しない（`beforeunload`/`pagehide`など強制フラッシュ経路の安全性を保つため）。この2つの経路（タイマー経由の自動flush／明示flush）が異なる粒度を持つことになるため、実装時は`tests/ux-safety.test.js`の既存9件（IME関連）全てを維持したまま先の`todo`テストをpassさせることを完了条件にする。
- **修正後の完了条件**：`{todo:true}`を外した上で該当テストがpass。既存のIME関連テスト（`IME drafts survive...`、`save/visibility flush captures pending composition...`）が引き続きpass。`scripts/browser-ux.mjs`の実CompositionEvent区間が引き続きpass。
- **未検証事項**：実ブラウザでの複数フィールド同時IME（実際にはブラウザは同時に1フィールドしか変換できないため、このシナリオは「変換済みだが未flushのdraftがある状態で、別フィールドの変換を開始する」というタイミングに限られる。フォーカス移動時に`compositionend`が`blur`より先に発火する保証がブラウザ間で揺れる可能性は未検証）。

## 2. 保存・出力の不整合

該当する新規の確認済み不具合は無し（`docs/LOGIC_UX_AUDIT.md`2節・4節の8〜10番はいずれも確認済み）。次点の懸念事項：

### 2.1 紙コンテ／Animatic出力がAssetリースを取らない非対称性

- **重要度**：低（現状のコードパスでは実害を確認できていないが、意図が文書化されていない）
- **発生条件**：出力ダイアログを開いたまま長時間経過し、その間に別の自動保存によるAsset GCが走る。
- **ユーザーへの影響**：現状は無し（`app.js`の紙コンテ／Animatic出力は出力開始前に`ensureImages`/`ensureAudio`でデコード済みキャッシュを使い、出力中に`repo.getAsset()`を呼び直さないため）。
- **根拠となるファイルと処理**：`src/project-io.js` `prepareProjectDownload()`は`repo.retainAsset()`でリースを取るのに対し、`app.js`の`exportPages()`/`animaticRecord()`/`animaticFrames()`は取らない。
- **最小の修正案**：今は修正不要。ただし将来この出力経路が「未デコードの高解像度原本を出力時に読み直す」ように変わった場合は、`prepareProjectDownload()`と同様のリース取得を追加する必要がある、という設計メモを`docs/ARCHITECTURE.md`の該当節に残す。
- **完了条件**：ドキュメントへの追記のみ。
- **未検証事項**：意図的な設計か単なる見落としかは、実装者への確認が望ましい。

## 3. 操作の行き止まり

0.2で1件修正済み。新たに見つかった行き止まり・到達不能は無し。Camera編集中に描画できない制約（`docs/LOGIC_UX_AUDIT.md`3節）はREADME記載の意図的な仕様であり、行き止まりではなく「必須の往復」として計画5節（Camera直接操作の拡張）で扱う。

## 4. 性能構造

### 4.1 `render()`のツリー再構築がProject全体に比例し、Viewportに束縛されない

- **重要度**：高（大規模Projectでの操作感に直結。データ損失は無いが「大きなプロジェクトでも操作を止めない」というNEXT_PLANの目標に反する）
- **発生条件と最短の再現手順**：1000〜5000 Panelのプロジェクトで、隣接Panel選択（矢印キー）や1Panelの尺変更など、本来軽い操作を行う。`npm run test:scale`で再現（`docs/LOGIC_UX_AUDIT.md`5.4節に実測値）。
- **ユーザーへの影響**：Panel数が増えるほど、選択・小さな編集・**再生中のカット送り**のたびに体感できる遅延が入る（5890 DOM要素の再構築で最大80ms程度、本監査の計測環境・fixture形状での値）。
- **根拠となるファイルと処理**：`src/app.js` `render()` が `store.p.scenes`全体を`forEach`して`$("tree")`を`replaceChildren()`で毎回作り直す（`app.js:210-267`）。Timeline（`timeline.visible()`）・Strip（現在Shotのみ）は対照的にViewport/Shot範囲で絞られている。
- **追加したテストと結果**：`scripts/browser-scale.mjs`（本監査で新規追加）が実測値を記録するが、現状は「壊れていないか」の構造アサーション（クリップ数がViewport相当に収まること、ツリー件数がPanel数以上であること）のみで、性能回帰を自動で落とす閾値アサーションは意図的に入れていない（環境依存のため。5.4節参照）。
- **最小の修正案**：（a）ツリーをShot単位で開閉済みのものだけ子要素を持たせる／閉じたSceneはPanelボタンを生成しない、（b）選択変更のみの`render()`呼び出し（`select()`、矢印キー、再生中のPanel切替）ではツリーの構造を再生成せず、選択クラスの付け替えだけに留める差分更新を導入する、のいずれか。(b)の方が影響範囲を絞りやすい。あわせて`edit()`内で`reindex()`が`edit()`本体と`render()`の両方から二重に呼ばれている点（`app.js:136-155`と`210-217`）も、`store.p`参照が変わった時だけ再構築するメモ化で解消できる（副作用の少ない先行修正として先に着手できる）。
- **修正後の完了条件**：`npm run test:scale`で同一fixture・同一環境における選択・編集の所要時間が有意に減ること（絶対値の合否は環境依存のため、before/afterの比較で判断する）。`npm run test:browser`/`test:ux`が引き続き成功。ツリーの開閉状態・フォーカス保持など既存のUX_REVIEW_FIXES項目（ナビゲーションが毎回リセットされない）を壊さないことをbrowser-ux.mjsで確認。
- **未検証事項**：この修正は`app.js`のUI構造に踏み込むため、本監査では実装しない。着手前に4.3（app.jsのテスト整備）を先行させることを推奨する。

### 4.2 `MemoryStorage`経路（既に修正済み、0.1参照）

再掲のみ。実装はこのPRに含めた。

### 4.3 `app.js`に直接の自動テストが無い

- **重要度**：中（個別の不具合ではないが、4.1のような修正を安全に行うための前提条件）
- **発生条件**：`app.js`（2301行）の変更はすべて`scripts/browser-smoke.mjs`/`browser-ux.mjs`という2本の大きなシナリオでしか検証できない。個別のジェスチャー・`render()`の構築ロジック単体を狙い撃ちするテストが無い。
- **ユーザーへの影響**：直接は無いが、4.1のような構造変更のレビューコストとリグレッションリスクを高める。
- **根拠となるファイルと処理**：`src/`配下で`tests/*.test.js`が存在しない唯一のファイルが`app.js`。
- **最小の修正案**：`app.js`をDOM生成部分（例：ツリー構築、Timelineの各トラック構築）と、イベント配線部分に分割し、DOM生成部分だけでも`jsdom`等を用いたNode単体テストの対象にする。あるいは軽量に、`render()`が呼ぶツリー構築関数を`app.js`から独立したモジュールへ切り出し、DOMを引数で受け取る形にして純粋関数として単体テストする。
- **完了条件**：4.1の変更が、Playwright起動なしのNode単体テストでも検証できる状態になっていること。
- **未検証事項**：分割の範囲（どこまでをapp.jsから切り出すか）は設計判断が必要で、本監査の範囲外。

## 5. 利便性向上・未実装機能の依存関係と実装順

`docs/NEXT_PLAN.md`のN3・N5・N6で挙げられている項目について、今回の検証結果を踏まえた依存関係と実装順の提案。**これらは未実装機能の設計候補であり、今回の不具合修正とは区別する。**

1. **Shot複製**（コピー&ペーストの前提）：`movePanels()`と同じ「同一Scene内shots配列の操作」で完結し、Asset参照は複製せず共有すればよいため依存が少ない。最初に着手しやすい。
2. **Panelのコピー&ペースト**：Shot複製の後。新しいIDの発行・Camera/音声Clipの複製規則（README「音声クリップは開始位置のPanelに属する」との整合）を先に固める必要がある。4.3（app.jsのテスト整備）がある方が安全に進められる。
3. **Cameraイージング**：現在の`cameraAt()`（線形補間、`src/model.js`）と`describeCamera()`（PAN/TILT/ZOOM/ROLL/HOLDの要約）の両方に影響し、紙コンテのCamera表記（`src/paper.js` `cameraNotation()`）・Animatic評価（`src/animatic.js` `evaluate()`）が同じ関数を共有している設計（`docs/ARCHITECTURE.md`14節の接続点4）を壊さないことが条件。コピー&ペーストの後、音声フェードの前に置くのが自然（Camera編集UIの拡張と合わせて着手できるため）。
4. **音声フェード**（fade in/out、gain curve）：`audio.scheduleFor()`の戻り値契約（`when`/`offset`/`duration`/`gain`）を拡張する必要があり、`AudioEngine.play()`・Animatic録画（`animaticRecord`）の両方の再生経路を同時に直す必要がある。Cameraイージングで「時間軸に沿った補間値」を扱うパターンができた後の方が設計を再利用しやすい。
5. **紙面テンプレート**（列セットの保存・再利用）：`PaperSettings`のスキーマ変更（Migration v5→v6相当）を伴うため、他の項目より後回しにする方が安全。テンプレート自体は`paper.columns`の名前付き保存に過ぎず、実装コストは低いが、Migrationの追加は`tests/migration.test.js`の拡張とセットで行う。
6. **文字検索可能なPDF**：現在の`paper.renderPage()`はCanvas描画のみでテキストレイヤーを持たない。ブラウザ標準APIだけでは実現が難しく（`docs/ARCHITECTURE.md`13節が明記する既知の制約）、PDF生成ライブラリの導入判断が要る。依存が最も重く、Windows実機ゲート（NEXT_PLAN N7）の判断と合わせて最後に置くのが妥当。
7. **ストリーミング出力**（NEXT_PLAN N3、ExportSink）：4.1（ツリー再構築）や上記の機能追加そのものとは独立に進められるが、5.6節で確認した「ZipBuilderがfinish()まで全チャンクを保持する」構造的事実が動機になる。5000 Panel規模の紙コンテPNG出力を実際に使うユーザーが出る前、かつ4.1より後（先にUIの応答性を改善してから出力の長時間化に対処する方が、ユーザーが体感する優先度に合う）に着手するのが妥当。

依存関係を一直線にまとめると：

```
4.3 app.jsテスト整備
   → 4.1 ツリー再構築の見直し（性能）
        → 5-1 Shot複製 → 5-2 コピー&ペースト → 5-3 Cameraイージング → 5-4 音声フェード → 5-5 紙面テンプレート
   → 5-7 ストリーミング出力（4.1と並行可）
5-6 文字検索可能なPDF（他と独立、最後）
```

## 6. PR分割案

1. **PR1（本PR）**：監査ドキュメント一式、`MemoryStorage.batch()`修正、Shot分割/統合の無反応修正、`bench-scale.mjs`/`browser-scale.mjs`、関連テスト。
2. **PR2**：4.3 app.jsのテスト整備（設計判断を要するため単独PR）。
3. **PR3**：4.1 ツリー再構築の見直し（PR2完了後）。
4. **PR4**：1.1 TextDrafts の composing ゲート修正（独立して着手可能、`{todo:true}`を外す）。
5. **PR5以降**：5節の実装順に沿って機能追加。

各PRの完了条件は「`npm test`成功（新規todoを追加した場合はその理由を明記）」「`npm run build`成功」「関係する`npm run test:browser`/`test:ux`/`test:scale`が成功」「本ドキュメントの該当項目を実施済みへ更新」の4点を満たすこととする。

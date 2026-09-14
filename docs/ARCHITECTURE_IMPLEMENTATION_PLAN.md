# contE 構造改善の実装計画

作成日: 2026-09-14  
状態: 実装進行中。M0のコード照合と基準テスト、M1のSession境界第一段階、M2のStorage batchとRepository移行を実装済み。本文中で実装済みと明記していない新しいモジュール、API、試験、性能目標は提案である。

## 1. 根拠と対象範囲

本計画の技術的な参照元は、[ARCHITECTURE.md](./ARCHITECTURE.md) のみとする。

| 項目 | 基準 |
|---|---|
| リポジトリ / ブランチ | `sabiasagimp4-ai/contE` / `main` |
| 参照時のコミット | `21e36dfe95d8f8572bc51384a9731e93c7c092e1` |
| 文書のblob SHA | `16a86eac119cf289cf1e4c96fdb49a839ab14c59` |
| 文書の最終更新日 | 2026-09-14 |
| 固定した参照先 | [基準コミットのARCHITECTURE.md](https://github.com/sabiasagimp4-ai/contE/blob/21e36dfe95d8f8572bc51384a9731e93c7c092e1/docs/ARCHITECTURE.md) |
| 計画作成時に読んだ実装ファイル | なし。これは計画作成時点の記録。M0実施時に主要なソースとテストを照合した |
| GitHubメタデータの用途 | 基準コミット、配置先の重複、作業指示ファイルの有無の確認 |

以下で「参照§N」はARCHITECTURE.mdの節番号を指す。既存の挙動、文書から導いた懸念、変更案を区別する。記載がない保証を「実装に存在しない」とは断定しない。将来の実装担当はM0で該当コードを確認し、文書と違う場合は本計画を修正してからその変更に着手する。

今回の変更対象はこの計画書だけである。現在の構造を記録するARCHITECTURE.mdへ未実装の内容を混ぜず、各段階の実装完了時に事実として更新する。

## 2. 目的と維持する契約

目的は、機能追加時の変更範囲を小さくし、編集・保存・復旧・出力の一貫性を維持しながら、不要な全体処理と素材の常駐量を減らすことである。

| 維持する契約 | 実装時の扱い |
|---|---|
| ブラウザで動くES Modules、実行時の外部依存なし | 初期段階は既存構成を維持する。新しい依存や配布方式は別の変更として判断する |
| Project v5と旧Versionの読み込み | 構造整理のためだけに保存Versionを上げない。Migrationの非破壊性と未知Versionの拒否を維持する |
| Scene / Shot / Panelの順序と時間 | `flatten()`の結果を基準にし、最適化した索引との同値性を確認する |
| Panel境界とCamera評価 | `rowAtFrame()`、`cameraAt()`、`describeCamera()`を共通の意味の定義として維持する |
| 音声の配置と予約 | `resolveClips()`、`scheduleFor()`の規則を維持する |
| 編集とUndo/Redo | Projectの確定変更はStoreを通す。Projectと選択を一緒に復元し、履歴上限80段階を維持する |
| 無変更・検証失敗 | 無変更操作は履歴と保存を増やさず、不正操作では現在値・履歴・選択を壊さない |
| 描画入力 | 一時Strokeは操作中の状態として持ち、PointerUpで一度だけ確定する |
| 保存と復旧 | RepositoryとAutosaverを経由し、保存中の追加編集、Quota再試行、破損候補の読み飛ばしを維持する |
| 表示・紙面・動画の描画 | `drawing.draw()`、`paper.renderPage()`、`animatic.renderFrame()`を再利用する |
| 出力 | 開始時の内容を固定し、Jobの進捗・中止・後始末を共通化する |

全Projectの正規化、履歴のコマンドログ化、フレームワーク移行、デスクトップ化、Camera補間の変更、検索可能なPDF、非実時間の動画エンコードは、初期の構造改善には含めない。Worker化はM7の計測後に判断する。

## 3. 現状から改善への対応

| 対象 | 文書で確認できること | 懸念または未確認事項 | 改善する境界 |
|---|---|---|---|
| アプリケーション層 | `app.js`に編集、表示、再生、保存、Dialogが集まる（参照§2・5） | 接続の変更が広い範囲に波及しやすい | Command実行、Session、View、再生、出力の所有者を分ける |
| 編集と描画更新 | 編集可能な階層を複製し、renderで派生値と複数の画面を作り直す（参照§4・5） | 小さな編集に必要以上の処理が伴う可能性 | 変更された枝の複製、変更通知、派生値の依存関係、部分更新 |
| 永続化 | payloadを書いてからsnapshotを書き、失敗時はロールバックする（参照§11） | 同一トランザクションでの確定は記載なし | Storageに複数操作の一括確定を定義する |
| 素材 | 原本はRepository、画像Mapはapp、音声と波形はAudioEngine（参照§7・8・11） | 容量上限、使用中の保持、解放の契約は記載なし | AssetManagerと素材の使用権を定義する |
| 出力 | 制御がappとexporterにあり、ZIP完成までバイトを保持する（参照§9・10・13） | 大きな連番のメモリ増加、後始末の分散 | ExportController、出力Snapshot、書き込み先の契約 |
| 持ち運び | `.contp`に画像・音声を同梱しない（参照§13） | JSON単体では別環境で同じ制作状態を再現できない | 素材を同梱する形式の入出力層 |
| 時間 | Panelはフレーム、Cameraは比率、AudioClipのoffsetも整数フレーム（参照§3） | offsetの基準fps、fps変更の意味、端数丸めの詳細が不明 | 単位を明示した変換関数と互換性の規則 |

## 4. 段階と依存関係

推奨着手順は表の上からとする。依存関係は変更を統合するための条件であり、作業日数の見積もりではない。各段階は単独でレビュー・差し戻しできる単位にする。

| 段階 | 内容 | 前提 | 主な成果 | 優先度 |
|---|---|---|---|---|
| M0 | コード照合、契約試験、計測基準 | なし | 現行挙動の基準と未確認事項の解消 | 最初に実施 |
| M1 | アプリケーション層とSessionの分離 | M0 | 編集結果の通知、非同期処理の所属、Viewの寿命 | 高 |
| M2 | 保存の一括確定と保存状態の整合 | M1 | Storage batch、Repositoryの保存境界、Autosaverの世代管理 | 高 |
| M3 | Storeの構造共有と変更情報 | M1 | 安全な部分複製と変更の種類・対象ID | 高 |
| M4 | 派生データと画面の部分更新 | M3 | 時間索引、依存別キャッシュ、安定したDOM | 高 |
| M5 | 素材の保持・キャッシュ・解放 | M1・M2 | AssetManager、容量予算、出力用解像度 | 高 |
| M6 | 時間単位と再生制御の整理 | M0・M1 | 互換性を維持する変換関数、PlaybackController | 中 |
| M7 | 出力制御と逐次書き込み | M4・M5・M6 | ExportController、Sink、共通の終了処理 | 高 |
| M8 | 素材を含むProjectの持ち運び | M2・M5・M7 | Bundle writer / reader、段階的Import | 中 |

M6で旧データの意味を変える必要が判明した場合、その仕様変更は互換性移行として分離する。M7は既存の時間解釈を保つ変換層で進められるようにし、未確定のVersion変更へ依存させない。

## 5. 到達させる責務の配置

以下の新しいパスは提案名である。既存ファイル内の実際の関数構成をM0で確認し、役割が重複するファイルを機械的に増やさない。

| パス案 | 担当すること | 持たせない責務 |
|---|---|---|
| `src/app.js`（既存） | 初期化、依存の接続、Session開始、終了処理 | 各InspectorのDOM生成、書き出しのループ、素材キャッシュの直接管理 |
| `src/application/session.js`（新規） | 現在のStoreとSession世代、サービスの所属と寿命 | Projectの業務規則、Canvas描画 |
| `src/application/commands.js`（新規） | UI操作をStoreの編集として実行し、結果を通知 | DOM、IndexedDBへの直接アクセス |
| `src/application/editor.js`（新規） | 確定編集後の再生停止、保存予約、画面更新要求 | 個々のデータ編集アルゴリズム |
| `src/ui/*-view.js`（新規・必要な画面単位） | Tree、Stage、Inspector、Timeline、Dialogの表示と購読解除 | Projectの直接変更、独自の保存処理 |
| `src/ui/render-scheduler.js`（新規） | 更新要求の統合と描画タイミング | 全編集に対する無条件の再計算 |
| `src/model.js`（既存） | Project、検証、Migration、Store、履歴の公開窓口 | DOMとブラウザ資源 |
| `src/model/draft.js`（新規候補） | 変更する枝だけを複製する編集用API | current Projectへの直接書き込み |
| `src/derived/project-index.js`（新規） | ID検索、順序、累積時間、参照元に基づくキャッシュ | Projectの新しい正本 |
| `src/storage.js`（既存） | IndexedDB / Memoryのキー操作と一括確定 | Snapshot保持数などのProject固有方針 |
| `src/repository.js`（既存） | 保存、復旧、保持方針、素材原本、GC、Autosaverの既存窓口 | UIメッセージの直接描画 |
| `src/assets/manager.js`（新規） | デコード、キャッシュ、使用中の保持、原本取得の窓口 | 永続GC方針の二重実装 |
| `src/time.js`（新規候補） | 単位を明示した時間変換 | 別のPanel境界規則 |
| `src/application/playback-controller.js`（新規） | 時計、再生・停止・シーク、音源とAnimationFrameの寿命 | 独自のCamera補間や音声位置計算 |
| `src/application/export-controller.js`（新規） | 固定Snapshotから出力Jobを実行し、進捗と終了を通知 | DialogのDOM操作 |
| `src/export/sinks.js`（新規） | バイトの書き込み、完了、中止 | ページやProjectの意味 |
| `src/project-bundle.js`（新規） | Bundle形式の検証、Import / Export | 通常の自動保存の独自実装 |

画面はCommandの実行結果と読み取り用の状態を受け取る。Projectへの変更はStoreへ集まり、永続化はRepositoryへ集まる。サービス間の呼び出しはSessionの初期化で渡す。共有の可変オブジェクトをモジュールのグローバル変数として増やさない。

## 6. M0 — 現行挙動の照合と計測

### 6.1 着手時に確認する項目

本節は今後の実装作業で行う確認であり、この計画書作成時の実施結果ではない。

| 確認する場所 | 確認事項 | 計画への反映 |
|---|---|---|
| `app.js`、`model.js` | 編集・Undo/Redo・復旧の入口、選択変更だけの経路、dirtyの意味 | Command一覧と副作用の一覧を作る |
| `model.js` | `edit(fn)`の戻り値、複製範囲、現在値の可変性、`sameProject()`の走査範囲 | 既存APIを維持するAdapterの形を決める |
| `model.js`、派生値の利用箇所 | `flatten()`のrowがPanelオブジェクト参照を持つか | 古いPanelを保持するキャッシュを防ぐ |
| `storage.js`、`repository.js` | トランザクション境界、成功Promiseの確定時点、同時保存とGCの順序 | すでに保証がある箇所は重複実装せず試験を追加する |
| `audio.js`、`animatic.js` | offsetを秒へ変換するfps、素材とProjectの尺、フレーム丸め | M6の互換性規則を確定する |
| `app.js`、`drawing.js`、`audio.js` | Mapの差し替え、Bitmapの解放、音源の接続、波形の寿命 | 資源の取得と解放の対応表を作る |
| `exporter.js`、出力Dialog | 固定するSnapshotの深さ、中止経路、Object URL、Recorderの終了順 | M7の移行単位を決める |
| `scripts/build.mjs` | `src/`配下に新しいディレクトリを置いたときの配布 | 再帰コピーと相対importが配布先でも機能することを確認する |

### 6.2 基準となる試験と計測

1. 文書にある `npm test`、`npm run test:browser`、`npm run bench`、`npm run build` を実行し、失敗があれば既存失敗と変更による失敗を区別する。
2. 既存の再現可能なランダム編集を基準に、無変更、検証失敗、複数選択、Anchor削除とUndo、Migration、保存中の再編集を固定する。すでに同じ保証の試験があれば再利用する。
3. 同じ環境・同じデータで100 / 500 / 2000 Panelを用意し、文字中心、Stroke中心、画像と音声を含むケースを区別する。
4. 編集コマンド、複製、検証、変更比較、派生値、DOM更新、Canvas描画を別々に測る。自動保存は待機時間、JSON化、IndexedDB確定までの時間を分ける。
5. 初回の素材デコードとキャッシュ済み操作を分ける。短い操作はウォームアップ後30回以上を目安にp50 / p95を記録し、計測自体の負担を明記する。
6. 音声同期は開始誤差と経過に伴うドリフトを分け、主時計・映像フレーム・音声再生位置を同じ観測点で記録する。

参照§12の501 Panelでの11.3ms、30.4ms、33.1ms、33.2ms、35.7ms、772.9msは過去の文書報告値である。測定環境・区間が一致するまで本計画の比較基準として直接使わない。特に772.9msをJSON処理やIndexedDB処理だけの時間と解釈しない。

**完了条件:** 現行挙動を確認する試験、環境付きの計測結果、文書との差異、M1以降で触る経路が記録されている。

### 6.3 M0実施結果（2026-09-14）

- `src/app.js`、`src/model.js`、`src/repository.js`、`src/storage.js`、既存テストの実装入口を照合した。
- 既存のNodeテストは73件すべて成功し、Session追加後は78件、Storage batch追加後は82件すべて成功した。
- `npm run build` は成功し、新しいES Moduleも`dist/src/`へコピーされることを確認した。
- `node --check src/app.js`、`node --check src/editor-session.js`、`git diff --check` は成功した。
- `npm run test:browser` は、この実行環境に`playwright`パッケージがないため開始前に停止した。ブラウザsmokeを通過したとは扱わず、依存を用意した環境で再実行する。
- 既存の実装はARCHITECTURE.mdの基準コミットとblob SHAに一致した。今回の実装ではProject JSON Version 5、保存形式、既存のStore履歴規則を変更していない。

M0のブラウザ検証は未完了である。M1のSession境界はNodeと静的構文・buildまで検証し、ブラウザでのProject切り替えと遅い素材読み込みの組み合わせはPlaywright環境復旧後に確認する。

## 7. M1 — アプリケーション層とSession

### 7.1 状態の所有者

| 状態 | 所有者と規則 |
|---|---|
| Project、履歴、履歴に付随する選択 | Store。現行のUndo/Redoの意味を保持する |
| 選択だけの変更 | Storeの選択用経路。Project変更とは区別し、保存予約を発生させない |
| ViewのZoom / Pan、ペイン幅、開いているDialog | UI状態。既存のlayout保存は維持し、Project履歴へ混ぜない |
| 一時Stroke、ドラッグ中の値 | 操作中の状態。確定・中止の寿命を持つ |
| 再生位置、時計、予約したSource | PlaybackController / AudioEngine |
| Projectを開いている単位と非同期処理の所属 | Session。`sessionId`で識別する |
| 確定編集の順序 | Session内の単調増加する`revision`。Undo/Redoも新しい通知番号を持つ |

`sessionId`と`revision`は実行中の識別情報とし、Project v5のJSONに保存しない。選択だけの変化にはProjectのrevisionを増やさず、専用のUI更新通知を使う。

### 7.2 Commandと確定後処理

Commandは追加、複製、移動、削除、尺、テキスト、Camera、音声、紙面設定など、実際に存在する編集操作を表す。初期段階では内部で既存の`Store.edit(fn)`を呼び、計算内容を変更しない。

提案する編集結果は次の情報を持つ。フィールド名は新規案である。

```js
{
  changed: true,
  selectionChanged: false,
  sessionId: "runtime-session-id",
  revision: 12,
  changes: {
    all: false,
    kinds: ["text"],
    panelIds: ["panel-id"],
    assetIds: []
  }
}
```

1. 同期的に編集候補を作り、Storeで検証・確定する。
2. 確定した変更だけを通知する。検証失敗は既存状態を保持した失敗結果とする。
3. Editorが通知を受け、現在と同じ順序で再生停止、dirty更新、Autosaver予約、表示更新要求を行う。
4. 無変更で選択だけ正規化された場合は、選択表示だけを更新する。
5. Undo/Redoも同じ確定後経路へ接続する。初期段階は変更範囲を`all`としてよい。

描画中は一時Strokeを直接プレビューし、確定時に一つのCommandを実行する。ドラッグやテキストの履歴をまとめる追加仕様は、この分離と同時に導入しない。現行の履歴粒度を試験で固定してから別変更として扱う。

### 7.3 非同期処理と終了処理

素材の読み込み、復旧、保存、出力には開始時のSessionを渡す。完了時に所属を照合し、古いSessionの結果を新しいProjectの画面や保存状態へ反映しない。結果が不要になった場合もBitmapなどの資源は解放する。

Project切り替えでは、旧Sessionの再生・操作プレビュー・購読を停止し、保留中の保存が参照するProjectを固定する。旧Sessionの保存自体は完了できるが、その完了通知で新Sessionを「保存済み」にしない。`schedule(() => globalStore.p)`のように、切り替え後の別Projectを遅れて読む接続を残さない。

Viewは`mount`、更新、`dispose`相当の寿命を持つ。イベント、Observer、AnimationFrame、タイマーの解除を所有者に集める。出力を継続する設計を選ぶ場合は、そのJobが保持するSnapshotと資源の寿命をSession切り替えから独立させる。

**検証:** 一つの確定編集につき保存予約・更新通知は一回、無変更では発生しない。Project切り替え中の遅いデコード・保存完了が新画面に混ざらない。同じ画面を繰り返し開閉してもイベントが重複しない。

**完了条件:** 既存挙動を保った状態で`app.js`からCommand、Session、画面単位の所有責任が分離される。M1では全体renderを互換経路として維持する。

### 7.4 実装済みの第一段階

`src/editor-session.js`を追加し、`app.js`の編集、選択、Undo/Redo、Project差し替えを`EditorSession`経由へ移した。Sessionには実行時IDとrevisionがあり、変更結果を`kind`、`changed`、`selectionChanged`、`sessionId`、`revision`付きで返す。Project差し替え時はSession IDを更新するため、差し替え前に取得したTokenを現在Sessionとして扱わない。

素材読み込みは開始時のProjectとSession Tokenを捕捉し、非同期処理後にTokenが古ければ現在画面の再描画を行わない。既存の全体`render()`、Storeの深い複製、保存方式、UIの副作用順序はこの段階で維持している。これはM1完了ではなく、Session境界を先に導入した移行コミットである。

## 8. M2 — 保存の原子性と整合性

### 8.1 Storageの一括確定API

`storage.js`へ、同じデータベース内の複数操作を一括確定するAPIを追加した。`MemoryStorage`は検証後に失敗時ロールバックし、`IndexedDbStorage`は対象storeを1つのreadwrite transactionにまとめ、transaction完了を成功条件にする。

```js
await storage.batch([
  { type: "put", store: "payloads", key: snapshotId, value: json },
  { type: "put", store: "snapshots", key: snapshotId, value: metadata }
]);
```

- 全操作の成功か全操作の不成立のどちらかとする。
- IndexedDBでは対象のobject storeを含む一つのreadwrite transactionへrequestを登録し、transactionの完了を待って成功を返す。個々のrequestの成功だけで保存済みにしない。
- JSON化、ハッシュ、デコード、ユーザー操作待ちはtransactionを開く前に終える。transaction中に無関係な非同期処理を待つ契約にはしない。
- MemoryStorageでも操作を検証・複製してから一括反映し、途中で例外が起きたら元のMap群を維持する。
- 対象storeを追加しない場合、このAPI追加だけでIndexedDBのschema versionを変更する必要はない。実装で確認する。

### 8.2 RepositoryとAutosaver

1. 不変のProject、`sessionId`、`revision`を保存開始時に捕捉する。
2. 既存のvalidateとJSON化を行い、その同じProjectからmetadataとAsset ID一覧を作る。
3. payload / snapshotをbatchで確定する。
4. transaction確定後に、その保存要求の成功を通知する。
5. その後に保持数整理を行う。確定済み保存の成功と、古い保存の整理失敗は別の結果として扱う。

保存中に新しい編集が来たら、最新の要求を次の保存へ残す。直列の保存処理が古いrevisionの完了で新しいrevisionを保存済みにしてはいけない。手動保存とAutosaverも同じRepositoryの確定経路を利用する。

通常600ms、連続編集時4000msの予約規則、Quota時の一回だけの再試行、最新8件と範囲外の最新手動保存の保持は維持する。Quota対処で削除するpayloadとsnapshotも対で扱い、最新の正常保存と保持対象の手動保存を保護する。保護した保存まで失わなければ再試行できない場合は、既存保存を保って失敗を返す。

通常のProject保存は、既存仕様で許している素材欠落と差し替えの経路を維持する。M8の「素材を全て同梱したBundle」の完全性判定とは分ける。

### 8.3 GCと同時処理

永続Asset GCの到達可能集合には、現在Project、Undo/Redo、保持Snapshotに加え、保存途中、Import途中、実行中の出力が使用する原本を含める。参照集合を登録してから非同期処理を開始し、確定または破棄後に解除する。

保存・保持数整理・GCの競合をRepository内で直列化し、削除直前に保護対象が変わっていないことを確認する。壊れたSnapshotから参照を安全に確定できない場合は、証明できない原本削除を保留する。

Repository内のキューだけでは複数タブを排他できない。初期実装は、書き込みと永続GCのタブ間排他を確認できない環境では破壊的なGCを保留する。排他方式を導入するときは、別タブの未保存状態と履歴を保護できることまで試験し、「DB接続が一つにまとまる」ことを排他保証と混同しない。

**検証:** payload書き込み後のtransaction abort、metadata失敗、Quota再試行失敗、保存中の編集・Undo・Project切り替え、手動保存との競合、GCとの競合を扱う。再読み込み後の復旧候補が旧保存か新保存の完全な組になることを、MemoryStorageの試験に加え実ブラウザのIndexedDBでも確認する。

**完了条件:** 完了通知、payload / metadata、dirty表示の三者が同じ保存対象を指す。中断しても最後の正常保存を復旧できる。

### 8.4 実装済み結果

- `Repository.#write()`はpayloadとsnapshotを`Storage.batch()`へ渡し、現行Storageでは複数storeを同じ確定単位で保存する。`batch`を持たない旧アダプターには従来の逐次書き込みと失敗時削除を残した。
- `MemoryStorage`の失敗時ロールバック、入力検証、Repositoryの保存・復旧経路をNodeテストで追加し、テストは82件すべて成功した。
- 実ブラウザのIndexedDB transaction完了経路は、環境にPlaywrightがないため未実行である。ブラウザsmoke環境を用意した時点で追加検証する。

## 9. M3 — Storeの構造共有と変更情報

### 9.1 移行方式

任意のオブジェクトを書き換えられる既存の`edit(fn)`へ、単純な浅いコピーだけを渡す変更は行わない。過去履歴とcurrentを同時に壊す可能性があるため、部分複製には書き込み範囲を把握できるAPIが必要になる。

1. 既存callbackは従来の複製と検証を通す互換経路として残す。
2. `editPanel(id)`、`editShot(id)`、`editAudioClip(id)`、`editPaper()`相当の編集用Accessorを持つDraftを実装する。
3. 初めて書き込むときに、その対象とProjectまでの祖先配列・オブジェクトを複製する。未変更の兄弟、Asset、Paperなどは参照を共有する。
4. 構造変更では関係するScene / Shot / Panel経路と、必要なAudioClip整理を一つの編集として確定する。
5. 読み取り用に公開する確定状態は変更させない。共有される可変オブジェクトのfreezeまたは同等の保護を用意し、その費用も測定する。既存Stroke / pointsの共有とfreezeを維持する。
6. Draftを使う新しい経路もStoreの同じ確定・検証・履歴処理へ接続する。段階的にCommandを移す。

テキストと尺の変更から始め、Camera、音声、紙面、最後に分割・統合・複数Panel移動を移す。各操作の移行が終わるまでは互換経路を残す。

### 9.2 変更通知の正しさ

変更種類の候補は`structure`、`timing`、`text`、`visual`、`camera`、`audio`、`assets`、`paper`、`projectMeta`とする。対象のPanel / Shot / Scene / Asset IDを必要な範囲で含める。

通知はCommand名だけから楽観的に決めず、確定した変更に基づく。たとえばPanel削除は構造・時間・選択に加え、Anchor音声の削除を含む。判定できないcallbackは`all`とし、正しさを優先する。

値を書いて元へ戻した操作や、同じ値の再設定は無変更と判定する。無変更でfutureを消さない。Undo/Redoの逆方向にも同じ変更範囲を適用できない段階は、全無効化を使う。

初期実装では全体validateを残す。部分複製が入っても、検証と変更比較が全体を走査するなら編集全体がO(1)になったとは扱わない。差分検証は、未変更部分の不変性、ID一意性、Asset / Anchor参照の検証を保てることが示せた後の別変更にする。

**検証:** 旧callbackと新Draftへ同じ編集列を与え、Project、選択、past / future、例外時の状態が一致する。確定済みStrokeや未変更の枝の参照が共有され、過去のProjectを後から変更できない。全履歴をUndo / Redoした後もAsset参照が正常である。

**完了条件:** 頻度の高い編集が対象の枝だけを複製し、変更通知が正しい。互換経路の削除は全Command移行後に独立して行う。

## 10. M4 — 派生データと部分更新

### 10.1 時間索引と現在の内容を分離する

`project-index.js`はPanel IDから現在の位置を引く索引と、Panel順・開始終了フレームだけを持つ時間索引を用意する。初期版は構造または尺が変わったときに時間索引全体を再構築してよい。部分的な累積和更新は、その後に必要性を測って判断する。

重要なのは、時間索引を再利用したときに古いPanelオブジェクトまで使い回さないことである。`flatten()`のrowがPanel参照を持つ場合、時間情報をID基準で保存し、描画や紙面評価へ渡すrowは現在のProjectから再結合する。テキスト、Stroke、Camera、画像の変更が時間キャッシュに隠れて消えない構造にする。

`flatten()`を同値性の基準とし、最適化したrow列のID、順序、開始終了、現在のPanel内容が一致することを確認する。新しい時間規則を索引側へ作らない。

紙面の`layoutPages()`など、内部で音声の絶対位置を計算する関数にも、検証済みの派生値を渡せる引数またはAdapterを追加する。省略時は既存の計算経路を使い、渡す場合は対応するProjectの構造・時間・音声の更新番号が一致することを確認する。画面側だけにキャッシュを置いて紙面側が毎回再計算する状態を残さない。

### 10.2 無効化の対応表

| 変更 | 再計算する主な派生値 | 更新する主な画面・出力情報 |
|---|---|---|
| title / Scene名 / Shot名 | 表示ラベル、必要な紙面情報 | Header、Tree、Breadcrumb、該当Inspector、紙面 |
| dialogue / sound / notes | 紙面文字列、折返しとページ配置 | 編集対象の文字表示、紙面プレビュー |
| Stroke / image / opacity | 対象Panelの描画、サムネイル | Stage、該当Strip / Tree画像、紙面・Animaticの描画情報 |
| Camera | Camera評価の入力と表記 | Stage、該当サムネイル、Camera Track、Inspector、紙面 |
| Panelの尺 | 時間索引、音声絶対位置、Snap、選択範囲 | Timeline、時刻・尺表示、再生位置、紙面 |
| Panelの順序・所属・追加削除 | ID索引、時間索引、音声位置、選択の正規化 | Tree、Strip、Timeline、Inspector、紙面 |
| AudioClipの位置 / trim / gain / Asset | 音声解決と予約情報、音の注記 | Audio Track、音声Inspector、紙面、出力音声 |
| 素材デコード完了 | そのAssetを使う描画または波形 | 該当Panel / Clip。Project履歴と自動保存は増やさない |
| PaperSettings | 紙面の幾何、テキスト配置、ページ列 | 紙面Dialog |
| fps | 時間の秒換算、目盛、音声予約、紙面・Animatic計画 | 時間依存の表示全体。M6の互換性規則に従う |
| 選択のみ | 選択範囲、Inspectorの入力先 | 選択装飾、Inspector、Stage、必要な追従 |
| Scroll / Zoomのみ | 可視範囲、画面座標、目盛 | Timelineまたは対象View |
| 再生位置のみ | 現在rowとCamera値 | Stage、Playhead、時刻表示、必要な追従 |

これは最小範囲を決める設計表である。実装時に各Viewが実際に読んでいるフィールドを照合し、不明な依存は全更新側へ倒す。Paperの文字変更は続き行・後続ページへ影響するため、対象行の文字だけを差し替えて済ませない。

### 10.3 画面更新

1. 同じ描画機会までに来た更新要求をまとめ、最新revisionの状態を一度読む。
2. Tree、Strip、TimelineはIDをキーとして既存DOMを再利用し、変更・追加・削除したノードだけを扱う。
3. Timelineの可視範囲制限とサムネイルの遅延描画は維持する。Observerの対象だけを更新し、毎回全Observerを作り直す経路を減らす。
4. Inspectorの編集中要素は不用意に置換しない。フォーカス、選択範囲、日本語IME変換中の内容を保持する。
5. スクロール、再生ヘッド、選択だけの更新ではProject全体の派生値を作り直さない。
6. 互換用の全体renderを残し、同じ状態を全体renderした画面と部分更新した画面が一致するか、開発時に比較できるようにする。

**検証:** テキストだけの変更で時間索引と`resolveClips()`を再計算しない。尺が変われば後続PanelとAnchor音声が移る。索引を再利用してもCamera・Stroke・台詞が現在値になる。スクロールでInspectorの入力が失われず、表示範囲外から入ってきたPanelも最新状態になる。

**完了条件:** 無効化表に従った更新と全体renderの結果が一致する。500 / 2000 Panelで処理回数とp95を比較し、速度改善または残る費用を数値で説明できる。

## 11. M5 — AssetManagerと資源の寿命

### 11.1 取得と解放の契約

AssetManagerは原本の保存責任をRepositoryへ委ね、表示・出力・音声で必要なデコード済み資源を提供する。取得時には要求用途と解像度を渡し、成功した取得は使用権と解放関数を返す形にする。

```js
const lease = await assets.acquireImage(assetId, {
  purpose: "export",
  maxDimension: requestedDimension,
  signal
});
try {
  drawWith(lease.bitmap);
} finally {
  lease.release();
}
```

同じ取得要求は進行中Promiseを共有する。一つの利用者の中止で別の利用者の取得を壊さない。利用者がいなくなった場合だけデコード中止を試み、中止できないAPIでは完了後に不要な結果を解放する。

永続Asset IDが指す原本内容は不変とする。素材の差し替えでは新しいAsset IDを作り、対象のProject参照を一回のStore編集で変更する。元のIDと原本は履歴・Snapshot・実行中Jobの参照がなくなるまで保持する。キャッシュの無効化だけで、過去のProjectが参照する原本の上書きを補えるとは扱わない。

キャッシュキーにはAsset ID、要求解像度、用途、必要なデコード条件を含める。差し替え後の新IDを確実に参照し、旧Sessionの取得完了を新しい要求へ混ぜない。既存実装に原本を同じIDへ上書きする経路が見つかった場合は、この移行で新IDの発行へ置き換える。

### 11.2 容量と解像度

| 資源 | 管理方針 |
|---|---|
| 原本Blob | Repositoryの永続到達可能性で保持する |
| 表示用Bitmap | 現在の長辺2048px方針を初期値として維持し、未使用のものを容量予算に従って追い出す |
| 出力用Bitmap | 出力先の画素数とCamera拡大に応じて原本から用意する。表示用縮小画像を無条件に流用しない |
| AudioBuffer | デコードは共有し、使用中のSourceや出力がある間は保持する |
| 波形 | 不変の原本を指すAsset IDと列数をキーにし、列数の異なるキャッシュが際限なく残らないようにする |
| Object URL | Dialog、プレビュー、ダウンロードなどの所有者が不要になった時点でrevokeする |

容量は件数だけでなく推定バイト数で管理する。RGBA画像は幅×高さ×4、PCMは長さ×チャンネル数×4を目安にできるが、ブラウザ内部の総使用量と一致するとは扱わない。初期予算はM0の実素材計測で決め、テストでは小さい予算へ差し替えられるようにする。

LRUなどによる追い出しは未使用のデコード結果だけを対象とする。使用中の資源が予算を超える場合は同時取得数や解像度を調整するか、要求を失敗させる。描画中のBitmapを解放して見かけ上の上限を守らない。

Bitmapは使用権がなくなった後に`close()`する。AudioBufferは存在しないclose操作を想定せず、Sourceの停止・切断と不要な参照の除去を行う。履歴やSnapshotが原本を保護していても、対応するBitmap / PCMを全て常駐させる必要はない。

### 11.3 移行順序と検証

画像の原本取得とデコードを先に移し、既存描画APIへは使用権を保持したMapのAdapterを渡す。次に音声バッファ、最後に波形を移す。AudioEngineは再生Sourceと接続を管理し、音声位置の純粋計算をAssetManagerへ混ぜない。

**検証:** 同時取得の重複、Project切り替え中の完了、原本差し替え、低容量での追い出し、Undoによる再表示、出力中のGC、失敗時の解放を確認する。差し替え前の履歴・Snapshot・Jobが元の原本を参照し続け、原本を残したままキャッシュを解放・再構成できること、Stage・サムネイル・高解像度出力が必要な画像を取得できることを確認する。

**完了条件:** 画像Map、音声Buffer、波形の所有者と解放箇所が一意になる。大量素材の閲覧を繰り返しても未使用キャッシュが予算を超えて単調増加しない。

## 12. M6 — 時間単位とPlaybackController

### 12.1 互換性を先に確定する

| 値 | 現在の記録形式 | 初期実装での扱い |
|---|---|---|
| Project fps | 整数1..120 | 対応範囲を維持する |
| Panel.frames | Project上の整数フレーム | 尺の基本単位として維持する |
| CameraKey.t | Panel内の0..1の比率 | 尺変更時の相対位置と既存補間を維持する |
| AudioClip.anchor / at | Panel IDと相対フレーム | `resolveClips()`の規則を維持する |
| AudioClip.frames | 整数フレーム | 現行のtrimと終端規則を試験で固定する |
| AudioClip.offset | 素材内の整数フレーム | 基準fpsを実装で確認し、既存データと同じ解釈を保つ |
| AudioContext / performanceの時計 | 秒 / ミリ秒による実行時の時計 | 相互変換を一つの窓口へ集める |

関数と引数名で`projectFrame`、`sourceSeconds`、`panelRatio`を区別する。秒からフレームへの変換には丸め規則を明示し、Panel判定、スナップ、出力フレームのサンプリングを一つの丸め方に無理に統一しない。各用途の現行境界規則を守る。

fps変更UIの有無や挙動は参照文書では確定しない。初期段階では挙動を変更せず、変更が存在する場合の「秒数を保つか、フレーム数を保つか」を試験と仕様へ記録する。

将来AudioClipのoffsetを秒やサンプル数で保存するなら、旧Projectのfpsを使った変換の根拠、Versionを上げる必要性、丸め誤差、旧ファイルの読み込みを別の移行計画にする。v5の値を同じフィールド名のまま別単位として扱わない。

### 12.2 再生制御の分離

PlaybackControllerが再生、停止、シーク、主時計の選択、AnimationFrame、AudioSourceの寿命をまとめる。音声ありではAudioEngineの時計、音声なしでは既存の時間計算を使い、`rowAtFrame()`と`cameraAt()`を共有する。

まずは現在の末尾までの音声予約を保つ。長いProjectで予約Source数が支配的と計測された場合に限り、先の一定区間を順次予約する方式を追加する。その場合はシーク・停止後の重複予約、予約期限、バックグラウンド時のタイマー停止を試験し、ブラウザで保証できる範囲を記録する。

**検証:** Panel境界の前後、最初と最後のフレーム、1フレームPanel、音声あり / なし、途中再生、Offsetとtrim、再生中の編集、fps変換後の出力計画を確認する。実時間録画の評価はPNGのフレーム一致試験と分ける。

**完了条件:** 時間の意味が関数の契約として読め、既存Projectで再生位置と音声の切り出し位置が変化しない。

## 13. M7 — ExportControllerと書き込み先

### 13.1 出力SnapshotとJob

開始時にProject、revision、紙面設定、時間評価用のrow、ページまたはフレーム計画を固定する。画像Mapの参照をコピーするだけで資源の寿命まで固定できたと扱わず、必要な原本とデコード資源の使用権を持つ。

最初に紙コンテPNG、次にAnimatic PNG、最後にWebMと印刷をControllerへ移す。Dialogは入力値、開始、進捗、中止、成功・失敗の表示を担当する。JobはRenderer、Encoder、Sink、資源の後始末を担当する。

Jobは準備中、処理中、完了処理中、成功、中止、失敗を区別する。成功・中止・失敗のどの経路でも終了処理は一度だけ行い、中止を成功として表示しない。出力中の編集を許す場合も、出力内容は開始時のSnapshotを使う。

### 13.2 Sink契約とメモリ

```js
await sink.write(bytes); // 戻るまで次の塊を増やさない
const result = await sink.close();
// 失敗または中止の経路
await sink.abort(reason);
```

初期Adapterは既存のBlobダウンロードへ接続する。対応環境ではファイルへの逐次書き込みAdapterを追加し、能力と書き込み先の準備を出力開始前に確定する。特定のブラウザAPIが全環境で使えるとは想定しない。

PNG連番は、一枚を描画、エンコード、ZIPへ追加、Sinkへ排出してから次へ進む。ZIPのCRCとサイズは逐次計算し、必要に応じて後続の記録で確定する。エントリ情報を最後に記録するためのメタデータは別に保持する。

逐次出力でもZIPの目次情報はエントリ数に応じて増える。目標は「全PNGの合計サイズをメモリに保持しないこと」であり、総メモリが完全に一定になることではない。従来ZIPで表現可能なサイズ・件数の上限を検査し、ZIP64は別対応とする。

Blobへのフォールバックは完成ファイル分のメモリを必要とする。見積もりと累積サイズの上限を設け、Blob生成時の一時的な追加使用量も考慮する。逐次ファイル書き込みと同じメモリ特性だとは表示しない。

PNG処理のブラウザへの制御返却は、現在の4フレーム単位を出発点に、経過時間による上限も検討する。ただし一回のCanvasエンコード中など、中断できないAPIの処理時間まで中止応答を保証しない。

### 13.3 WebMと印刷の扱い

WebMはMediaRecorderによる実時間録画のまま扱う。PNGの逐次処理と同じ速度制御やフレーム精度を約束しない。録画チャンクを逐次書く場合はキュー容量を制限し、書き込みが追いつかないときの失敗・途中データ破棄を明示する。無制限のPromiseキューに置き換えない。

中止・失敗時はRecorder、MediaStreamのTrack、AudioSource、Object URL、Canvas、素材の使用権を後始末する。印刷/PDFは従来どおりブラウザ印刷を利用し、印刷に必要な画像の寿命が終わるまで保持する。

**検証:** 準備中、描画後、エンコード後、書き込み待ち、完了直前の中止と失敗を確認する。出力中のProject編集・素材差し替えでも開始時の内容を維持する。PNGは数と順序、画像、ZIPの整合性を確認し、WebMは映像変化、音声、長さ、同期、中止時の破棄を確認する。

**完了条件:** 出力がUIから独立して実行・中止でき、全終了経路で資源が解放される。逐次Sinkでは連番の全バイトを蓄積せず、Blob方式には実際の制限がある。

Worker化は、この分離後もメインスレッドの描画・エンコードが支配的な場合に追加する。実装する際は共有Bitmapの所有権を不用意に移譲せず、フォント、テキスト計測、消しゴム合成、非対応環境の一致を確認する。

## 14. M8 — 素材を同梱するProject Bundle

### 14.1 形式案

既存の`.contp` JSONの読み書きを維持し、素材付きの別形式を追加する。仮の拡張子は`.conte.zip`、外側の形式Versionは1とする。ProjectのVersionとは独立して管理する。

| ZIP内の項目 | 内容 |
|---|---|
| `manifest.json` | 形式識別子、Bundle Version、Projectのパス、素材一覧 |
| `project.contp` | 既存のProject JSON |
| `assets/000001.bin`など | 原本バイナリ。表示名やAsset IDをそのままパスにしない |

Manifestの素材一覧にはAsset ID、格納パス、MIME、バイト長、内容照合用のSHA-256を持たせる案とする。大きな素材のハッシュ計算は素材ごとに行い、Bundle全体を一度にバッファ化しない。利用するハッシュAPIに入力全体のバッファが必要な場合は、一素材分の上限を扱い、逐次ハッシュを実装するか制限を明示する。

初期writerは既存の無圧縮ZIPを再利用する。readerは本アプリが出力する形式を対象とし、圧縮方式・ZIP64・外部生成ZIPへの対応範囲を明示する。全ZIP形式へ対応するために独自の汎用展開器を作り込まない。

### 14.2 Export

1. 開始時のProjectと参照するAsset IDを固定し、原本をGCから保護する。
2. Projectに必要な原本が揃っているか調べる。不足がある場合は、完全なBundleとして成功させず、不足素材を特定する。
3. メタデータと内容を照合し、Project、素材、ManifestをM7のSinkへ順次書く。Manifestの実際の書き込み順は、ハッシュとサイズの確定タイミングに合わせてよい。
4. 完了または中止時に原本の保護を解除する。

### 14.3 Importと失敗時の境界

1. 形式識別子、Version、エントリの重複、パス、件数、宣言サイズ、実サイズを検証する。パスの正規化後に衝突する項目や想定外の参照を拒否する。
2. Projectを既存の`load()` / `migrate()` / `validate()`へ通し、ManifestとのAsset参照整合を検証する。
3. 素材のバイト長とハッシュを確認し、Import作業IDに属する一時的な到達可能集合へ登録して保存する。現在の編集Projectへはまだ公開しない。
4. 既存の同じAsset IDが同一内容なら再利用する。内容が異なる場合は新しいIDを発行し、Project.assets、Panel.image.assetId、AudioClip.assetIdをまとめて付け替える。既存Snapshotが指す原本を上書きしない。
5. 最終確定直前にSessionと切り替え対象を照合し、短い確定区間では編集との競合を防ぐ。旧Projectの保留保存はそのProjectへ固定する。
6. Projectのpayload / snapshotと、一時Import状態から正式な到達可能状態への移行をM2のtransactionで確定する。素材本体を事前保存する方式では、正式参照の公開を最後に行う。
7. 永続確定後にStoreを切り替える。検証失敗・キャンセル・容量不足では旧Projectと履歴を維持し、作業専用の未参照素材を後で回収できるようにする。

読み込み直後の画面表示のためだけに全素材を同時デコードしない。必要なものからM5の管理を通して取得する。

**検証:** 新規ブラウザの空のIndexedDBへExportしたBundleをImportし、画像、音声、Camera、紙面、再生が復元される。旧`.contp`も読み込める。欠落、改ざん、破損ZIP、未知Version、同じIDの異なる原本、途中失敗、容量不足では既存データが変化しない。

**完了条件:** 別環境への持ち運びを、素材差し替えなしで再現できる。Bundle形式とProject schemaの互換性が個別に検証されている。

## 15. 検証の担当箇所と合格条件

### 15.1 既存試験へ追加する観点

以下は将来追加・拡張する試験の配置案である。この計画書の作成時には実行していない。

| 対象 | 既存または新規の配置案 | 主な保証 |
|---|---|---|
| Command / Session | 新規`tests/application.test.js` | 一度だけの副作用、古いSessionの結果の遮断、購読解除 |
| Store / Draft | `tests/model.test.js`、`tests/stability.test.js` | 旧経路と新経路の編集結果、履歴、選択、失敗状態の同値性 |
| 派生値 | 新規`tests/project-index.test.js`、`tests/timeline.test.js` | `flatten()`との一致、古いPanel参照の排除、無効化の漏れ |
| 保存 | `tests/storage.test.js`、`tests/repository.test.js` | transaction単位の成功、Quota、保持、dirty、同時GC |
| AssetManager | 新規`tests/assets.test.js` | 共有取得、用途別キャッシュ、原本の不変性、使用権、容量、解放 |
| 時間と再生 | `tests/playback.test.js`、`tests/audio.test.js`、`tests/animatic.test.js` | 境界、単位、音声Offset、時計、再生停止 |
| 出力 | `tests/paper.test.js`、`tests/animatic.test.js`、新規`tests/export-controller.test.js` | 内容固定、Sinkの待機、中止、失敗、後始末 |
| Bundle | 新規`tests/project-bundle.test.js`、`tests/migration.test.js` | 形式互換、素材照合、ID衝突、原子的Import |
| ブラウザ | `scripts/browser-smoke.mjs`を用途別に拡張する案 | IME、実IndexedDB、Canvas、Web Audio、MediaRecorder、復旧 |

MemoryStorageの成功だけでIndexedDBのtransactionを検証したとは扱わない。Node上のAudioEngine試験だけで実機の音声遅延を確認したとも扱わない。実ブラウザでも直接再現できない強制終了や容量条件は、何を故障注入で代替したか記録する。

### 15.2 性能の判断方法

| 指標 | 評価方法 | 合格の考え方 |
|---|---|---|
| 確定編集 | 同一環境でp50 / p95と処理内訳 | 非対象操作を悪化させず、改善対象の費用を削減できている |
| 小さな文字編集 | 派生関数の呼び出し回数と次の描画までの時間 | 時間索引と音声解決を再計算せず、現在の表示内容が正しい |
| Scroll / Playhead | DOM生成数、時間索引再計算数、長いタスク | 可視範囲と表示位置だけの変更として処理できる |
| 自動保存 | debounceとJSON / transaction時間を別記 | 待機時間短縮と保存処理高速化を混同しない。失敗時の整合を優先する |
| 素材メモリ | 推定キャッシュ量、使用権数、反復後の解放 | 未使用資源が予算に従って減り、使用中資源を破壊しない |
| PNG出力 | 出力サイズと保持バイト数、Job終了後の資源 | 逐次Sinkで全PNGの合計バイトが常駐しない |
| 中止応答 | 中止要求から停止と解放までを別計測 | 中止点ごとに上限の原因を説明でき、二重終了しない |

性能の具体的な数値目標はM0で対象環境と計測区間を揃えてから定める。60Hzの一フレームが約16.7msであることはUI設計の参考にするが、現行の文書報告値と異なる区間へそのまま合否閾値を適用しない。改善率を計画段階で保証しない。

各段階では対象の試験と既存の関連試験を先に実行し、統合時に全体smokeとbuildを確認する。再計測や試験の追加は、残る具体的なリスクを解消するために行う。

## 16. コミットの切り方と戻し方

下表は実装コミットの切り方と戻し方である。C02のSession境界第一段階とC04のStorage batch / Repository移行は実行済みで、その他は未実行である。

| 順序 | コミット案 | 一つの変更として確認すること | 差し戻し方針 |
|---|---|---|---|
| C01 | `test: record editor contracts and performance baseline` | M0の現状照合と基準 | アプリの挙動を変えない |
| C02 | `refactor: centralize editor commands and session lifecycle` | M1の確定後処理、非同期の所属。Session境界の第一段階を実施済み | 既存Storeとrenderを利用する接続へ戻せる |
| C03 | `refactor: extract editor views and playback ownership` | UI購読・再生資源の所有者 | 計算と保存形式を変えずに戻せる |
| C04 | `fix: commit project snapshots atomically` | M2のStorage batchとRepository（実施済み） | 既存store・既存metadataを読める状態を維持する |
| C05 | `fix: isolate save revisions and protect active assets` | Autosaver、GC、Session境界 | GCを保留する保守的経路を残す |
| C06 | `refactor: add copy-on-write edits to project store` | M3のDraftと高頻度Command | 旧callback経路を維持する |
| C07 | `refactor: migrate structural edits to change-aware store` | 構造操作、Undo/Redo、変更情報 | 全無効化へ戻して表示の正しさを保つ |
| C08 | `perf: cache project timing and derived data` | M4の索引、現在のPanelとの結合 | `flatten()`による全再計算を互換経路にする |
| C09 | `perf: update editor views by changed data` | DOM再利用、IME、Observer、部分更新 | 互換の全体renderへ戻せる |
| C10 | `refactor: manage image and audio asset lifetimes` | M5の取得、容量、解放 | 原本の保存形式を維持し、取得Adapter単位で戻す |
| C11 | `refactor: make timeline time units explicit` | M6の変換と互換性 | Project v5の解釈を変えない |
| C12 | `refactor: run exports through isolated jobs` | M7のSnapshot、Controller、後始末 | 既存の出力形式とBlob Adapterを維持する |
| C13 | `feat: stream png exports to output sinks` | Sink、ZIP、容量上限、中止 | 対応環境での逐次方式を外し、上限付きBlobへ戻せる |
| C14 | `feat: export projects with their source assets` | M8のBundle writer | `.contp`の書き出し経路を維持する |
| C15 | `feat: import project bundles atomically` | reader、ID衝突、段階的確定 | 通常Projectと原本は既存Repositoryで読み続けられる |

C03の再生所有者の抽出では時間計算を移さず、C11で単位変換を整理する。各コミットでARCHITECTURE.mdを実装済みの範囲だけ更新し、テスト結果と残る制限を記録する。

不具合が出た場合は、該当する最小の変更を戻す。保存形式を変える将来の変更では、既に書いたデータを旧バージョンが読めるかを確認してからコードを戻す。DBの削除やユーザーの保存データの初期化を、リファクタリングの通常の戻し方にしない。

## 17. 実装完了チェック

実装が完了した段階だけチェックする。

- [ ] M0: 現行コードと文書の差異、試験基準、計測条件を記録した。
- [ ] M1: 編集結果の通知とSessionの寿命が一元化されている。
- [ ] M2: 保存の一括確定、保存中の編集、GC競合を検証した。
- [ ] M3: 部分複製が履歴・選択・無変更判定・検証を維持している。
- [ ] M4: 部分更新と全体更新が同じ結果になり、古いデータを表示しない。
- [ ] M5: 素材の用途別取得、容量管理、使用中の保持、解放が機能する。
- [ ] M6: 既存ファイルの時間解釈を保ち、単位と丸め規則を記録した。
- [ ] M7: 出力の内容固定、中止、失敗、Sink、資源解放を検証した。
- [ ] M8: 空の別環境で素材付きProjectを復元でき、Import失敗で既存Projectが変わらない。
- [ ] 統合: buildした配布物でimportが解決し、描画・再生・紙面・復旧のsmokeが通る。
- [ ] 統合: 改善前後の測定と実機で未検証の範囲を記録した。
- [ ] 文書: ARCHITECTURE.mdが実装済みの構造と一致している。

この更新時点で実施済みなのは、M0のコード照合・Node/build検証、M1のSession境界第一段階、M2のStorage batchとRepository移行である。M0のブラウザsmoke、M1の画面責務分離、M2の並行保存・GC・revision隔離、M3以降の実装、性能改善は未完了である。

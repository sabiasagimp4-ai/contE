# contE 構造改善の実装計画

作成日: 2026-09-14  
状態: 実装進行中。M0のコード照合と基準テスト、M1のSession境界第一段階、M2のStorage batch・Repository移行・保存revision隔離の第一段階を実装済み。本文中で実装済みと明記していない新しいモジュール、API、試験、性能目標は提案である。


**最新の着手計画:** [§18「主要コード読解後の詳細実行計画」](#18-主要コード読解後の詳細実行計画2026-09-14追補)。確認済み不具合3件を先に修正し、R00〜R20の作業単位・依存関係・担当境界・合格条件を定義した。§1〜17の初版記録と実装済み履歴は保持する。

## 1. 根拠と対象範囲

初版の技術的な参照元は、[ARCHITECTURE.md](./ARCHITECTURE.md) のみであった。主要コードの読解を求める追加依頼を受け、§18では実装を直接参照して計画を更新した。以下の基準表は初版の履歴として保持する。

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
- 既存のNodeテストは73件すべて成功し、Session追加後は78件、Storage batch追加後は82件、保存revision検証追加後は83件すべて成功した。
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

`src/editor-session.js`を追加し、`app.js`の編集、選択、Undo/Redo、Project差し替えを`EditorSession`経由へ移した。Sessionには実行時IDとrevisionがあり、変更結果を`kind`、`changed`、`selectionChanged`、`sessionId`、`revision`付きで返す。Project差し替え時はSession IDを更新するため、差し替え前に取得したTokenを現在Sessionとして扱わない。保存経路ではSession IDとrevisionの両方を照合する。

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

保存revision隔離の第一段階を実装した。Autosaverは予約時のtokenを保持し、完了時に`isCurrent`が偽なら成功表示と予約解除を行わない。`app.js`はSessionのrevisionを予約へ渡し、手動保存後のAsset GCと保存済み解除もtoken一致時だけ行う。失敗時の再試行、Quota再試行、既存のSnapshot保持規則は変更していない。

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
- AutosaverにSession tokenのrevision照合を追加し、古い保存完了の成功表示とAsset GCを抑止するテストを追加した。Nodeテストは83件すべて成功した。
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

下表は実装コミットの切り方と戻し方である。C02のSession境界第一段階、C04のStorage batch / Repository移行、C05の保存revision隔離第一段階は実行済みで、その他は未実行である。

| 順序 | コミット案 | 一つの変更として確認すること | 差し戻し方針 |
|---|---|---|---|
| C01 | `test: record editor contracts and performance baseline` | M0の現状照合と基準 | アプリの挙動を変えない |
| C02 | `refactor: centralize editor commands and session lifecycle` | M1の確定後処理、非同期の所属。Session境界の第一段階を実施済み | 既存Storeとrenderを利用する接続へ戻せる |
| C03 | `refactor: extract editor views and playback ownership` | UI購読・再生資源の所有者 | 計算と保存形式を変えずに戻せる |
| C04 | `fix: commit project snapshots atomically` | M2のStorage batchとRepository（実施済み） | 既存store・既存metadataを読める状態を維持する |
| C05 | `fix: isolate save revisions and protect active assets` | Autosaverのrevision隔離、手動保存後GCのtoken保護（実施済み） | GCを保留する保守的経路を残す |
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

この更新時点で実施済みなのは、M0のコード照合・Node/build検証、M1のSession境界第一段階、M2のStorage batch・Repository移行・保存revision隔離第一段階である。M0のブラウザsmoke、M1の画面責務分離、M2の保存中Asset使用権の登録、M3以降の実装、性能改善は未完了である。

## 18. 主要コード読解後の詳細実行計画（2026-09-14追補）

本節はユーザーの「実際に主要コードを読んで」「細かい実装計画を立てて」という追加依頼に基づく。初版の文書のみを根拠にした計画を、実装の読解結果で更新する。以後の着手順、ファイル配置、分担は本節を優先し、§1〜17の互換性・保存・出力の契約は引き継ぐ。R番号は今回の作業単位であり、既存のM番号・C番号を実装済みに変更するものではない。

### 18.1 基準と確認の限界

- 読解基準: main / `7ff48d63a65a9934184196c1e43e2fc6c10dd7f7`。計画追補前のツリーも同じコミットであることを確認した。
- 全文を読んだ主要モジュール: `app.js`、`model.js`、`editor-session.js`、`storage.js`、`repository.js`、`drawing.js`、`audio.js`、`playback.js`、`timeline.js`、`paper.js`、`exporter.js`、`animatic.js`。
- 関連確認: 保存関連テスト、モデル・安定性・ブラウザsmokeの該当箇所、`index.html`、`package.json`。
- 以下の「実行確認」は元のソースを使ったNode上の最小再現を指す。IndexedDBの接続APIは模擬した。実ブラウザやWindows実機で今回再現したという意味ではない。
- 過去の83件成功は§6.3の実施記録であり、この追補で全テストを再実行した結果ではない。今回の変更は計画書のみ。R00以降はすべて未実装である。

| 読解で確認したこと | 根拠 | 計画への反映 |
|---|---|---|
| Scene追加はShot.nameを省略し、validateで「不正なShot名」になる。最小実行でも追加失敗 | [app.js:706](https://github.com/sabiasagimp4-ai/contE/blob/7ff48d63a65a9934184196c1e43e2fc6c10dd7f7/src/app.js#L706)、model.jsのvalidate | R01で修正。モデルとUIで異なる生成処理を持たない |
| IndexedDbStorage.openのfinallyで別Promiseを比較し、openingが残る。close→openでも接続がnullのまま | [storage.js:91](https://github.com/sabiasagimp4-ai/contE/blob/7ff48d63a65a9934184196c1e43e2fc6c10dd7f7/src/storage.js#L91) | R02で接続の成功・失敗・再試行・終了を修正 |
| 始点と終点が同じ往復CameraをHOLDと判定。中間Camera値は実際に変化する | [model.js:565](https://github.com/sabiasagimp4-ai/contE/blob/7ff48d63a65a9934184196c1e43e2fc6c10dd7f7/src/model.js#L565) | R03で全区間の動きを判定し、紙面表記まで確認 |
| StoreはStrokeをfreezeして履歴間で共有するが、Scene/Shot/Panel/Camera等を毎編集で広く複製する | model.js Store.edit | 履歴機構を全面交換せず、R14で対象枝の複製へ移行 |
| 選択でもrenderがTree・Strip・Timeline等を再構築する | app.js select / render | R10〜R12でUI抽出と部分更新。先に変化通知の契約を定義 |
| PointerMoveごとに既存Strokeを含めてdrawする | app.js:923、drawing.js | R13で確定済み描画と入力中描画を分ける |
| 新規画像取込はawait後にactiveIdを取得。音声取込・差し替えにもSession照合がない | app.js:1022、1066、1133 | R06で非同期開始時の対象固定と遅い完了の遮断 |
| 波形は素材IDと列数だけで、clip.offsetと使用尺を反映しない。幅別キャッシュに上限がない | app.js soundClip、audio.js waveform | R08で実際の素材区間を表示、R09で容量管理 |
| 音声差し替えは同じAsset IDのバイナリを上書きする | app.js clipRepair | R07で原本を不変にし、Undo・旧Snapshotの意味を維持 |
| 保存payloadとmetadataのbatch、revision照合は既存。保存・GCの全操作を直列化するキューと実行中素材の保護は未完成 | repository.js、app.js persist | R05で既存機構を拡張する |
| 紙面出力はProject等を捕捉するが、Animaticループは可変のrows/images等を読む | app.js exportPages / animaticFrames / animaticRecord | R16で全出力に同じSnapshot規約を適用 |
| ZIPは全エンコード済みバイトをchunksへ保持する | exporter.js ZipBuilder | R17でSink導入。Blob方式のメモリ上限は別途残す |

UI操作を伴う競合・描画結果の問題は、コードから読み取れる条件として扱う。R06以降で制御可能な遅延や実ブラウザを用いて再現してから修正の合否を決める。

### 18.2 分散させる範囲と、集約する範囲

推奨は単一リポジトリ・単一アプリ内での責務分割である。ファイル数や一ファイルの行数を目標にしない。ネットワークサービス、別リポジトリ、全機能のWorker化はこの計画に含めない。

| 分ける責務 | 一つに集約する判断 |
|---|---|
| Tree、Stage、Timeline、Inspector、出力Dialogの表示 | Projectの正本とUndo/RedoはStore |
| 構造、テキスト、Camera、音声、紙面の編集規則 | 確定編集とrevisionはEditorSession |
| 画像・PCM・波形のデコードとキャッシュ | 原本の保存・保持・GCはRepository |
| 再生の時計と音源の寿命 | Panel境界、Camera補間、音声の時間規則は既存の純粋関数 |
| 出力の準備・描画・エンコード・書込 | 一つのJobのSnapshot・中止・終了状態はExportController |
| UIの更新要求 | 保存予約・dirty・描画要求の接続はEditorController |

編集エンジンにCanvasやDBまで集めない。一方、各Viewへ個別のStore・Autosaverを持たせない。汎用イベントバスを先に作らず、明示した引数と購読APIで接続する。

配置案は以下。既存公開パスは移行用窓口として維持し、名前だけの移動を先に行わない。

| 配置 | 内容・移行元 |
|---|---|
| `src/app.js` | 起動と依存の接続。各サービスの生成・disposeだけへ段階的に縮小 |
| `src/editor-session.js` | 既存のままSession ID・revision・Store寿命を担当。別のsession.jsを新設しない |
| `src/application/editor-controller.js` | execute、select、undo/redo、replace、購読。appの確定後処理を抽出 |
| `src/application/commands.js` | 初期は実際の編集コマンドを一つに抽出。肥大化した段階でstructure / camera / audio / paper単位へ分割 |
| `src/application/import-controller.js` | 画像・音声の取込と差し替え。Sessionと対象を捕捉 |
| `src/application/playback-controller.js` | appの再生・シーク・時計・音源寿命 |
| `src/application/export-controller.js` | appの紙面・Animatic Job管理 |
| `src/ui/tree-view.js`、`stage-view.js`、`timeline-view.js`、`inspector-view.js`、`export-dialog.js` | 表示・入力イベント・UI状態。必要時にInspector内を機能別に分ける |
| `src/ui/render-scheduler.js` | 更新要求を次の描画機会にまとめる |
| `src/model.js`、必要時の`src/model/draft.js` | 現行の検証・履歴・移行。R14の限定的な部分複製 |
| `src/derived/project-index.js` | ID・順序・時間の派生索引。Projectのコピーを正本にしない |
| `src/assets/manager.js`、`waveform.js` | 取得・解放と波形計算。再生用Sourceの所有者はAudioEngine |
| `src/storage.js`、`src/repository.js` | 既存の保存窓口を拡張 |
| `src/drawing.js`、必要時の`src/render/stage-cache.js` | 共通描画と編集時のキャッシュ |
| `src/export/sinks.js`、`src/project-bundle.js` | 出力先、素材付き形式 |

依存はUI→Application→Modelの方向とする。Storage・Canvas・Web Audioなどの実装はappから渡す。ModelはUIをimportしない。View同士は直接呼び合わず、選択・表示状態の通知を受け取る。小さな純粋関数一つずつをファイルに分ける必要はない。

### 18.3 並行作業より先に決める接続契約

R04で以下を確定し、以後の担当がそれぞれ別の解釈を作らない。

1. **編集:** 同期CommandをStoreの一回の編集で確定する。Command内部にawaitを入れない。非同期準備はControllerで行い、必要な入力を揃えてから確定する。
2. **編集結果:** `changed / selectionChanged / sessionId / revision / changes`を返す。changesは`all`または変更種類と対象ID。失敗は成功結果と区別して呼び出し元へ返し、成功通知を出さない。
3. **互換移行:** 任意callback・Undo/Redoの変更範囲を判定できない間は`changes.all = true`。通知漏れで古い表示を残すより全更新を選ぶ。
4. **副作用:** 一回の確定編集に対してdirty更新・保存予約・表示要求は一回。現行の「操作開始で再生停止」は当初維持し、無変更時の再生継続などのUX変更は混ぜない。
5. **非同期対象:** 取込開始時にSession、対象PanelまたはClip ID、音声の配置位置と種別を捕捉する。同じ作品で選択だけ変わっても元の対象に適用する。対象削除・Session切替・同じ対象への後続要求で古くなった場合は中止する。無関係なテキスト編集で取込全体を破棄する必要はない。
6. **保存要求:** `{ project, token, kind }`を捕捉する。旧要求が後から可変のglobalStoreを読まない。最新要求への集約はSessionごとに行う。
7. **資源:** acquireは使用権とreleaseを返す。デコード資源の保持と永続原本のGC保護は別の仕組みとし、Import・Save・Export中の原本IDもRepositoryへ登録する。
8. **View:** mount / update / dispose。購読・Observer・Pointer操作・RAFを解除できる。IME入力中の値を通常更新で上書きしない。
9. **出力:** Snapshot・素材使用権・仕様を開始時に固定し、出力ループは現在のEditor状態を読まない。成功・失敗・中止の終端通知とreleaseは一度だけ。
10. **時間:** v5のCamera比率・音声Anchor・offsetのProject fps基準を維持する。時間単位の変更や新しい固定方式は別仕様とする。

### 18.4 実装チケットと完了条件

各Rはレビュー可能な単位である。R10、R12、R14、R16は表内の順序で複数コミットへ分けてよい。原則として移動だけの変更と挙動変更を同じコミットにしない。

| ID | 実装内容と主な対象 | 前提 | 完了条件・主な検証 | 旧計画 |
|---|---|---|---|---|
| R00 | 現行SHAを固定。ブラウザ検証用依存・ブラウザVersionを再現可能にし、基準ログを採取。既存Node・build・browser smokeを確認 | なし | 成功・既存失敗・環境で未実行を区別。実ブラウザの利用不能を成功扱いしない | M0 |
| R01 | Scene/Shot生成関数をmodelに置き、appのScene追加で使用。既存初期Project・splitとの整合を確認 | R00の基準固定 | Scene追加→選択→Undo→Redo→保存/読込が成功。実際のdata-act=scene経路をブラウザで確認 | M0/M1 |
| R02 | IndexedDbStorage.openのPromise所有を修正。失敗後の再試行、close、versionchange、遅い成功を整理 | R00の基準固定 | 同時openは一要求。close後は新要求。失敗後再試行可。古い要求が新接続を上書きしない | M2 |
| R03 | describeCameraで全区間を比較。HOLDは全キーが許容誤差内で同じ場合のみ。往復の方向表示を定義 | R01と同じmodel変更を直列統合 | x:0→0.5→0、Zoom往復、回転往復がHOLDにならず、紙面に軌道が描かれる | M0/M6 |
| R04 | commandsとEditorControllerを抽出。追加/削除/複製→テキスト/尺→Camera→音声/紙面の順に既存計算を移す | R01〜R03 | UIとテストが同じCommandを使用。副作用一回。無変更・失敗で履歴と保存を増やさない | M1 |
| R05 | 手動/自動保存・保持整理・GCの協調をRepositoryへ集約。捕捉Project、直列キュー、原本保護、保存成功と整理失敗の区別 | R04 | 保存中編集/Undo/切替でも最新dirtyを誤解除しない。Import中素材をGCしない。実IndexedDBでも確認 | M2 |
| R06 | 画像/音声取込・復旧の非同期規約をImportControllerへ集約。開始時の対象固定、要求ID、中止・失敗通知 | R04/R05 | Aへ取込中にB選択してもAへ適用。作品切替/対象削除では適用なし。同時取込順序を制御した試験 | M1/M5 |
| R07 | 音声差し替えを新Asset IDで実装。デコード/保存成功後に対象参照とメタデータを一括編集 | R06 | Undoで旧音声に戻り、旧Snapshotも元の原本を参照。失敗時は元の音声と履歴を維持 | M5 |
| R08 | offset・使用尺・fpsから素材区間を求めて波形を生成。純粋なwaveform関数を分離 | R04 | 既知の位置にピークを持つ音で切出し表示を照合。素材外は無音。ズーム/trimで形が不正に伸縮しない | M5/M6 |
| R09 | AssetManagerへ画像/PCM/波形を順に移す。取得Promise共有、使用権、解像度別キャッシュ、容量予算、解放 | R05〜R08 | 小予算で未使用資源を排出。使用中資源は維持。切替・失敗・Undo・出力後に解放数が一致 | M5 |
| R10 | Tree→Inspector→Timeline→Stage→出力Dialogの順でView抽出。最初は全体更新を維持 | R04。Stage接続はR09と協調 | 各移動で挙動不変。mount/dispose反復でイベント・Observerが増殖しない。DOM IDとショートカットを維持 | M1 |
| R11 | 変更種類別の派生索引を追加。時間情報をIDで保持し、現在Panelを再結合。Audio解決も依存を明示 | R04 | flattenとの同値、文字変更で時間再計算なし、Camera/Stroke変更が古いrowに隠れない | M4 |
| R12 | render-schedulerとIDによるDOM再利用。選択→文字→scroll/zoom→構造変更の順で部分更新 | R10/R11 | 全体更新との表示一致。IME/フォーカス維持。選択とscrollで不要なTree/Inspector再構築なし | M4 |
| R13 | Stageの確定済み描画をキャッシュし、一時Strokeを別の作業面へ描く。描画はRAFごとに集約 | R09/R10のStage抽出 | 同じ入力で線・筆圧・消しゴム・拡大表示が一致。PointerCancelは履歴ゼロ、PointerUpは一回。旧フレーム残像も確認 | M4/M5 |
| R14 | Storeへ対象枝だけを複製する経路。文字/尺→Camera/音声/紙面→構造編集の順で移行 | R04/R11。modelの他変更完了後 | 旧経路と新経路のProject/選択/Undo/Redo一致。不変枝共有、外部からの履歴破壊防止。全validateは当初維持 | M3 |
| R15 | PlaybackControllerを抽出し、時計・停止・seek・音源の後始末を集約。時間変換名を明示 | R04/R09 | 無音/音声あり/欠落音声/途中再生/境界/停止再開を確認。既存ファイルの時間の意味を維持 | M6 |
| R16 | 紙PNG→Animatic PNG→WebM/印刷の順でExportControllerへ。準備前にJobを登録しSnapshotと資源を保持 | R09/R15。DialogはR10 | 準備中〜完了直前の中止、例外、作品切替、素材差替えでも出力内容が混在せず、終了一回 | M7 |
| R17 | write/close/abortのSinkと逐次ZIP。まずテスト用Sinkと上限付きBlob、次に対応環境のファイルSink | R16 | 遅いwriteを待つ。全PNGバイトを保持しない経路を計測。従来ZIP上限を超える前に拒否。Blob上限は明示 | M7 |
| R18 | Bundle v1の仕様確定とwriter。Project v5は維持しmanifest・原本・ハッシュを格納 | R05/R09/R17 | 必要素材が不足すれば完全成功にしない。別readerでZIP構造を照合。旧contp出力を維持 | M8 |
| R19 | Bundle readerと段階Import。サイズ/パス/参照/ハッシュ検証、ID衝突解決、正式参照の原子確定 | R18 | 空DBへの復元。途中失敗・容量不足・未知版で旧Project維持。内容の違う同IDは上書きしない | M8 |
| R20 | build配布物で総合検証、性能比較、実装済み構造資料更新。不要になった互換経路の削除は別コミット | R12〜R19。中間リリースでは完了した範囲のみ | 全体smoke、素材込み往復、終了後資源、実機未確認事項を記録。削除前に全呼出元移行を確認 | 統合 |

R00のブラウザ環境が未復旧でも、Nodeで再現したR01〜R03の修正準備は進めてよい。ただしUI・IndexedDB・描画の合格判定は、必要な実ブラウザ検証を完了するまで保留する。テスト用依存は配布物の実行時依存と分ける。

### 18.5 不具合修正時の具体的な設計

**R01: 生成責任を一か所へ**

Scene生成は必須nameを含むShotを生成関数経由で作る。新規追加だけを手直しして終わらず、初期Project・分割・テストデータ生成に同じ規約を適用する。Scene追加のテストでは自作の別callbackで代用せず、UIが使う生成/Command経路を実行する。

**R02: 接続要求の寿命**

pending Promiseには同じ参照を保持してfinallyで解除する。open失敗でも次の呼び出しを拒否済みPromiseへ固定しない。open中のcloseやversionchangeを扱う世代を用意し、古いonsuccessが来た場合は不要な接続を閉じる。onblockedで呼出元へ失敗を返した後に成功が届く場合も、接続を無断で公開しない。close後の再接続は新しい要求を作る。

**R03: カメラ表記**

隣接キーの全区間を調べ、既存の微小差の許容範囲を用いる。往復ではPANの両方向など実際の動きを表す。保持判定と方向表記を区別し、方向配列が空だから静止とみなす近道をなくす。cameraAtの線形補間、キーの比率、保存形式は変更しない。

**R05〜R07: 素材を失わない非同期処理**

Repositoryの原本保護を登録→非同期デコード/保存→所属と対象を再確認→一回の編集で参照を公開→保護解除の順にする。GCと保護登録の間に削除が進行しない協調をRepositoryで行う。安全性を確認できない移行期間は破壊的GCを保留する。複数タブでは一つのJSキューだけで排他できないため、§8.3の保守的方針を維持する。

同じPanelへの画像の連続取込は最後に開始した要求を優先し、別対象への取込は独立して扱う。不要な完了結果はProjectへ反映せず解放する。音声差し替えは初期仕様として選択Clipの参照を変更する。複数Clipを一括差し替える操作が必要なら、対象IDを明示した別Commandとする。素材IDが一致するという理由だけで全履歴の内容を変えない。

**R08: 波形の区間**

v5ではoffset/fpsを素材内秒へ変換し、素材のsampleRateでサンプル区間へ変換する。使用尺も秒から区間を求め、素材の長さを超える部分は無音として描く。初期のチャンネル方針は現行のChannel 0を維持し、その仕様を記録する。

長いClipの全幅Canvasを作らず可視区間の幅へ制限する。キャッシュにはAsset ID・素材区間・解像度の依存を含めるか、素材全体の多段ピーク列を保持して可視区間を抽出する。R08では正しさ、R09では推定バイト予算と破棄を完成させる。

**R13: 入力中の描画**

確定済みの紙面・画像・Strokeを再利用する。通常筆は一時面へ追加描画し、消しゴムは確定済み面を壊さない作業面で合成する。途中から筆圧可変線になる場合や、丸い線端が重なる場合も既存drawとの差を確認する。view/camera変換の前に出力面を適切に初期化し、前フレームの画素が残らないようにする。表示キャッシュを紙面・出力用の唯一の原本にはしない。

### 18.6 更新範囲の最小契約

R04時点で変更種類とIDを通知できれば、R11/R12はR14の部分複製完成を待たずに進められる。旧計画のM4→M3必須依存はこの点を緩和する。ただし任意callbackを全更新扱いにする安全策を残す。

| 操作 | 再計算・更新するもの | 再計算しないもの |
|---|---|---|
| 選択 | 選択装飾、対象Inspector、Stage、選択範囲、必要な追従 | 時間索引・音声絶対位置・作品保存 |
| 台詞/注記 | 該当入力と紙面レイアウトの無効化 | 時間索引・Stageの絵 |
| Stroke/画像 | 対象Stage・サムネイル・紙面画像 | 時間索引・音声位置 |
| 尺 | 累積時間・音声絶対位置・目盛・尺表示・紙面 | 未変更原本の再デコード |
| Audio offset/trim | 使用区間の波形・再生予約・音声表示・必要な紙面情報 | 画像の再デコード |
| Camera | Camera評価・Track・Inspector・紙面表記。再生PreviewならStage | 原本の再デコード |
| 再生ヘッド | 現在Panel/Camera・Stage・Playhead・時刻 | Tree・Inspector全体・保存 |
| Scroll/Zoom | 対象Viewの座標・可視範囲・目盛/波形区間 | Project構造索引・他ペインの入力DOM |

紙面レイアウトを無効化したら、次のプレビューまたは出力開始時に必ず再計算する。Dialogが閉じている間は即時描画を省略できる。文字変更で後続ページも変わる可能性を維持する。

### 18.7 作業を並行化する場合

分担はコードの責務分割とは別の判断である。少人数なら二系統でも十分で、常に最大並列にしない。本節は将来の分担案であり、この計画作成時に複数エージェントを起動したものではない。

| 系統 | 主担当範囲 | 他の担当へ渡すもの |
|---|---|---|
| A: 編集と統合 | R01/R03/R04/R06/R07/R14、appの接続、最終統合 | Command仕様・変更通知・Session規約 |
| B: 保存と素材 | R02/R05/R08/R09/R18/R19 | 保存結果・原本保護・素材取得/解放API |
| C: 表示と出力 | R10〜R13/R15〜R17 | View更新契約・描画資源要求・出力Job/Sink契約 |

- 最初にAがR04の接続契約を固定する。R02の単独修正は並行できる。
- R01/R03/R14はmodel.jsを共有するので同時編集しない。
- R05/R09とR10/R11は契約確定後に並行しやすい。R06は保存側の原本保護が使える段階で接続する。
- audio.jsを触るR08/R09/R15は同時に大規模変更しない。波形抽出→資源所有の移行→再生制御の順で統合する。
- app.js、package.json、共通fixture、統合smokeの変更窓口はA一つにする。B/Cは新モジュールと担当テストを完成させ、接続変更案をAへ渡す。
- 一つの作業ブランチは一つのRまたはその明示した小分けだけを扱う。APIを変える場合は関係者へ変更点を渡してから依存する作業を再開する。
- テストを書く担当と実装担当が別の業務ロジックを複製しない。実際に公開されるCommand・Repository・Rendererを使う。
- 独立モジュールの合格後、app接続は一変更ずつ統合し、その時点のsmokeを実行する。最後に一度だけ全変更を合わせる進め方は避ける。

### 18.8 リリース境界と差し戻し

| リリース候補 | 含める範囲 | ユーザーが確認できる成果 |
|---|---|---|
| S1: 基本操作の修復 | R00〜R03 | Scene追加・再接続・往復Camera表記が正しい |
| S2: 編集と素材の整合 | R04〜R09 | 遅い取込でも対象が変わらず、素材差替えをUndoできる |
| S3: 操作負荷の削減 | R10〜R15 | 選択・スクロール・描画時の不要な仕事が減る |
| S4: 出力と持ち運び | R16〜R19 | 固定した内容を出力でき、素材付きで別環境へ移せる |

R20の統合確認は各リリース境界で該当範囲を実施する。S4まで終わることをS1の公開条件にしない。作業日数は未計測なので断定せず、R00・最初のView抽出完了時に見積もりを更新する。

各コミットに対象R、変更目的、検証結果、残る制限を記録する。振る舞い変更・大規模移動・性能最適化を混ぜない。部分更新は全更新へ、Draftは従来edit経路へ、逐次出力は上限付きBlobへ戻せる段階を残す。保存データの削除を差し戻し方法にしない。

### 18.9 計測と合格の判定

1. R00では100/500/2000 Panelの固定データを用意し、文字中心・Stroke中心・画像/音声ありを区別する。実素材は利用許可のある固定fixtureとし、再実行で同じ条件にする。
2. 操作の入力から表示までを測るだけでなく、編集・検証・派生値・DOM・Canvas・JSON化・DB確定を分ける。短い操作のp50/p95とデータ・OS・ブラウザVersionを記録する。
3. R12の合格はまず不要な再計算回数とDOM置換回数が減り、全体更新と表示が一致すること。R13は同じ入力の描画一致と入力遅延を確認する。倍率だけの性能目標を先に約束しない。
4. R09は推定保持バイト数、使用権数、取得/解放回数を追い、反復後に未使用資源が予算へ戻ること。ブラウザ全体のメモリ量と同一とはしない。
5. R16/R17では出力サイズ、メモリ、書込待ち、キャンセルから解放までを別に測る。PNGのフレーム数と実時間WebMの音画同期を混同しない。
6. 必要な故障注入は、open失敗・transaction abort・容量不足・遅いデコード・作品切替・書込失敗・終了直前中止。問題に関係する試験を追加し、同じ保証を重複して増やさない。
7. スクリーンショットは実際のUIを固定データで描画して取得する。ブラウザ実行環境が使えない場合は未実施とし、生成画像で置き換えない。Windowsのペン入力と実機音声遅延は別途実機確認とする。

### 18.10 今回の範囲外と、次に検討する条件

- 全ProjectのID正規化: まず派生索引と部分複製で費用を確認する。保存形式を変える全面正規化は計測根拠が出てから。
- Undoを操作ログ方式へ全面移行: Stroke共有が既にあるため初期は不要。既存履歴と互換の部分複製を優先する。
- Worker: R13/R16後もメインスレッド費用が支配的な処理のみを分離候補とし、コピー・転送量と素材所有権を測る。
- デスクトップShell: ファイルSinkやペン入力など必要な能力を定めてから別計画で選定する。今回のスクリーンショット環境の問題だけを理由に製品構造を変えない。
- 非実時間動画・検索可能PDF・新しいCamera/音声固定方式: R15/R16の境界が安定してから追加仕様として扱う。
- TypeScript/フレームワーク: 必須条件にしない。まず実際の契約を抽出し、導入する場合は独立した変更で効果と移行費用を比較する。

当面の完成目標は「描く→尺変更→Undo→保存→再起動して復旧」が破綻せず、素材の取込・差替え・出力で別の作品や古い履歴を変更しないことである。分割の評価はファイル数ではなく、変更の影響範囲・状態所有者の明確さ・同じ処理をUIとテストが使えるかで行う。

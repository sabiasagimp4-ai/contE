# contE .NET + WebView2 デスクトップ版実装計画

更新日：2026-09-20  
基準：main `aed6808b2d78316048ee3a5a25e2c0da3130b71a`  
状態：実装開始用の計画。Windows実機の合格条件を満たすまで技術選定は暫定。

## 1. 結論

contEのWindowsデスクトップ版は、次の構成で試作する。

| 項目 | 採用 |
|---|---|
| ホスト | .NET 10 LTS / WPF |
| Web UI | Microsoft Edge WebView2 |
| Runtime | Evergreen WebView2 Runtime |
| 初期対象 | Windows 11 x64 |
| Web資産 | 現在の `npm run build` が生成する `dist/` |
| Project形式 | 現行の自己完結Bundle `.contb` を維持 |
| ブラウザ版 | 継続して単独動作させる |
| 初期配布 | portable ZIP + `contE-Setup-x64.exe` |
| 動画出力 | 現行経路を維持。ffmpeg同梱は別計画 |

2026-09-20時点で.NET 10はLTSで、公式サポートは2028-11-14までである。.NET 8は2026-11-10にサポート終了予定なので、新規デスクトップ層には使わない。

WPFを選ぶ理由は、contEで必要なネイティブUIがウィンドウ、メニュー、ファイルダイアログ、WebView2ホストに限られ、WinUI 3を導入する利益が小さいためである。既存のCanvas、Timeline、Web Audio、IndexedDB、出力ロジックはJavaScript側に残す。

## 2. この実装で達成すること

最初のデスクトップ版では、次を完了させる。

1. Nodeのローカルサーバーなしで起動する。
2. `.contb`をWindowsのファイルダイアログから開く。
3. 同じファイルへ保存、名前を付けて保存、上書きする。
4. 保存失敗時に元ファイルを壊さず、成功した場合だけ編集済み状態を解除する。
5. IndexedDBのoriginを更新後も固定し、現在の自動保存と復旧を維持する。
6. オフラインで描画、音声再生、紙コンテ、Animatic出力を使える。
7. portable ZIPとセットアップexeをGitHub Actionsで生成する。
8. Windows実機でペン、音声、保存、復旧、大規模Projectを測定する。

次は初期版の対象外とする。

- UIのC#への移植
- Projectモデルや描画エンジンの再実装
- ffmpeg、H.264、ProResの同梱
- 自動更新
- macOS/Linux版
- Windows ARM64版
- クラウド同期

## 3. 境界設計

### 3.1 ディレクトリ

```text
desktop/
  ContE.Desktop.sln
  src/
    ContE.Desktop/
      App.xaml
      MainWindow.xaml
      Bridge/
        BridgeEnvelope.cs
        BridgeRouter.cs
      Services/
        WebViewBootstrap.cs
        NativeFileService.cs
        AtomicFileWriter.cs
        WindowStateService.cs
      ContE.Desktop.csproj
  tests/
    ContE.Desktop.Tests/

src/
  platform/
    platform.js
    browser-platform.js
    desktop-platform.js

scripts/
  build-desktop.ps1
```

`dist/`やその複製はGitへ追加しない。デスクトップbuildは先に`npm run build`を実行し、その成果物をpublishディレクトリへコピーする。

### 3.2 Web側の境界

アプリ本体から`window.chrome.webview`を直接呼ばない。すべて`PlatformAdapter`を通す。

```js
platform.openProject()
platform.saveProject(bundle)
platform.saveProjectAs(bundle)
platform.setDirty(isDirty)
platform.getCapabilities()
```

`browser-platform.js`は現在のfile inputとdownloadを使う。`desktop-platform.js`だけがWebView2 bridgeを使う。これによりブラウザ版の動作とテストを維持する。

### 3.3 WebView2のorigin

`file://`では起動しない。`SetVirtualHostNameToFolderMapping`で、公開範囲をbuild済みWeb資産のフォルダだけに限定し、固定URLから読み込む。

```text
https://app.conte.invalid/index.html
```

固定originを使う理由は、ES Modules、secure context、IndexedDB、自動保存データを安定させるためである。WebView2のuser data folderも`%LOCALAPPDATA%\contE\WebView2`へ固定する。アプリ更新でこの場所を変更しない。

### 3.4 Bridge

制御メッセージは`window.chrome.webview.postMessage`を使い、request/responseを共通形式にする。

```json
{
  "protocol": 1,
  "id": "uuid",
  "method": "file.save",
  "params": {}
}
```

返答は`id`、`ok`、`result`または`error.code`を持つ。最初のhandshakeでhost version、protocol version、capabilitiesを交換し、互換性がない場合は編集画面を開かず理由を表示する。

大容量の`.contb`をJSONやBase64へ変換しない。制御はWebMessage、バイナリはWebView2の`WebResourceRequested`で捕捉する同一originの内部endpointを使う。

```text
GET  /__native__/open/{token}
PUT  /__native__/save/{token}
```

Open時は.NETが選択ファイルをstreamで返し、JSは`fetch`でArrayBufferを読む。Save時はJSがBundle BlobをPUTし、.NETがrequest streamを一時ファイルへ書く。tokenは一回限り、有効期限付き、現在のWebViewだけで利用可能にする。

### 3.5 ファイル保存

保存は次の順で行う。

1. JSが現在revisionのExportSnapshotから`.contb` Blobを生成する。
2. 同じディレクトリへ一時ファイルを書き、最後まで完了させる。
3. flush後、既存ファイルを`.bak`へ退避しながら置換する。
4. 成功時にサイズ、SHA-256、更新時刻を返す。
5. JSは返答時のrevisionが現在と同じ場合だけdirtyを解除する。
6. 失敗・中止時は一時ファイルを削除し、元ファイルとdirty状態を維持する。

保存処理は1本ずつ直列化する。OneDrive等で置換が拒否された場合は、元ファイルを保持したままエラーと一時ファイルの扱いを明示する。ファイルパスの完全な値は.NET側で保持し、Web側へは表示名だけ返す。

IndexedDBは即座に廃止しない。ブラウザ版の自動保存、デスクトップ版のクラッシュ復旧として残し、通常の明示保存だけをネイティブファイルへ移す。

### 3.6 セキュリティ境界

- top-level navigationは`https://app.conte.invalid/`だけ許可する。
- 外部リンクは既定ブラウザで開き、WebView内へ読み込まない。
- popup、任意のローカルパス、未登録bridge methodを拒否する。
- Host resource mappingは`dist/`だけを読み取り専用で公開する。
- Bridge要求はorigin、protocol、token、methodを検証する。
- Release buildではDevToolsを無効化し、Debug buildでは有効にする。
- CSPを追加し、外部scriptと外部通信を初期値で禁止する。

## 4. 実装順

### PR 1 — Windows Shell Spike

実装：

- `desktop/ContE.Desktop.sln`とWPFアプリを追加する。
- `Microsoft.Web.WebView2`のRelease版を導入する。
- `dist/`を固定virtual hostから読み込む。
- user data folder、navigation allowlist、外部リンク処理を設定する。
- `--smoke-test`で起動、JS handshake、IndexedDB read/write、終了を自動確認する。
- Windows workflowで`npm test`、`npm run build`、`dotnet test`、smoke testを実行する。

完了条件：

- Nodeサーバーなし、ネット接続なしで編集画面が起動する。
- 更新前後で同じIndexedDBを読める。
- ブラウザ版の全テストが成功する。
- Windows実機で描画、筆圧、傾き、音声再生開始、4秒同期を記録する。

中止条件：

- Pointer Eventsの筆圧が取得できない。
- 実用上無視できない描画遅延があり、WebView2設定で改善しない。
- Web Audioの同期が現行ブラウザ版より明確に悪化する。
- IndexedDBを安定したoriginで維持できない。

中止条件に該当した場合、PR 2へ進まずElectron spikeと同じfixtureで比較する。

### PR 2 — PlatformAdapterと制御Bridge

実装：

- browser/desktopのPlatformAdapterを追加する。
- handshake、capabilities、request timeout、cancel、構造化errorを実装する。
- New/Open/Save/Save As、dirty状態、ウィンドウタイトルを接続する。
- 既存のfile input/download経路をbrowser adapterへ移す。
- BrowserとDesktopの双方で同じProject操作シナリオをテストする。

完了条件：

- デスクトップ固有APIが`desktop-platform.js`以外に現れない。
- ブラウザ版の保存と読込が変わらない。
- 未知method、timeout、host切断を無言で失敗させない。

### PR 3 — Streaming File I/Oと原子的保存

実装：

- 一回限りtokenと内部stream endpointを実装する。
- `.contb`のopen/save/save asを接続する。
- AtomicFileWriter、backup、一時ファイル掃除を実装する。
- 保存中の二重実行、キャンセル、session/revision変更を処理する。
- 日本語、空白、長いパス、読み取り専用、容量不足、OneDriveフォルダを試験する。

完了条件：

- 素材込みBundleを開いて再保存し、ProjectとAssetのhashが一致する。
- 大容量BundleをBase64へ変換しない。
- 書込み途中の例外で既存ファイルが破損しない。
- 保存成功前にdirtyを解除しない。

### PR 4 — デスクトップUXと復旧

実装：

- Windows標準のOpen/Save Asダイアログを追加する。
- `.contb`の関連付けと、ファイルを指定した起動を追加する。
- drag & drop、最近使ったProject、ウィンドウ位置・大きさを追加する。
- 未保存状態でNew/Open/Closeするときの確認を追加する。
- 前回のIndexedDB recoveryと`.bak`を別々に提示する。
- menuとshortcutを既存commandへ接続する。

完了条件：

- 保存せずに閉じてデータを失う経路がない。
- recoveryを選ばなくても元ファイルを変更しない。
- 100%/150%/200% DPIと複数monitorで操作できる。
- キーボードだけでOpen、Save、Save As、Close確認を操作できる。

### PR 5 — 配布とCI

実装：

- `scripts/build-desktop.ps1`でWeb build、test、dotnet publishを再現する。
- `win-x64` self-contained publishを作る。trimmingは無効にする。
- portable ZIPを作る。
- セットアップexeを作り、WebView2 Runtimeの有無を検査する。
- Runtimeがない場合はEvergreen Bootstrapperを実行する。完全offline配布用はStandalone Installerを別artifactにする。
- artifactへversion、commit SHA、SHA-256 checksumを付ける。
- GitHub Releaseへ載せる処理はtag workflowとして分離する。

完了条件：

- .NET Runtimeを別途入れずに起動する。
- Windows 11の新規ユーザー環境でinstallerとuninstallerが動く。
- WebView2がない環境で原因不明の起動失敗にならない。
- portable版とinstaller版で同じProjectを開ける。
- install先に書込み権限を要求せず、データはユーザー領域へ保存する。

「exe配布」はまず`contE-Setup-x64.exe`を正式成果物とする。アプリ内部を文字どおり1ファイルにする最適化は、Web資産とWebView2 loaderの展開方式を複雑にするため、機能安定後の別課題とする。

### PR 6 — Windows実機ゲートと初回Release

次を同じfixtureで測り、`docs/DEVELOPMENT.md`へ数値を残す。

| 領域 | 条件 |
|---|---|
| 起動 | cold/warm各5回、編集可能まで |
| ペン | pressure、tilt、pointercancel、速いstroke |
| 音声 | 開始遅延、4秒/3分のdrift |
| 保存 | 新規、上書き、容量不足、read-only、OneDrive |
| 復旧 | 保存中強制終了、一時ファイル、backup、IndexedDB |
| 規模 | 500/1000/2500/5000 Panel＋実画像・音声 |
| 出力 | Paper、PNG、WebM、cancel、peak memory |
| 表示 | 100%/150%/200% DPI、複数monitor |

Release条件：

- Project/Assetのround tripで内容が一致する。
- 保存失敗時に直前の正常ファイルを開ける。
- 5000 Panel条件の失敗理由が記録され、データ破損がない。
- pen/audioがDESKTOP.mdの基準を満たす。
- browser版とdesktop版のProject互換性が双方向で成立する。
- CI artifactと実機検証対象のcommit SHAが一致する。

## 5. テスト構成

### JavaScript

- PlatformAdapter契約
- Bridge response、timeout、cancel、未知error
- revision変更中のsave完了
- Desktop open/saveとbrowser fallback
- Bundle import/exportの既存テスト
- browser smoke / UX smoke

### C#

- BridgeEnvelopeのschemaとprotocol version
- navigation allowlist
- tokenの一回性、有効期限、WebView instance binding
- AtomicFileWriterの新規、置換、失敗、cleanup
- 日本語/長いpath
- 同時saveの直列化
- Runtime未導入時の案内
- command-line file open

### Windows統合

`--smoke-test`は次を自動実行し、成功時0で終了する。

1. WebView2初期化
2. 固定origin読込
3. JS/.NET handshake
4. IndexedDB write/read
5. 小さな`.contb` open/save
6. 保存結果のSHA-256照合

ペン、音声、DPI、OneDrive、強制終了は実機試験として記録する。CI成功だけで完了扱いにしない。

## 6. Lunaへ渡す実装規則

1. PR 1から順に、一度に1 PRだけ実装する。
2. 各PRの開始時に最新mainへrebaseし、完了条件をPR本文へ転記する。
3. 現行のProjectモデル、Bundle形式、EditorSession、ExportSnapshot、renderFrameを複製しない。
4. `window.chrome.webview`をPlatformAdapter外へ書かない。
5. `file://`、大容量Base64、固定された個人パスを使わない。
6. browser版を削除せず、既存Node test/build/browser smoke/UX smokeを維持する。
7. Windowsでしか確認できない項目をLinux上の推測で「検証済み」にしない。
8. 依存追加ごとにライセンス、配布物、更新方針を記録する。
9. PR 1の中止条件に触れたら、そのまま実装を拡大せず、数値と再現手順を報告する。
10. ffmpeg、自動更新、UI全面移植を同じPRへ混ぜない。

## 7. 公式資料

- [.NET support policy](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core)
- [WebView2 Runtimeの配布](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)
- [WebView2でlocal contentを扱う方法](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/working-with-local-content)
- [SetVirtualHostNameToFolderMapping](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.setvirtualhostnametofoldermapping)
- [.NET single-file deployment](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview)

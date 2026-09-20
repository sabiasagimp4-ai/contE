# contE Windows host

このフォルダは、既存のブラウザ版を.NET 10 WPFとWebView2で起動するWindowsホストです。Projectモデル、描画、Timeline、音声、出力の実装は`src/`側に残し、Windows固有の処理だけをここへ置きます。

## ローカルビルド

WindowsでNode.js、.NET 10 SDK、WebView2 Runtimeを用意して、リポジトリのルートから実行します。

```powershell
npm run build:desktop
```

`dist/`がWebView2の固定originへコピーされ、`artifacts/contE-win-x64.zip`に自己完結型の`contE.exe`、`artifacts/contE-Setup-win-x64.exe`にセットアップexeが入ります。セットアップは`%LOCALAPPDATA%\\Programs\\contE`へ展開し、`.contb/.contp`の関連付けを登録します。

## 設計上の注意

- Web UIは`https://app.conte.invalid/`という固定originで読み込みます。`file://`は使いません。
- Bridgeは制御メッセージだけに使い、`.contb`のバイナリは内部stream endpointで送ります。
- WebView2のuser dataは`%LOCALAPPDATA%\\contE\\WebView2`に固定し、更新後もIndexedDBを引き継ぎます。
- 保存は一時ファイルを書き切ってから置換し、既存ファイルを`.bak`へ退避します。
- Windows実機でのペン、音声、DPI、OneDrive、強制終了の検証はまだ別途必要です。

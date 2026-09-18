// キー操作の一覧。ここ1か所が「効くキー」と「画面に出る説明」の両方の出どころになる。
// 表と実装が別々にあると、片方だけ直したときに嘘の説明が画面に残る。
//
// combosは正規化した組み合わせの文字列。modはCtrlとCmdのどちらでもよい、の意。
// 同じ動きに複数のキーが割り当たる場合（← / →、Home / End など）は1行にまとめる。
// 説明の読みやすさを優先し、Shift付きの変種は行を分けずlabelの中で触れる。

// 記号キーはShiftを押して入力する環境がある（Shift+=で「+」など）。押し方の違いで
// 効かなくなるのは事故なので、同じ動きに対応する打ち方を全部並べておく。
export const SHORTCUTS = [
  { id: "add", group: "編集", display: "N", label: "Panelを追加", combos: ["n"] },
  {
    id: "duplicate",
    group: "編集",
    display: "Ctrl+D",
    label: "選択Panelを複製",
    combos: ["mod+d"],
  },
  {
    id: "undo",
    group: "編集",
    display: "Ctrl+Z",
    label: "元に戻す",
    combos: ["mod+z"],
  },
  {
    id: "redo",
    group: "編集",
    display: "Ctrl+Shift+Z",
    label: "やり直す",
    combos: ["mod+shift+z"],
  },
  {
    id: "copy",
    group: "編集",
    display: "Ctrl+C",
    label: "選択Panelをコピー",
    combos: ["mod+c"],
  },
  {
    id: "cut",
    group: "編集",
    display: "Ctrl+X",
    label: "選択Panelを切り取り",
    combos: ["mod+x"],
  },
  {
    id: "paste",
    group: "編集",
    display: "Ctrl+V",
    label: "貼り付け",
    combos: ["mod+v"],
  },
  {
    id: "save",
    group: "編集",
    display: "Ctrl+S",
    label: "ファイルへ保存",
    combos: ["mod+s"],
  },
  {
    id: "split",
    group: "編集",
    display: "Ctrl+K",
    label: "ここでShotを分ける",
    combos: ["mod+k"],
  },
  {
    id: "merge",
    group: "編集",
    display: "Ctrl+Shift+K",
    label: "前のShotへ統合",
    combos: ["mod+shift+k"],
  },
  {
    id: "nudgeFrames",
    group: "編集",
    display: "[ / ]",
    label: "尺を1フレーム縮める / 伸ばす",
    combos: ["[", "]"],
  },
  {
    id: "panelStep",
    group: "選択と移動",
    display: "← / →",
    label: "前 / 次のPanelへ（Shiftで範囲選択・CtrlでShot単位）",
    combos: [
      "arrowleft",
      "arrowright",
      "shift+arrowleft",
      "shift+arrowright",
      "mod+arrowleft",
      "mod+arrowright",
      "mod+shift+arrowleft",
      "mod+shift+arrowright",
    ],
  },
  {
    id: "edgeStep",
    group: "選択と移動",
    display: "Home / End",
    label: "先頭 / 末尾のPanelへ（Shiftで範囲選択）",
    combos: ["home", "end", "shift+home", "shift+end"],
  },
  {
    id: "play",
    group: "再生",
    display: "Space",
    label: "再生 / 停止",
    combos: ["space"],
  },
  {
    id: "fitTime",
    group: "再生",
    display: "F",
    label: "Timelineを全体表示",
    combos: ["f"],
  },
  {
    id: "zoomTimeline",
    group: "再生",
    display: "+ / −",
    label: "Timelineを拡大 / 縮小",
    combos: ["+", "shift++", "=", "-"],
  },
  {
    id: "toggleEraser",
    group: "描画",
    display: "E",
    label: "ブラシ / 消しゴムを切り替え",
    combos: ["e"],
  },
  {
    id: "onion",
    group: "描画",
    display: "O",
    label: "前後のコマを薄く重ねる",
    combos: ["o"],
  },
  {
    id: "resetView",
    group: "描画",
    display: "0",
    label: "ズームと位置をリセット",
    combos: ["0"],
  },
  {
    id: "cameraKey",
    group: "Camera",
    display: "K",
    label: "再生ヘッドにキーを打つ",
    combos: ["k"],
  },
  {
    id: "deleteKey",
    group: "Camera",
    display: "Delete",
    label: "選択中のキーを削除",
    combos: ["delete", "backspace"],
  },
  {
    id: "search",
    group: "画面",
    display: "Ctrl+F",
    label: "台詞・注記・Scene名・Shot名を検索",
    combos: ["mod+f"],
    anywhere: true,
  },
  {
    id: "maximize",
    group: "画面",
    display: "~",
    label: "パネルを最大化 / 元へ戻す",
    combos: ["`", "~", "shift+`", "shift+~"],
  },
  {
    id: "escape",
    group: "画面",
    display: "Esc",
    label: "メニュー・検索・最大化・プレゼンを閉じる",
    combos: ["escape"],
    anywhere: true,
  },
];

// キーが要らない操作。以前はStageの下へ1行で並べていたが、幅に入り切らず
// 途中で切れていた。読む場所はここ1か所にまとめる。
export const GESTURES = [
  { group: "数値", label: "横にドラッグ、またはフォーカス中にホイールで刻む" },
  { group: "Stage", label: "ホイールでズーム、Alt または中ボタンのドラッグで移動" },
  { group: "コマ", label: "ドラッグで並べ替え、Shift+クリックで範囲選択" },
  {
    group: "Timeline",
    label: "目盛や空白をドラッグで再生ヘッド、コマの端をドラッグで尺、Altでスナップ解除",
  },
  { group: "Camera", label: "レーンをダブルクリックでキー追加、キーをドラッグで移動" },
  { group: "ツリー", label: "ダブルクリックでScene名 / Shot名を変更" },
  { group: "パネル", label: "タブのバーをダブルクリックでそのパネルだけを最大化" },
];

// 押されたキーを表と同じ書き方へ直す。CtrlとCmdはどちらもmodとして扱う。
export function comboOf(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(e.key === " " ? "space" : e.key.toLowerCase());
  return parts.join("+");
}

// combos から引ける表を作る。同じ組み合わせを2つの行が取り合うと、どちらが
// 動くかがファイルの並び順で決まってしまうので、その場で気づけるよう投げる。
export function shortcutIndex(list = SHORTCUTS) {
  const byCombo = new Map();
  for (const entry of list)
    for (const combo of entry.combos) {
      if (byCombo.has(combo))
        throw new Error(
          `ショートカットが重複しています：${combo}（${byCombo.get(combo).id} と ${entry.id}）`,
        );
      byCombo.set(combo, entry);
    }
  return byCombo;
}

// 表示だけMacの見た目へ寄せる。判定側（mod）は変えない。
export function displayFor(entry, mac = false) {
  return mac ? entry.display.replace(/Ctrl/g, "⌘") : entry.display;
}

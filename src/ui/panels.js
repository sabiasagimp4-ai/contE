// 画面に置くパネルの表。データだけを持ち、DOMもDocksも知らない。中身が正しいか
// （閉じたパネルが必ずメニューから戻せるか、作業レイアウトが知らないIDを指して
// いないか）は、ブラウザを起こさずに確かめられる。

// ドックの見せ方。tabsは1枚ずつ切り替え、stackは開いている分を上から順に積む。
export const DOCK_MODES = {
  left: "tabs",
  center: "tabs",
  // コンポジションの中身。ツール列・ビュー・コマは同時に見えるので積む。
  stageStack: "stack",
  right: "tabs",
  bottom: "tabs",
};

// fixed は閉じられないパネル。閉じると戻す手がかりが絵として無くなるものだけ。
export const PANELS = [
  { id: "project", title: "プロジェクト", dock: "left", openByDefault: true },
  { id: "composition", title: "コンポジション", dock: "center", fixed: true },
  { id: "paper", title: "紙コンテ", dock: "center" },
  { id: "tools", title: "描画ツール", dock: "stageStack", openByDefault: true },
  { id: "viewer", title: "ビュー", dock: "stageStack", fixed: true },
  {
    id: "strip",
    title: "コマ（サムネイル）",
    dock: "stageStack",
    openByDefault: true,
  },
  { id: "content", title: "内容", dock: "right", openByDefault: true },
  { id: "camera", title: "Camera", dock: "right", openByDefault: true },
  { id: "sound", title: "音", dock: "right", openByDefault: true },
  { id: "marker", title: "マーカー", dock: "right", openByDefault: true },
  { id: "structure", title: "構成", dock: "right", openByDefault: true },
  { id: "keys", title: "ショートカット", dock: "right" },
  { id: "timeline", title: "タイムライン", dock: "bottom", openByDefault: true },
];

// ウィンドウメニューの並び。閉じたパネルを呼び戻す唯一の入口なので、画面の位置と
// 同じ順にする。ここに載っていない閉じられるパネルは、一度閉じると戻せない。
export const MENU_GROUPS = [
  { title: "左", dock: "left" },
  { title: "中央", dock: "center" },
  { title: "コンポジションの中", dock: "stageStack" },
  { title: "インスペクタ", dock: "right" },
  { title: "下", dock: "bottom" },
];

// 既定で開くパネル。fixedは閉じられないので常に入る。
export const DEFAULT_OPEN = PANELS.filter((p) => p.fixed || p.openByDefault).map(
  (p) => p.id,
);

// 作業レイアウト（AEのワークスペース）。やることが変われば要るパネルも変わる。
// 毎回ひとつずつ開き直さずに済むよう、代表的なところを置く。layoutに書いた値だけが
// 既定の幅・高さから上書きされる。
export const WORKSPACES = [
  {
    name: "描く",
    // 絵に集中する。尺はあとで決めるので、Timelineは畳んで面を広く取る。
    panels: { open: ["project", "tools", "strip", "content"], active: { right: "content" } },
    layout: { tree: 180, inspector: 260 },
  },
  {
    name: "尺を決める",
    // 時間を触る。Timelineを高くし、音とマーカーを手の届くところへ出す。
    panels: {
      open: ["project", "tools", "strip", "content", "sound", "marker", "timeline"],
      active: { right: "content" },
    },
    layout: { tree: 190, inspector: 260, timeline: 420 },
  },
  {
    name: "仕上げ（既定）",
    panels: { open: DEFAULT_OPEN, active: { right: "content" } },
    layout: {},
  },
];

// AE風のパネル式UI。画面は4つのドック（左・中央・右・下）に分かれ、パネルは
// そのどれかへ収まる。使わないパネルは閉じて画面から消し、ウィンドウメニューから
// いつでも呼び戻せる。常に全部を出しておく必要はない、という考え方が中心。
//
// DOMとの約束は3つだけ。
//   ドック  : [data-dock="<dockId>"]
//   タブの器: [data-tabs="<dockId>"]（tabsモードのドックのみ）
//   中身    : [data-body="<panelId>"]
//   仕切り  : [data-splitter="<dockId>"]（あれば、ドックと一緒に出し入れする）
//
// モードは2つ。tabsは1枚ずつ切り替えて見せる（右のインスペクタなど）。stackは
// 開いているものを上から順に全部見せる（中央のツール列・ビュー・コマなど）。
export class Docks {
  #panels;
  #byId;
  #modes;
  #open;
  #active = new Map();
  #max = null;
  #onChange;
  #root;
  constructor({ panels, modes, root = document, onChange = () => {} }) {
    this.#panels = panels;
    this.#byId = new Map(panels.map((p) => [p.id, p]));
    this.#modes = modes;
    this.#root = root;
    this.#onChange = onChange;
    this.#open = new Set(panels.filter((p) => p.fixed || p.openByDefault).map((p) => p.id));
    for (const dock of Object.keys(modes)) this.#active.set(dock, this.#inDock(dock)[0]?.id);
    this.#bindBars();
  }
  #inDock(dock) {
    return this.#panels.filter((p) => p.dock === dock);
  }
  #el(selector) {
    return this.#root.querySelector(selector);
  }
  #bindBars() {
    for (const dock of Object.keys(this.#modes)) {
      const bar = this.#el(`[data-dock="${dock}"] .panelBar`);
      if (!bar) continue;
      // AEと同じく、タブのバーのダブルクリックでそのパネルだけを広げる。
      bar.ondblclick = (e) => {
        if (e.target.closest("button")) return;
        this.toggleMaximize(dock);
      };
    }
  }
  panels() {
    return this.#panels;
  }
  isOpen(id) {
    return this.#open.has(id);
  }
  open(id) {
    const panel = this.#byId.get(id);
    if (!panel) return;
    this.#open.add(id);
    this.#active.set(panel.dock, id);
    this.#changed();
  }
  // 常設のパネル（ビューなど）は閉じない。閉じられると戻す手段が絵として無くなる。
  close(id) {
    const panel = this.#byId.get(id);
    if (!panel || panel.fixed) return;
    this.#open.delete(id);
    this.#changed();
  }
  toggle(id) {
    this.isOpen(id) ? this.close(id) : this.open(id);
  }
  activate(id) {
    const panel = this.#byId.get(id);
    if (!panel || !this.isOpen(id)) return;
    this.#active.set(panel.dock, id);
    this.#changed();
  }
  // 開いていなければ開いてから前面にする。メニューや検索から呼ぶ入口。
  reveal(id) {
    this.isOpen(id) ? this.activate(id) : this.open(id);
  }
  maximized() {
    return this.#max;
  }
  maximize(dock) {
    this.#max = dock && this.#modes[dock] ? dock : null;
    this.#changed();
  }
  toggleMaximize(dock) {
    this.maximize(this.#max === dock ? null : dock);
  }
  // 画面の状態なのでProjectには入れない。layoutと一緒にmetaへ保存する。
  // 最大化は「今だけ広げて見る」操作なので覚えない。次に開いたときに畳まれた
  // 画面で始まると、何が起きたのか分からない。
  state() {
    return {
      open: [...this.#open],
      active: Object.fromEntries(this.#active),
    };
  }
  // 保存の中身は古い版や壊れた値でもあり得る。知らないIDは黙って捨て、常設の
  // パネルは必ず開いた状態にして、最低でも操作できる画面にして返す。
  restore(saved) {
    if (!saved || typeof saved !== "object") return;
    if (Array.isArray(saved.open)) {
      this.#open = new Set(saved.open.filter((id) => this.#byId.has(id)));
      for (const p of this.#panels) if (p.fixed) this.#open.add(p.id);
    }
    if (saved.active && typeof saved.active === "object")
      for (const [dock, id] of Object.entries(saved.active))
        if (this.#modes[dock] && this.#byId.get(id)?.dock === dock)
          this.#active.set(dock, id);
    this.#max = null;
    this.render();
  }
  #changed() {
    this.render();
    this.#onChange();
  }
  render() {
    for (const [dock, mode] of Object.entries(this.#modes)) {
      const dockEl = this.#el(`[data-dock="${dock}"]`);
      const splitter = this.#el(`[data-splitter="${dock}"]`);
      const members = this.#inDock(dock);
      const shown = members.filter((p) => this.isOpen(p.id));
      // 中身が1つも無いドックは仕切りごと消す。空の枠が残ると場所だけ取る。
      if (dockEl) dockEl.hidden = shown.length === 0;
      if (splitter) splitter.hidden = shown.length === 0;
      if (shown.length === 0 && this.#max === dock) this.#max = null;
      let active = this.#active.get(dock);
      if (!shown.some((p) => p.id === active)) active = shown[0]?.id;
      this.#active.set(dock, active);
      for (const panel of members) {
        const body = this.#el(`[data-body="${panel.id}"]`);
        if (body)
          body.hidden =
            mode === "tabs" ? panel.id !== active : !this.isOpen(panel.id);
      }
      const tabs = this.#el(`[data-tabs="${dock}"]`);
      if (tabs && mode === "tabs") {
        tabs.replaceChildren(...shown.map((p) => this.#tab(p, p.id === active)));
        this.#showActiveTab(tabs);
      }
      if (dockEl) dockEl.classList.toggle("maxed", this.#max === dock);
    }
    if (this.#max) document.body.dataset.max = this.#max;
    else delete document.body.dataset.max;
  }
  // タブが幅に入り切らないと横スクロールになる。前面のタブが見切れていると
  // どれを見ているのか分からないので、隠れている側だけ寄せる。
  #showActiveTab(tabs) {
    const on = tabs.querySelector?.(".panelTab.on");
    if (!on || !(tabs.scrollWidth > tabs.clientWidth)) return;
    const right = on.offsetLeft + on.offsetWidth;
    if (on.offsetLeft < tabs.scrollLeft) tabs.scrollLeft = on.offsetLeft;
    else if (right > tabs.scrollLeft + tabs.clientWidth)
      tabs.scrollLeft = right - tabs.clientWidth;
  }
  #tab(panel, active) {
    const wrap = document.createElement("span");
    wrap.className = `panelTab${active ? " on" : ""}`;
    const name = document.createElement("button");
    name.className = "tabName";
    name.dataset.tab = panel.id;
    name.textContent = panel.title;
    name.onclick = () => this.activate(panel.id);
    wrap.append(name);
    // 閉じる×は前面のタブにだけ出す。全部のタブに付けると触り間違えやすい。
    if (active && !panel.fixed) {
      const close = document.createElement("button");
      close.className = "tabClose";
      close.dataset.close = panel.id;
      close.title = `${panel.title}を閉じる（ウィンドウメニューから戻せます）`;
      close.textContent = "×";
      close.onclick = () => this.close(panel.id);
      wrap.append(close);
    }
    return wrap;
  }
}

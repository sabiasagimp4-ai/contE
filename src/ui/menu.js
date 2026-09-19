// ボタンを押したときだけ出るメニュー。常に画面へ並べておく必要のない操作を
// ここへ畳む。中身は開くたびに作り直す（チェックの付き外しが、そのときの状態と
// 必ず一致する）。作り直す必要が無いメニューはHTMLの中身をそのまま使う。
//
// 開いているメニューは全体で1つ。別のメニューのボタンを押したら前のは閉じる。
const menus = new Set();
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  // メニューの外側を押したら閉じる。ボタン自身は除く（押した直後のclickで
  // トグルさせるため、ここで閉じると開き直しになる）。
  document.addEventListener("pointerdown", (e) => {
    for (const menu of menus) if (menu.open && !menu.owns(e.target)) menu.close();
  });
}
// Escや別の操作でまとめて閉じる。1つでも閉じたらtrueを返す。
export function closeMenus() {
  let closed = false;
  for (const menu of menus)
    if (menu.open) {
      menu.close();
      closed = true;
    }
  return closed;
}
export class PopupMenu {
  #button;
  #box;
  #build;
  constructor({ button, box, build = null }) {
    this.#button = button;
    this.#box = box;
    this.#build = build;
    menus.add(this);
    listen();
    button.onclick = () => this.toggle();
    // 中の項目を選んだら閉じる。項目側に閉じる処理を書かせると、1つ書き忘れた
    // ときにメニューが出たままになる。clickは項目の処理が終わってから届く。
    box.addEventListener("click", (e) => {
      if (e.target.closest("button")) this.close();
    });
  }
  get open() {
    return !this.#box.hidden;
  }
  owns(node) {
    return this.#box.contains?.(node) || this.#button.contains?.(node);
  }
  show() {
    for (const menu of menus) if (menu !== this && menu.open) menu.close();
    if (this.#build) this.#box.replaceChildren(...this.#build());
    this.#box.hidden = false;
    // ボタンの真下へ。右端からはみ出すときだけ内側へ寄せる。
    const at = this.#button.getBoundingClientRect();
    const left = Math.max(4, Math.min(at.left, innerWidth - this.#box.offsetWidth - 8));
    this.#box.style.left = `${Math.round(left)}px`;
    this.#box.style.top = `${Math.round(at.bottom + 2)}px`;
    this.#button.setAttribute("aria-expanded", "true");
  }
  close() {
    this.#box.hidden = true;
    this.#button.setAttribute("aria-expanded", "false");
  }
  toggle() {
    this.open ? this.close() : this.show();
  }
}
// 見出し。どこからどこまでが同じまとまりかを示すだけで、押せない。
export function menuGroup(title) {
  const head = document.createElement("div");
  head.className = "menuGroup";
  head.textContent = title;
  return head;
}
// 項目。checkedがnullなら印の欄だけ空けて、名前の左端をそろえる。
export function menuItem(checked, title, run) {
  const item = document.createElement("button");
  const mark = document.createElement("span");
  mark.className = "check";
  mark.textContent = checked ? "✓" : "";
  item.append(mark, document.createTextNode(title));
  if (run) item.onclick = run;
  return item;
}

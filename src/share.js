// 共有用の単体HTML書き出し（D4）。紙面のページ画像をdata URIで埋め込み、
// 受け取った側はページをめくる・印刷する以外の操作を必要としない最小の作りにする。
const ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ESCAPE[c]);
function toBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  // 大きな配列を一度にString.fromCharCodeへ渡すとスタックを溢れさせるので分割する。
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
export const pageDataUri = (bytes) => `data:image/png;base64,${toBase64(bytes)}`;
export function buildShareHtml({ title = "conte", pages }) {
  if (!pages?.length) throw Error("ページがありません");
  const name = escapeHtml(title);
  const images = pages
    .map(
      (bytes, i) =>
        `<img class="page"${i === 0 ? " data-on" : ""} src="${pageDataUri(bytes)}" alt="${i + 1}ページ目">`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<title>${name}</title>
<style>
  body { margin: 0; background: #2b2b2b; font-family: "Noto Sans JP", sans-serif; }
  #bar {
    position: sticky; top: 0; display: flex; gap: 8px; align-items: center;
    padding: 8px 12px; background: #1a1a1a; color: #fff;
  }
  #bar button { cursor: pointer; }
  #count { margin-left: auto; }
  #pages { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 12px; }
  .page { display: none; max-width: 100%; background: #fff; }
  .page[data-on] { display: block; }
  @media print {
    #bar { display: none; }
    #pages { padding: 0; gap: 0; }
    .page { display: block !important; width: 100%; page-break-after: always; }
  }
</style>
<div id="bar">
  <button id="prev">← 前へ</button>
  <button id="next">次へ →</button>
  <button id="printBtn">印刷 / PDF</button>
  <output id="count"></output>
</div>
<div id="pages">
${images}
</div>
<script>
(function () {
  var pages = document.querySelectorAll(".page");
  var i = 0;
  function show() {
    for (var n = 0; n < pages.length; n++)
      pages[n].toggleAttribute("data-on", n === i);
    document.getElementById("count").textContent = (i + 1) + " / " + pages.length;
  }
  document.getElementById("prev").onclick = function () {
    i = Math.max(0, i - 1);
    show();
  };
  document.getElementById("next").onclick = function () {
    i = Math.min(pages.length - 1, i + 1);
    show();
  };
  document.getElementById("printBtn").onclick = function () {
    window.print();
  };
  document.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight") document.getElementById("next").click();
    if (e.key === "ArrowLeft") document.getElementById("prev").click();
  });
  show();
})();
</script>
</html>
`;
}

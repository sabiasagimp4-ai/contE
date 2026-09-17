// 大きなProjectのJSON化がメインスレッドを長く止めないよう、Scene単位に分けて
// 間で制御を返す（E1）。結果はJSON.stringify(p)と完全に同じ文字列にする。
// 速くはしない。止まらなくするだけ（計画の注記どおり）。
const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0));
async function serializeArray(items, yieldEvery, signal) {
  const interval = Number.isInteger(yieldEvery) && yieldEvery > 0 ? yieldEvery : 1;
  const parts = [];
  for (let i = 0; i < items.length; i++) {
    signal?.throwIfAborted();
    parts.push(JSON.stringify(items[i]));
    if ((i + 1) % interval === 0) await yieldToEventLoop();
  }
  return `[${parts.join(",")}]`;
}
export async function serializeProject(p, { yieldEvery = 1, signal } = {}) {
  const parts = [];
  for (const key of Object.keys(p)) {
    signal?.throwIfAborted();
    parts.push(
      key === "scenes"
        ? `"scenes":${await serializeArray(p.scenes, yieldEvery, signal)}`
        : `${JSON.stringify(key)}:${JSON.stringify(p[key])}`,
    );
  }
  return `{${parts.join(",")}}`;
}

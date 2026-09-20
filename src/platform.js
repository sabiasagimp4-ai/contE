const webview = globalThis.chrome?.webview ?? null;

export const isDesktop = Boolean(webview);
const pending = new Map();
let sequence = 0;
const REQUEST_TIMEOUT_MS = 30_000;

function nextId() {
  sequence += 1;
  return `${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function messageError(value) {
  const message =
    value?.message || value?.code || "デスクトップホストとの通信に失敗しました";
  const error = Error(message);
  if (value?.code) error.code = value.code;
  return error;
}

if (webview) {
  webview.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== "response" || !data.id) return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.ok === false) entry.reject(messageError(data.error));
    else entry.resolve(data.result);
  });
}

function request(method, params = {}) {
  if (!webview)
    return Promise.reject(
      Error("デスクトップ機能はブラウザでは利用できません"),
    );
  const id = nextId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error(`デスクトップ操作がタイムアウトしました：${method}`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      webview.postMessage({ protocol: 1, type: "request", id, method, params });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

export const platformReady = isDesktop
  ? request("app.hello", { protocol: 1 }).then((capabilities) => {
      if (!capabilities?.protocol || capabilities.protocol !== 1)
        throw Error("デスクトップBridgeのバージョンが一致しません");
      globalThis.__conteDesktopReady = true;
      return capabilities;
    })
  : Promise.resolve({ protocol: 1, platform: "browser" });

export async function openProjectFile(ticket = null) {
  if (!isDesktop) return null;
  const transfer = ticket || await request("file.open");
  if (!transfer || transfer.cancelled) return null;
  const response = await fetch(transfer.url, { cache: "no-store" });
  if (!response.ok) throw Error(`Projectを開けません：HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  return new File([bytes], transfer.name || "project.contb", {
    type: transfer.mime || "application/octet-stream",
  });
}

export async function saveProjectFile(blob, name) {
  if (!isDesktop) return { downloaded: false };
  const ticket = await request("file.prepareSave", { suggestedName: name });
  if (!ticket || ticket.cancelled) return { cancelled: true };
  const response = await fetch(ticket.url, {
    method: "PUT",
    cache: "no-store",
    headers: { "Content-Type": "application/octet-stream" },
    body: blob,
  });
  if (!response.ok) {
    let message = `Projectを保存できません：HTTP ${response.status}`;
    try {
      const body = await response.json();
      message = body?.error?.message || body?.message || message;
    } catch {}
    throw Error(message);
  }
  return response.json();
}

export function setDesktopDirty(dirty) {
  if (!isDesktop) return;
  void request("app.setDirty", { dirty: Boolean(dirty) }).catch(() => {});
}

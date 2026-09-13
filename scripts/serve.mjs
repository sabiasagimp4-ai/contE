import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { pathToFileURL } from "node:url";
export function serve(root = resolve("."), port = 8000) {
  const server = createServer(async (req, res) => {
    try {
      const path = resolve(
        root,
        "." +
          decodeURIComponent(
            new URL(req.url, "http://localhost").pathname,
          ).replace(/\/$/, "/index.html"),
      );
      if (!path.startsWith(root + sep)) throw Error();
      const data = await readFile(path);
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
        }[extname(path)] || "application/octet-stream",
      );
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end("Not found");
    }
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await serve();
  console.log("contE: http://127.0.0.1:8000");
}

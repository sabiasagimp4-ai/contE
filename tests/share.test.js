import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShareHtml, pageDataUri } from "../src/share.js";

test("pageDataUri encodes PNG bytes as a valid base64 data URI", () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const uri = pageDataUri(bytes);
  assert.match(uri, /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
  const decoded = Buffer.from(uri.split(",")[1], "base64");
  assert.deepEqual([...decoded], [...bytes]);
});

test("buildShareHtml embeds one img per page, in order, as data URIs", () => {
  const pages = [
    new Uint8Array([1, 2, 3]),
    new Uint8Array([4, 5]),
    new Uint8Array([6]),
  ];
  const html = buildShareHtml({ title: "テスト", pages });
  const matches = [...html.matchAll(/<img class="page"[^>]*src="([^"]+)"/g)];
  assert.equal(matches.length, 3);
  matches.forEach((m, i) => {
    assert.equal(m[1], pageDataUri(pages[i]));
  });
  // 最初のページだけ最初から見える状態で開く。
  assert.match(html, /<img class="page" data-on src="[^"]+"/);
  assert.match(html, /<title>テスト<\/title>/);
});

test("buildShareHtml escapes the title so it cannot break out of the tag", () => {
  const html = buildShareHtml({
    title: '</title><script>alert(1)</script>',
    pages: [new Uint8Array([1])],
  });
  assert.doesNotMatch(html, /<\/title><script>/);
  assert.match(html, /&lt;\/title&gt;&lt;script&gt;/);
});

test("buildShareHtml refuses to build with no pages", () => {
  assert.throws(() => buildShareHtml({ title: "x", pages: [] }), /ページ/);
  assert.throws(() => buildShareHtml({ title: "x" }), /ページ/);
});

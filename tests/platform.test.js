import test from "node:test";
import assert from "node:assert/strict";
import {
  isDesktop,
  openProjectFile,
  platformReady,
  saveProjectFile,
} from "../src/platform.js";

test("browser platform keeps file operations on the existing browser path", async () => {
  assert.equal(isDesktop, false);
  assert.deepEqual(await platformReady, { protocol: 1, platform: "browser" });
  assert.equal(await openProjectFile(), null);
  assert.deepEqual(await saveProjectFile(new Blob(["test"]), "test.contb"), {
    downloaded: false,
  });
});

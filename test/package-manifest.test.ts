import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("Pi package manifest", () => {
  it("declares the canonical extension entrypoint and Pi peer dependencies", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      keywords?: string[];
      pi?: { extensions?: string[] };
      peerDependencies?: Record<string, string>;
    };

    assert.ok(packageJson.keywords?.includes("pi-package"));
    assert.deepEqual(packageJson.pi?.extensions, ["./dist/pi-extension.js"]);
    assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-agent-core"], "*");
    assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
    assert.equal(packageJson.peerDependencies?.typebox, "*");
  });
});

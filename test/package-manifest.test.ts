import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("Pi package manifest", () => {
  it("declares the canonical extension entrypoint and Pi peer dependencies", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      files?: string[];
      license?: string;
      name?: string;
      keywords?: string[];
      pi?: { extensions?: string[] };
      peerDependencies?: Record<string, string>;
      publishConfig?: { access?: string; provenance?: boolean };
      scripts?: Record<string, string>;
    };

    assert.equal(packageJson.name, "@drive9/drive9-pi");
    assert.equal(packageJson.license, "Apache-2.0");
    assert.ok(packageJson.keywords?.includes("pi-package"));
    assert.deepEqual(packageJson.pi?.extensions, ["./dist/pi-extension.js"]);
    assert.deepEqual(packageJson.publishConfig, { access: "public" });
    assert.ok(packageJson.files?.includes("dist"));
    assert.ok(packageJson.files?.includes("src"));
    assert.ok(packageJson.files?.includes("schema/drive9.schema.json"));
    assert.ok(packageJson.files?.includes("LICENSE"));
    assert.ok(packageJson.files?.includes("scripts/release-public.sh"));
    assert.equal(packageJson.scripts?.prepare, undefined);
    assert.equal(packageJson.scripts?.prepack, "npm run build");
    assert.equal(packageJson.scripts?.["release:check"], "bash scripts/release-public.sh --check");
    assert.equal(packageJson.scripts?.["release:publish"], "bash scripts/release-public.sh --publish");
    assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-agent-core"], "*");
    assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
    assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-tui"], "*");
    assert.equal(packageJson.peerDependencies?.typebox, "*");

    const [license, readme, releaseScript] = await Promise.all([
      readFile(new URL("../LICENSE", import.meta.url), "utf8"),
      readFile(new URL("../README.md", import.meta.url), "utf8"),
      readFile(new URL("../scripts/release-public.sh", import.meta.url), "utf8"),
    ]);
    assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
    assert.doesNotMatch(readme, /@drive9-ai\/drive9-pi/);
    assert.match(readme, /npm:@drive9\/drive9-pi/);
    assert.match(releaseScript, /npm org ls drive9/);
    assert.match(releaseScript, /--provenance=false/);
    assert.match(releaseScript, /committed dist output is stale/);

    const syntax = spawnSync("bash", ["-n", new URL("../scripts/release-public.sh", import.meta.url).pathname], {
      encoding: "utf8",
    });
    assert.equal(syntax.status, 0, syntax.stderr);
  });
});

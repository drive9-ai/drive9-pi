/**
 * Clean-consumer release gate for the Pi 1.0 durable integration.
 *
 * The test packs this repository, installs the tarball into a fresh npm
 * project, and runs the real crash matrix from that project's node_modules.
 * The consumer imports only public package exports. The inner script mints
 * short-lived, disjoint Drive9 credentials and uses a live Drive9 0.2.0
 * backend. It prints SKIP when the authenticated backend is unavailable;
 * DRIVE9_E2E_REQUIRED=1 turns that condition into a failure.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = join(repositoryRoot, "e2e", "pi-consume-crash-consumer.mjs");
const consumerRoot = await mkdtemp(join(tmpdir(), "drive9-pi-consumer-"));

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function dependencyVersions(
  tree: { dependencies?: Record<string, unknown> },
  name: string,
  versions = new Set<string>(),
): Set<string> {
  for (const [dependencyName, dependency] of Object.entries(tree.dependencies ?? {})) {
    if (typeof dependency !== "object" || dependency === null) continue;
    const node = dependency as {
      version?: unknown;
      dependencies?: Record<string, unknown>;
    };
    if (dependencyName === name && typeof node.version === "string") versions.add(node.version);
    dependencyVersions(node, name, versions);
  }
  return versions;
}

try {
  const fixtureSource = await readFile(fixturePath, "utf8");
  assert.equal(
    fixtureSource.includes("../src") || fixtureSource.includes("@drive9/drive9-pi/src"),
    false,
    "clean consumer must not import drive9-pi source internals",
  );

  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", consumerRoot], repositoryRoot),
  ) as Array<{ filename?: unknown }>;
  const filename = packed[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack must return the tarball filename");
  const tarball = join(consumerRoot, filename);

  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify({ name: "drive9-pi-clean-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  await copyFile(fixturePath, join(consumerRoot, "consume-chain.mjs"));

  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--legacy-peer-deps",
      tarball,
      "@earendil-works/chord@1.0.0",
      "@earendil-works/pi-agent-core@0.84.1",
      "@earendil-works/pi-ai@0.84.1",
      "@earendil-works/pi-coding-agent@0.84.1",
      "@earendil-works/pi-durable@1.0.0",
      "@earendil-works/pi-tui@0.84.1",
      "typebox@1.3.7",
      "undici@8.9.0",
    ],
    consumerRoot,
  );

  const dependencyTree = JSON.parse(run("npm", ["ls", "drive9", "--all", "--json"], consumerRoot)) as {
    dependencies?: Record<string, unknown>;
  };
  assert.deepEqual(
    [...dependencyVersions(dependencyTree, "drive9")],
    ["0.2.0"],
    "clean consumer must resolve the released Drive9 0.2.0 SDK",
  );

  const result = spawnSync(process.execPath, [join(consumerRoot, "consume-chain.mjs")], {
    cwd: consumerRoot,
    env: process.env,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  assert.equal(result.status, 0, "clean consumer crash/restart gate failed");
} finally {
  await rm(consumerRoot, { recursive: true, force: true });
}

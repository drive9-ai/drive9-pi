import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
  DRIVE9_EXTENSION_CONFIG_FILENAME,
  DRIVE9_PROJECT_TRUST_MARKER_FILENAME,
  type Drive9ExtensionConfig,
  type Drive9ExtensionConfigIO,
  ensureDrive9ProjectTrustMarker,
  getDrive9ProjectConfigPath,
  getDrive9ProjectTrustMarkerPath,
  parseDrive9ExtensionConfig,
  readDrive9ProjectConfig,
  resolveDrive9ExtensionConfig,
  validateDrive9ExtensionConfig,
  writeDrive9ProjectConfig,
} from "../src/pi-extension-config.js";

const ACTIVE_CONFIG: Drive9ExtensionConfig = {
  version: 1,
  enabled: true,
  root: "/workspaces/project",
};

async function withTemporaryDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "drive9-pi-extension-config-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeRawProjectConfig(cwd: string, value: unknown): Promise<void> {
  const configPath = getDrive9ProjectConfigPath(cwd);
  await mkdir(dirname(configPath), { recursive: true });
  const content = typeof value === "string" ? value : JSON.stringify(value);
  await writeFile(configPath, content, "utf8");
}

function unusedIO(overrides: Partial<Drive9ExtensionConfigIO> = {}): Drive9ExtensionConfigIO {
  const unused = async (): Promise<never> => {
    throw new Error("unexpected config IO");
  };
  return {
    pathExists: unused,
    readText: unused,
    makeDirectory: unused,
    writeTextExclusive: unused,
    rename: unused,
    remove: unused,
    ...overrides,
  };
}

describe("Pi extension config paths and schema", () => {
  it("uses Pi's configured project directory and trust marker", () => {
    assert.equal(
      getDrive9ProjectConfigPath("/repo"),
      join("/repo", CONFIG_DIR_NAME, DRIVE9_EXTENSION_CONFIG_FILENAME),
    );
    assert.equal(
      getDrive9ProjectTrustMarkerPath("/repo"),
      join("/repo", CONFIG_DIR_NAME, DRIVE9_PROJECT_TRUST_MARKER_FILENAME),
    );
  });

  it("parses version 1 and normalizes a valid Drive9 root", () => {
    assert.deepEqual(
      parseDrive9ExtensionConfig(
        JSON.stringify({ version: 1, enabled: true, root: "/workspaces/cafe\u0301/" }),
      ),
      { version: 1, enabled: true, root: "/workspaces/caf\u00e9" },
    );
  });

  it("rejects malformed JSON, non-objects, unknown keys, and missing keys", () => {
    assert.throws(() => parseDrive9ExtensionConfig("{"), /invalid JSON/);
    assert.throws(() => validateDrive9ExtensionConfig([]), /expected a JSON object/);
    assert.throws(
      () => validateDrive9ExtensionConfig({ ...ACTIVE_CONFIG, apiKey: "must-not-be-stored" }),
      /unknown key: apiKey/,
    );
    for (const key of ["version", "enabled", "root"] as const) {
      const value: Record<string, unknown> = { ...ACTIVE_CONFIG };
      delete value[key];
      assert.throws(() => validateDrive9ExtensionConfig(value), new RegExp(`missing required key: ${key}`));
    }
  });

  it("rejects wrong field types and unsafe or non-workspace roots", () => {
    assert.throws(
      () => validateDrive9ExtensionConfig({ ...ACTIVE_CONFIG, version: 2 }),
      /version must be 1/,
    );
    assert.throws(
      () => validateDrive9ExtensionConfig({ ...ACTIVE_CONFIG, enabled: "yes" }),
      /enabled must be a boolean/,
    );
    for (const root of ["", "relative/path", "/", "/unsafe%2fpath", "/unsafe?query", 42]) {
      assert.throws(() => validateDrive9ExtensionConfig({ ...ACTIVE_CONFIG, root }), /root/);
    }
  });
});

describe("Pi extension project config IO", () => {
  it("does not read project config unless the caller marks the project trusted", async () => {
    let reads = 0;
    const io = unusedIO({
      pathExists: async () => {
        throw new Error("must not check marker");
      },
      readText: async () => {
        reads += 1;
        throw new Error("must not read");
      },
    });

    assert.equal(
      await readDrive9ProjectConfig({ cwd: "/repo", trusted: false, io }),
      undefined,
    );
    assert.equal(reads, 0);
  });

  it("does not read drive9.json when the standard Pi trust marker is absent", async () => {
    await withTemporaryDirectory(async (cwd) => {
      assert.equal(await readDrive9ProjectConfig({ cwd, trusted: true }), undefined);

      await writeRawProjectConfig(cwd, "{");
      assert.equal(await readDrive9ProjectConfig({ cwd, trusted: true }), undefined);
    });
  });

  it("reads project config only after the standard Pi trust marker exists", async () => {
    await withTemporaryDirectory(async (cwd) => {
      await writeRawProjectConfig(cwd, ACTIVE_CONFIG);
      await ensureDrive9ProjectTrustMarker({ cwd, trusted: true });
      assert.deepEqual(await readDrive9ProjectConfig({ cwd, trusted: true }), ACTIVE_CONFIG);

      await writeRawProjectConfig(cwd, "{");
      await assert.rejects(
        readDrive9ProjectConfig({ cwd, trusted: true }),
        /invalid JSON/,
      );
    });
  });

  it("creates a minimal marker and writes a strict config without leftover temp files", async () => {
    await withTemporaryDirectory(async (cwd) => {
      const configPath = await writeDrive9ProjectConfig({
        cwd,
        trusted: true,
        config: { ...ACTIVE_CONFIG, root: "/workspaces/project/" },
      });

      assert.equal(configPath, getDrive9ProjectConfigPath(cwd));
      assert.equal(
        await readFile(configPath, "utf8"),
        '{\n  "version": 1,\n  "enabled": true,\n  "root": "/workspaces/project"\n}\n',
      );
      assert.equal(await readFile(getDrive9ProjectTrustMarkerPath(cwd), "utf8"), "{}\n");
      assert.deepEqual(
        (await readdir(dirname(configPath))).sort(),
        [DRIVE9_EXTENSION_CONFIG_FILENAME, DRIVE9_PROJECT_TRUST_MARKER_FILENAME].sort(),
      );

      await assert.rejects(
        writeDrive9ProjectConfig({
          cwd,
          trusted: true,
          config: { ...ACTIVE_CONFIG, apiKey: "secret" } as Drive9ExtensionConfig,
        }),
        /unknown key: apiKey/,
      );
      assert.doesNotMatch(await readFile(configPath, "utf8"), /secret|apiKey/);
    });
  });

  it("preserves existing Pi settings byte-for-byte and rejects untrusted marker writes", async () => {
    await withTemporaryDirectory(async (cwd) => {
      const markerPath = getDrive9ProjectTrustMarkerPath(cwd);
      const existingSettings = '{"extensions":["existing-package"]}\n';
      await mkdir(dirname(markerPath), { recursive: true });
      await writeFile(markerPath, existingSettings, "utf8");

      assert.equal(
        await ensureDrive9ProjectTrustMarker({ cwd, trusted: true }),
        markerPath,
      );
      await writeDrive9ProjectConfig({ cwd, trusted: true, config: ACTIVE_CONFIG });
      assert.equal(await readFile(markerPath, "utf8"), existingSettings);
    });

    const io = unusedIO();
    await assert.rejects(
      ensureDrive9ProjectTrustMarker({ cwd: "/repo", trusted: false, io }),
      /untrusted project/,
    );
  });

  it("uses exclusive marker and same-directory temp writes followed by rename", async () => {
    const events: string[] = [];
    let temporaryPath: string | undefined;
    const destinationPath = getDrive9ProjectConfigPath("/repo");
    const markerPath = getDrive9ProjectTrustMarkerPath("/repo");
    const io = unusedIO({
      makeDirectory: async (path) => {
        events.push(`mkdir:${path}`);
      },
      writeTextExclusive: async (path, content) => {
        if (path === markerPath) {
          assert.equal(content, "{}\n");
          events.push(`marker:${path}`);
          return;
        }
        temporaryPath = path;
        assert.equal(dirname(path), dirname(destinationPath));
        assert.match(path, /^\/repo\/\.pi\/\.drive9\.json\..+\.tmp$/);
        assert.ok(content.endsWith("\n"));
        events.push(`write:${path}`);
      },
      rename: async (sourcePath, targetPath) => {
        assert.equal(sourcePath, temporaryPath);
        assert.equal(targetPath, destinationPath);
        events.push(`rename:${sourcePath}`);
      },
    });

    await writeDrive9ProjectConfig({ cwd: "/repo", trusted: true, config: ACTIVE_CONFIG, io });
    assert.equal(events.length, 4);
    assert.match(events[0]!, /^mkdir:/);
    assert.match(events[1]!, /^marker:/);
    assert.match(events[2]!, /^write:/);
    assert.match(events[3]!, /^rename:/);
  });

  it("cleans only a temp file it created and refuses untrusted writes", async () => {
    let writtenPath: string | undefined;
    let removedPath: string | undefined;
    const io = unusedIO({
      makeDirectory: async () => {},
      writeTextExclusive: async (path) => {
        if (path === getDrive9ProjectTrustMarkerPath("/repo")) return;
        writtenPath = path;
      },
      rename: async () => {
        throw new Error("rename failed");
      },
      remove: async (path) => {
        removedPath = path;
      },
    });

    await assert.rejects(
      writeDrive9ProjectConfig({ cwd: "/repo", trusted: true, config: ACTIVE_CONFIG, io }),
      /could not be written atomically/,
    );
    assert.equal(removedPath, writtenPath);

    removedPath = undefined;
    const collisionIO = unusedIO({
      makeDirectory: async () => {},
      writeTextExclusive: async (path) => {
        if (path === getDrive9ProjectTrustMarkerPath("/repo")) return;
        throw Object.assign(new Error("temp collision"), { code: "EEXIST" });
      },
      remove: async (path) => {
        removedPath = path;
      },
    });
    await assert.rejects(
      writeDrive9ProjectConfig({
        cwd: "/repo",
        trusted: true,
        config: ACTIVE_CONFIG,
        io: collisionIO,
      }),
      /could not be written atomically/,
    );
    assert.equal(removedPath, undefined);

    await assert.rejects(
      writeDrive9ProjectConfig({ cwd: "/repo", trusted: false, config: ACTIVE_CONFIG, io }),
      /untrusted project/,
    );
  });
});

describe("Pi extension config resolution", () => {
  it("applies no-drive9, CLI, and environment precedence without lower-priority reads", async () => {
    let reads = 0;
    const io = unusedIO({
      readText: async () => {
        reads += 1;
        throw new Error("lower-priority project config must not be read");
      },
    });

    assert.deepEqual(
      await resolveDrive9ExtensionConfig({
        cwd: "/repo",
        projectTrusted: true,
        noDrive9: true,
        cliRoot: "relative",
        environment: { DRIVE9_PI_ROOT: "relative" },
        defaultRoot: "relative",
        io,
      }),
      { status: "inactive", source: "no-drive9", reason: "disabled" },
    );
    assert.equal(reads, 0);

    assert.deepEqual(
      await resolveDrive9ExtensionConfig({
        cwd: "/repo",
        projectTrusted: true,
        cliRoot: " /cli/../cli-root/ ",
        environment: { DRIVE9_PI_ROOT: "/env" },
        io,
      }),
      { status: "active", source: "cli", root: "/cli-root" },
    );
    assert.equal(reads, 0);

    assert.deepEqual(
      await resolveDrive9ExtensionConfig({
        cwd: "/repo",
        projectTrusted: true,
        environment: { DRIVE9_PI_ROOT: "/env" },
        defaultRoot: "/default",
        io,
      }),
      { status: "active", source: "env", root: "/env" },
    );
    assert.equal(reads, 0);
  });

  it("uses trusted project config before programmatic default and ignores it when untrusted", async () => {
    await withTemporaryDirectory(async (cwd) => {
      await writeRawProjectConfig(cwd, ACTIVE_CONFIG);
      await ensureDrive9ProjectTrustMarker({ cwd, trusted: true });

      assert.deepEqual(
        await resolveDrive9ExtensionConfig({
          cwd,
          projectTrusted: true,
          environment: {},
          defaultRoot: "/default",
        }),
        { status: "active", source: "project", root: ACTIVE_CONFIG.root },
      );
      assert.deepEqual(
        await resolveDrive9ExtensionConfig({
          cwd,
          projectTrusted: false,
          environment: {},
          defaultRoot: "/default",
        }),
        { status: "active", source: "programmatic", root: "/default" },
      );
    });
  });

  it("honors a trusted project disable and otherwise resolves the inactive state", async () => {
    await withTemporaryDirectory(async (cwd) => {
      await writeRawProjectConfig(cwd, { ...ACTIVE_CONFIG, enabled: false });
      await ensureDrive9ProjectTrustMarker({ cwd, trusted: true });
      assert.deepEqual(
        await resolveDrive9ExtensionConfig({ cwd, projectTrusted: true, environment: {} }),
        { status: "inactive", source: "project", reason: "disabled" },
      );
    });

    assert.deepEqual(
      await resolveDrive9ExtensionConfig({
        cwd: "/repo",
        projectTrusted: false,
        environment: {},
      }),
      { status: "inactive", source: "none", reason: "unconfigured" },
    );
  });

  it("returns explicit errors instead of silently treating invalid sources as inactive", async () => {
    for (const cliRoot of [true, "", "relative"] as const) {
      const result = await resolveDrive9ExtensionConfig({
        cwd: "/repo",
        projectTrusted: false,
        cliRoot,
        environment: {},
      });
      assert.equal(result.status, "error");
      assert.equal(result.source, "cli");
    }

    const envResult = await resolveDrive9ExtensionConfig({
      cwd: "/repo",
      projectTrusted: false,
      environment: { DRIVE9_PI_ROOT: "" },
    });
    assert.equal(envResult.status, "error");
    assert.equal(envResult.source, "env");

    const defaultResult = await resolveDrive9ExtensionConfig({
      cwd: "/repo",
      projectTrusted: false,
      environment: {},
      defaultRoot: "/",
    });
    assert.equal(defaultResult.status, "error");
    assert.equal(defaultResult.source, "programmatic");

    await withTemporaryDirectory(async (cwd) => {
      await writeRawProjectConfig(cwd, { ...ACTIVE_CONFIG, apiKey: "forbidden" });
      await ensureDrive9ProjectTrustMarker({ cwd, trusted: true });
      const projectResult = await resolveDrive9ExtensionConfig({
        cwd,
        projectTrusted: true,
        environment: {},
        defaultRoot: "/default",
      });
      assert.equal(projectResult.status, "error");
      assert.equal(projectResult.source, "project");
      if (projectResult.status === "error") assert.match(projectResult.error.message, /unknown key: apiKey/);
    });
  });
});

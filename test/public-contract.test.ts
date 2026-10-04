import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as packageExports from "../src/index.js";
import type {
  Drive9ExtensionConfig,
  Drive9ExtensionConfigIO,
  ResolveDrive9ExtensionConfigOptions,
} from "../src/index.js";

describe("public package contract", () => {
  it("exports SDK filesystem, file-only execution environment, and evidence capabilities", () => {
    assert.equal(typeof packageExports.createDrive9PiIntegration, "function");
    assert.equal(typeof packageExports.createDrive9FileTools, "function");
    assert.equal(typeof packageExports.createDrive9CodingAgentTools, "function");
    assert.equal(typeof packageExports.createDrive9PiExtension, "function");
    assert.equal(typeof packageExports.ensureDrive9ProjectTrustMarker, "function");
    assert.equal(typeof packageExports.getDrive9ProjectConfigPath, "function");
    assert.equal(typeof packageExports.getDrive9ProjectTrustMarkerPath, "function");
    assert.equal(typeof packageExports.parseDrive9ExtensionConfig, "function");
    assert.equal(typeof packageExports.readDrive9ProjectConfig, "function");
    assert.equal(typeof packageExports.resolveDrive9ExtensionConfig, "function");
    assert.equal(typeof packageExports.validateDrive9ExtensionConfig, "function");
    assert.equal(typeof packageExports.writeDrive9ProjectConfig, "function");
    assert.equal(typeof packageExports.Drive9ExtensionConfigError, "function");
    assert.equal(typeof packageExports.chainAfterToolCall, "function");
    assert.equal(typeof packageExports.Drive9FileSystem, "function");
    assert.equal(typeof packageExports.Drive9SdkExecutionEnv, "function");
    assert.equal(typeof packageExports.Drive9ProtocolError, "function");
    assert.equal(typeof packageExports.createDrive9DurableExtension, "function");
    assert.equal(typeof packageExports.createDrive9WorkspaceCoordinator, "function");
    assert.equal(typeof packageExports.Drive9WorkspaceCoordinator, "function");
    assert.equal(typeof packageExports.withDrive9Effects, "function");
    assert.equal(typeof packageExports.openDrive9SingleCoordinatorStorage, "function");
    assert.equal(typeof packageExports.storageProfile, "function");
    assert.equal(typeof packageExports.requireServerFencedStorage, "function");
    assert.equal(typeof packageExports.Drive9LayerWorkspaceBackend, "function");
    assert.equal(typeof packageExports.createDrive9ConversationCreated, "function");
    assert.equal(typeof packageExports.deriveDrive9WorkspaceId, "function");
    assert.equal(typeof packageExports.Drive9WorkspaceDoc, "object");
    assert.equal(typeof packageExports.readDrive9WorkspaceDocument, "function");
    assert.equal(typeof packageExports.inspectWorkspaceCandidateInventory, "function");
    assert.equal(typeof packageExports.reportWorkspaceCandidateInventory, "function");
    assert.equal(typeof packageExports.reclaimOrphanLayers, "function");
    assert.equal(typeof packageExports.PersistentToolResultStore, "function");
    assert.equal(typeof packageExports.verifyRuntimeIsolation, "function");
    assert.equal("Drive9ExecutionEnv" in packageExports, false);
    assert.equal("composeExecutionEnv" in packageExports, false);
    assert.equal("Drive9LayerWorkspaceRevisionProvider" in packageExports, false);
    assert.equal("Drive9LayerFileSystem" in packageExports, false);
    assert.equal("createDrive9ExecTool" in packageExports, false);
    assert.equal("createDrive9MountDrain" in packageExports, false);
    assert.equal("markServerFencedStorage" in packageExports, false);
  });

  it("exports the config types needed by custom Pi integrations", () => {
    const config: Drive9ExtensionConfig = {
      version: packageExports.DRIVE9_EXTENSION_CONFIG_VERSION,
      enabled: true,
      root: "/workspace",
    };
    const io: Drive9ExtensionConfigIO = {
      pathExists: async () => true,
      readText: async () => JSON.stringify(config),
      makeDirectory: async () => {},
      writeTextExclusive: async () => {},
      rename: async () => {},
      remove: async () => {},
    };
    const options: ResolveDrive9ExtensionConfigOptions = {
      cwd: "/repo",
      projectTrusted: true,
      environment: {},
      io,
    };

    assert.equal(options.io, io);
  });
});

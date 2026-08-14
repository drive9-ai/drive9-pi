import { getOrThrow } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Client } from "drive9";
import {
  createDrive9PiExtension,
  Drive9FileSystem,
} from "../src/index.js";

export const readmeExtensionUsage: ExtensionFactory = createDrive9PiExtension({
  defaultRoot: "/workspaces/my-project",
  createClient: () => Client.defaultClient(),
});

export async function readmeFileSystemUsage(): Promise<string> {
  const fileSystem = new Drive9FileSystem({
    client: Client.defaultClient(),
    root: "/workspaces/my-project",
  });

  getOrThrow(await fileSystem.writeFile("src/auth.ts", "export const enabled = true;\n"));
  return getOrThrow(await fileSystem.readTextFile("src/auth.ts"));
}

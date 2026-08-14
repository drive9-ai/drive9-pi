import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const USAGE = "/drive9 [status|setup [root]|disable|verify [read|write]]";
export const DRIVE9_COMMAND_DESCRIPTION = "Set up and inspect the Drive9 workspace";

export interface Drive9CommandActions {
  status(context: ExtensionCommandContext): Promise<void>;
  setup(context: ExtensionCommandContext, root?: string): Promise<void>;
  disable(context: ExtensionCommandContext): Promise<void>;
  verify(context: ExtensionCommandContext, write: boolean): Promise<void>;
}

interface ParsedDrive9Command {
  command: "status" | "setup" | "disable" | "verify" | "help";
  root?: string;
  write?: boolean;
}

function splitArguments(args: string): string[] {
  return args.trim().split(/\s+/u).filter((part) => part.length > 0);
}

export function parseDrive9Command(args: string): ParsedDrive9Command {
  const trimmed = args.trim();
  const parts = splitArguments(trimmed);
  const command = parts.shift();

  if (command === undefined || command === "status") {
    if (parts.length > 0) throw new TypeError(`Usage: ${USAGE}`);
    return { command: "status" };
  }
  if (command === "help" || command === "--help" || command === "-h") {
    if (parts.length > 0) throw new TypeError(`Usage: ${USAGE}`);
    return { command: "help" };
  }
  if (command === "setup") {
    const root = trimmed.slice(command.length).trim();
    return root.length === 0 ? { command: "setup" } : { command: "setup", root };
  }
  if (command === "disable" || command === "off") {
    if (parts.length > 0) throw new TypeError(`Usage: ${USAGE}`);
    return { command: "disable" };
  }
  if (command === "verify") {
    if (parts.length > 1 || (parts[0] !== undefined && parts[0] !== "read" && parts[0] !== "write")) {
      throw new TypeError(`Usage: ${USAGE}`);
    }
    return { command: "verify", write: parts[0] === "write" };
  }
  throw new TypeError(`Unknown Drive9 command: ${command}. Usage: ${USAGE}`);
}

export function completeDrive9Command(argumentPrefix: string): AutocompleteItem[] | null {
  const parts = argumentPrefix.split(/\s+/u);
  if (parts.length > 1 && parts[0] === "verify") {
    const prefix = parts.at(-1) ?? "";
    const items = ["read", "write"]
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({ value: `verify ${value}`, label: `verify ${value}` }));
    return items.length > 0 ? items : null;
  }
  if (parts.length > 1) return null;
  const prefix = parts[0] ?? "";
  const items = ["status", "setup", "disable", "verify", "help"]
    .filter((value) => value.startsWith(prefix))
    .map((value) => ({ value, label: value }));
  return items.length > 0 ? items : null;
}

export function registerDrive9Command(pi: ExtensionAPI, actions: Drive9CommandActions): void {
  pi.registerCommand("drive9", {
    description: DRIVE9_COMMAND_DESCRIPTION,
    getArgumentCompletions: completeDrive9Command,
    handler: async (args, context) => {
      let parsed: ParsedDrive9Command;
      try {
        parsed = parseDrive9Command(args);
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      switch (parsed.command) {
        case "status":
          await actions.status(context);
          return;
        case "setup":
          await actions.setup(context, parsed.root);
          return;
        case "disable":
          await actions.disable(context);
          return;
        case "verify":
          await actions.verify(context, parsed.write === true);
          return;
        case "help":
          context.ui.notify(`Usage: ${USAGE}`, "info");
      }
    },
  });
}

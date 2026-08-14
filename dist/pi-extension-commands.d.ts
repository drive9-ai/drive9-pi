import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
export declare const DRIVE9_COMMAND_DESCRIPTION = "Set up and inspect the Drive9 workspace";
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
export declare function parseDrive9Command(args: string): ParsedDrive9Command;
export declare function completeDrive9Command(argumentPrefix: string): AutocompleteItem[] | null;
export declare function registerDrive9Command(pi: ExtensionAPI, actions: Drive9CommandActions): void;
export {};
//# sourceMappingURL=pi-extension-commands.d.ts.map
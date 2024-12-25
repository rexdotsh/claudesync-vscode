import * as vscode from "vscode";
import { ConfigManager } from "./config";
import { SyncManager } from "./syncManager";

let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("ClaudeSync");

  const configManager = new ConfigManager(context, outputChannel);
  let syncManager: SyncManager;

  const updateSyncManager = async () => {
    const config = await configManager.getConfig();
    syncManager = new SyncManager(config, outputChannel, configManager);
  };
  await updateSyncManager();

  // function to handle file changes for autosync
  let autoSyncTimer: NodeJS.Timeout | undefined;
  const handleFileChange = async (uri: vscode.Uri) => {
    const config = await configManager.getConfig();
    if (!config.autoSync || !config.sessionToken) {
      return;
    }

    // clear existing timer
    if (autoSyncTimer) {
      clearTimeout(autoSyncTimer);
    }

    // set new timer
    autoSyncTimer = setTimeout(async () => {
      await syncFiles([uri]);
    }, config.autoSyncDelay * 1000);
  };

  // file system watcher
  const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*");
  fileWatcher.onDidChange(handleFileChange);
  fileWatcher.onDidCreate(handleFileChange);

  // command to configure autosync
  const configureAutoSyncCommand = vscode.commands.registerCommand(
    "claudesync.configureAutoSync",
    async (): Promise<void> => {
      const config = await configManager.getConfig();

      // ask user to enable/disable autosync
      const enableAutoSync = await vscode.window.showQuickPick(["Enable", "Disable"], {
        placeHolder: "Enable or disable auto-sync?",
      });

      if (!enableAutoSync) {
        return;
      }

      let autoSyncDelay = config.autoSyncDelay;
      if (enableAutoSync === "Enable") {
        // get delay from user (10 seconds to 3 minutes)
        const delay = await vscode.window.showInputBox({
          prompt: "Enter auto-sync delay in seconds (10-180)",
          value: String(config.autoSyncDelay),
          validateInput: (value) => {
            const num = parseInt(value);
            if (isNaN(num) || num < 10 || num > 180) {
              return "Please enter a number between 10 and 180 seconds";
            }
            return null;
          },
        });

        if (!delay) {
          vscode.window.showErrorMessage("Auto-sync delay cannot be empty");
          return;
        }
        autoSyncDelay = parseInt(delay);
      }

      // Save configuration
      await configManager.saveWorkspaceConfig({
        autoSync: enableAutoSync === "Enable",
        autoSyncDelay,
      });

      vscode.window.showInformationMessage(
        `Auto-sync ${enableAutoSync === "Enable" ? "enabled" : "disabled"}${
          enableAutoSync === "Enable" ? ` with ${autoSyncDelay} seconds delay` : ""
        }`
      );
    }
  );

  async function syncFiles(files: vscode.Uri[]) {
    const config = await configManager.getConfig();
    if (!config.sessionToken) {
      const setToken = await vscode.window.showErrorMessage("Please set your Claude session token first", "Set Token");
      if (setToken) {
        await vscode.commands.executeCommand("claudesync.setToken");
        return;
      }
      return;
    }

    // check if project is initialized first
    const isInitialized = await syncManager.isProjectInitialized();
    if (!isInitialized) {
      const init = await vscode.window.showErrorMessage("Project needs to be initialized first", "Initialize Project");
      if (init) {
        await vscode.commands.executeCommand("claudesync.initProject");
      }
      return;
    }

    // make this configurable?
    const maxRetries = 20;
    let attempt = 0;
    let success = false;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Syncing ${files.length} file${files.length === 1 ? "" : "s"} with Claude`,
        cancellable: false,
      },
      async (progress) => {
        while (attempt < maxRetries && !success) {
          try {
            progress.report({ message: attempt > 0 ? `Attempt ${attempt + 1}/${maxRetries}` : "Starting sync..." });
            const result = await syncManager.syncFiles(files);

            if (result.success) {
              success = true;
              outputChannel.appendLine(`Files synced successfully`);
              break;
            } else if (result.message?.includes("Project not initialized")) {
              const init = await vscode.window.showErrorMessage(
                result.message || "Project not initialized",
                "Initialize Project"
              );
              if (init) {
                await vscode.commands.executeCommand("claudesync.initProject");
              }
              success = false;
              break;
            } else {
              const errorMsg = result.error ? `${result.message}: ${result.error.message}` : result.message;
              outputChannel.appendLine(`Failed to sync files: ${errorMsg}`);
              if (attempt < maxRetries - 1) {
                await new Promise((resolve) => setTimeout(resolve, 150));
                attempt++;
                progress.report({ message: `Retrying... (Attempt ${attempt + 1}/${maxRetries})` });
              }
            }
          } catch (error) {
            const errorMsg = `Failed to sync files: ${error instanceof Error ? error.message : String(error)}`;
            outputChannel.appendLine(`Error: ${errorMsg}`);
            if (error instanceof Error && error.stack) {
              outputChannel.appendLine(`Stack trace: ${error.stack}`);
            }
            if (attempt < maxRetries - 1) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              attempt++;
              progress.report({ message: `Retrying... (Attempt ${attempt + 1}/${maxRetries})` });
            }
          }
        }

        if (success) {
          // add small delay to ensure progress notification has closed
          await new Promise((resolve) => setTimeout(resolve, 500));
          vscode.window.showInformationMessage(
            `Successfully synced ${files.length} file${files.length === 1 ? "" : "s"} with Claude!`
          );
        } else if (attempt >= maxRetries) {
          vscode.window.showErrorMessage("Failed to sync files after maximum retries");
        }
      }
    );
  }

  // command to set Claude session token
  const setTokenCommand = vscode.commands.registerCommand("claudesync.setToken", async () => {
    const token = await vscode.window.showInputBox({
      prompt: "Enter your Claude session token",
      password: true,
      placeHolder: "sk-ant-...",
      validateInput: (value) => {
        if (!value?.startsWith("sk-ant")) {
          return "Invalid token format. Token should start with 'sk-ant'";
        }
        return null;
      },
    });

    if (token) {
      try {
        await configManager.saveGlobalConfig({ sessionToken: token });
        await updateSyncManager();
        vscode.window.showInformationMessage("Claude session token has been successfully saved and configured");
      } catch (error) {
        const errorMsg = `Failed to save token: ${error instanceof Error ? error.message : String(error)}`;
        vscode.window.showErrorMessage(errorMsg);
      }
    }
  });

  // command to initialize project
  const initProjectCommand = vscode.commands.registerCommand("claudesync.initProject", async () => {
    const config = await configManager.getConfig();

    if (!config.sessionToken) {
      const setToken = await vscode.window.showErrorMessage("Please set your Claude session token first", "Set Token");
      if (setToken) {
        await vscode.commands.executeCommand("claudesync.setToken");
        return;
      }
      return;
    }

    try {
      const result = await syncManager.initializeProject();
      if (result.success) {
        const action = await vscode.window.showInformationMessage(
          result.message || "Project initialized successfully",
          "Sync Workspace"
        );
        if (action === "Sync Workspace") {
          await vscode.commands.executeCommand("claudesync.syncWorkspace");
        }
      } else {
        const errorMsg = result.error
          ? `${result.message || "Error"}: ${result.error.message}`
          : result.message || "Unknown error";
        vscode.window.showErrorMessage(errorMsg);
      }
    } catch (error) {
      const errorMsg = `Failed to initialize project: ${error instanceof Error ? error.message : String(error)}`;
      vscode.window.showErrorMessage(errorMsg);
    }
  });

  // command to sync current file
  const syncCurrentFileCommand = vscode.commands.registerCommand("claudesync.syncCurrentFile", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("No active file to sync");
      return;
    }
    await syncFiles([editor.document.uri]);
  });

  // command to sync entire workspace
  const syncWorkspaceCommand = vscode.commands.registerCommand("claudesync.syncWorkspace", async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("No workspace folder found");
      return;
    }

    try {
      const config = await configManager.getConfig();
      const excludePatterns = config.excludePatterns || [];
      outputChannel.appendLine(`Using exclude patterns from config: ${excludePatterns.join(", ")}`);

      const files = await vscode.workspace.findFiles("**/*", `{${excludePatterns.join(",")}}`);
      await syncFiles(files);
    } catch (error) {
      const errorMsg = `Failed to sync workspace: ${error instanceof Error ? error.message : String(error)}`;
      vscode.window.showErrorMessage(errorMsg);
    }
  });

  // Command to sync project instructions
  const syncProjectInstructionsCommand = vscode.commands.registerCommand(
    "claudesync.syncProjectInstructions",
    async () => {
      const config = await configManager.getConfig();
      if (!config.sessionToken) {
        const setToken = await vscode.window.showErrorMessage(
          "Please set your Claude session token first",
          "Set Token"
        );
        if (setToken) {
          await vscode.commands.executeCommand("claudesync.setToken");
          return;
        }
        return;
      }

      try {
        const result = await syncManager.syncProjectInstructions();
        if (result.success) {
          const message = result.message || "Project instructions synced successfully";
          vscode.window.showInformationMessage(message);
          outputChannel.appendLine(message);
        } else {
          const errorMsg = result.error
            ? `${result.message || "Error"}: ${result.error.message}`
            : result.message || "Unknown error";
          outputChannel.appendLine(`Failed to sync project instructions: ${errorMsg}`);
          vscode.window.showErrorMessage(errorMsg);
        }
      } catch (error) {
        const errorMsg = `Failed to sync project instructions: ${
          error instanceof Error ? error.message : String(error)
        }`;
        outputChannel.appendLine(`Error: ${errorMsg}`);
        if (error instanceof Error && error.stack) {
          outputChannel.appendLine(`Stack trace: ${error.stack}`);
        }
        vscode.window.showErrorMessage(errorMsg);
      }
    }
  );

  context.subscriptions.push(
    setTokenCommand,
    initProjectCommand,
    syncCurrentFileCommand,
    syncProjectInstructionsCommand,
    syncWorkspaceCommand,
    configureAutoSyncCommand,
    fileWatcher
  );
}

export function deactivate() {
  if (outputChannel) {
    outputChannel.dispose();
  }
}

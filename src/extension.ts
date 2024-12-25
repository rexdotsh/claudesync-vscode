import * as vscode from "vscode";
import { ConfigManager } from "./config";
import { SyncManager } from "./syncManager";

let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("ClaudeSync");

  const configManager = new ConfigManager(context, outputChannel);
  let syncManager: SyncManager;
  let fileWatcher: vscode.FileSystemWatcher | undefined;

  // function to handle file changes for autosync
  let autoSyncTimer: NodeJS.Timeout | undefined;
  const handleFileChange = async (uri: vscode.Uri) => {
    const config = await configManager.getConfig();
    if (!config.autoSync || !config.sessionToken) {
      return;
    }

    // don't sync if file is in excluded patterns
    const relativePath = vscode.workspace.asRelativePath(uri);
    const excludePatterns = config.excludePatterns || [];
    if (
      excludePatterns.some((pattern) => {
        // convert glob pattern to regex
        const regexPattern = pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, ".");
        return new RegExp(`^${regexPattern}$`).test(relativePath);
      })
    ) {
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

  const setupFileWatcher = async () => {
    // Cleanup existing watcher if any
    if (fileWatcher) {
      fileWatcher.dispose();
      fileWatcher = undefined;
    }

    const isInitialized = await syncManager?.isProjectInitialized();
    const config = await configManager.getConfig();

    // only setup watcher if project is initialized, has a token, and auto-sync is enabled
    if (isInitialized && config.sessionToken && config.autoSync) {
      // create watcher that ignores the config file and other excluded patterns
      const excludePattern = `{**/.vscode/claudesync.json,${config.excludePatterns.join(",")}}`;
      fileWatcher = vscode.workspace.createFileSystemWatcher(`**/*`, false, false, true);
      fileWatcher.onDidChange(handleFileChange);
      fileWatcher.onDidCreate(handleFileChange);

      // add to disposables
      context.subscriptions.push(fileWatcher);
    }
  };

  const updateSyncManager = async () => {
    const config = await configManager.getConfig();
    syncManager = new SyncManager(config, outputChannel, configManager);

    // sync workspace on startup if enabled and project is initialized
    const isInitialized = await syncManager.isProjectInitialized();
    if (isInitialized && config.sessionToken && config.syncOnStartup) {
      vscode.commands.executeCommand("claudesync.syncWorkspace");
    }

    // setup file watcher based on current state
    await setupFileWatcher();
  };
  await updateSyncManager();

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

      // save configuration
      await configManager.saveWorkspaceConfig({
        autoSync: enableAutoSync === "Enable",
        autoSyncDelay,
      });

      // update file watcher based on new auto-sync setting
      await setupFileWatcher();

      vscode.window.showInformationMessage(
        `Auto-sync ${enableAutoSync === "Enable" ? "enabled" : "disabled"}${
          enableAutoSync === "Enable" ? ` with ${autoSyncDelay} seconds delay` : ""
        }`
      );
    }
  );

  // command to configure startup sync
  const configureStartupSyncCommand = vscode.commands.registerCommand(
    "claudesync.configureStartupSync",
    async (): Promise<void> => {
      const config = await configManager.getConfig();

      const enableStartupSync = await vscode.window.showQuickPick(["Enable", "Disable"], {
        placeHolder: "Enable or disable sync on startup?",
      });

      if (!enableStartupSync) {
        return;
      }

      await configManager.saveWorkspaceConfig({
        syncOnStartup: enableStartupSync === "Enable",
      });

      vscode.window.showInformationMessage(
        `Sync on startup ${enableStartupSync === "Enable" ? "enabled" : "disabled"}`
      );
    }
  );

  // track last failed sync time to prevent rapid retries
  let lastFailedSyncTime = 0;
  const SYNC_COOLDOWN_MS = 500;

  async function syncFiles(files: vscode.Uri[]) {
    const config = await configManager.getConfig();
    if (!config.sessionToken) {
      const setToken = await vscode.window.showErrorMessage("Please set your Claude session token first", "Set Token");
      if (setToken) {
        await vscode.commands.executeCommand("claudesync.setToken");
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

    // check if we're in cooldown period after a failed sync
    const now = Date.now();
    if (now - lastFailedSyncTime < SYNC_COOLDOWN_MS) {
      outputChannel.appendLine("Skipping sync attempt - in cooldown period after recent failure");
      return;
    }

    if (files.length === 0) {
      vscode.window.showInformationMessage("No files to sync");
      return;
    }

    const maxRetries = 10; // claude api is very unreliable
    let attempt = 0;
    let success = false;
    let lastResult: any;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Syncing with Claude",
        cancellable: false,
      },
      async (progress) => {
        while (attempt < maxRetries && !success) {
          try {
            progress.report({ message: attempt > 0 ? `Attempt ${attempt + 1}/${maxRetries}` : "Processing files..." });
            const result = await syncManager.syncFiles(files);
            lastResult = result;

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
              attempt++;
              if (attempt >= maxRetries) {
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 150));
              progress.report({ message: `Retrying... (Attempt ${attempt + 1}/${maxRetries})` });
            }
          } catch (error) {
            const errorMsg = `Failed to sync files: ${error instanceof Error ? error.message : String(error)}`;
            outputChannel.appendLine(`Error: ${errorMsg}`);
            if (error instanceof Error && error.stack) {
              outputChannel.appendLine(`Stack trace: ${error.stack}`);
            }
            attempt++;
            if (attempt >= maxRetries) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
            progress.report({ message: `Retrying... (Attempt ${attempt + 1}/${maxRetries})` });
          }
        }

        if (!success) {
          lastFailedSyncTime = Date.now(); // start cooldown period
        }

        if (success) {
          // add small delay to ensure progress notification has closed
          await new Promise((resolve) => setTimeout(resolve, 500));
          const syncedFiles = lastResult?.data?.syncedFiles || 0;
          if (syncedFiles === 0) {
            vscode.window.showInformationMessage("No files needed syncing - all files were up to date.");
          } else {
            vscode.window.showInformationMessage(
              `Successfully synced ${syncedFiles} file${syncedFiles === 1 ? "" : "s"} with Claude!`
            );
          }
        } else {
          vscode.window.showErrorMessage(
            "Failed to sync files after maximum retries, is your Claude session token correct?"
          );
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
      outputChannel.appendLine(`Initialize project result: ${JSON.stringify(result)}`);
      if (result.success) {
        if (!result.message) {
          outputChannel.appendLine("Warning: No message received from syncManager.initializeProject()");
        }
        const message = result.message || "Unexpected: No initialization message received";
        const action = await vscode.window.showInformationMessage(message, "Sync Workspace", "Open in Browser");
        if (action === "Sync Workspace") {
          await vscode.commands.executeCommand("claudesync.syncWorkspace");
        } else if (action === "Open in Browser") {
          vscode.env.openExternal(vscode.Uri.parse(`https://claude.ai/project/${config.projectId}`));
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

      const files = await vscode.workspace.findFiles("**/*");
      outputChannel.appendLine(`Found ${files.length} total files before filtering`);
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

  // command to open project in browser
  const openInBrowserCommand = vscode.commands.registerCommand("claudesync.openInBrowser", async () => {
    const config = await configManager.getConfig();
    if (!config.sessionToken) {
      const setToken = await vscode.window.showErrorMessage("Please set your Claude session token first", "Set Token");
      if (setToken) {
        await vscode.commands.executeCommand("claudesync.setToken");
      }
      return;
    }

    if (!config.projectId) {
      const init = await vscode.window.showErrorMessage("Project needs to be initialized first", "Initialize Project");
      if (init) {
        await vscode.commands.executeCommand("claudesync.initProject");
      }
      return;
    }

    vscode.env.openExternal(vscode.Uri.parse(`https://claude.ai/project/${config.projectId}`));
  });

  context.subscriptions.push(
    setTokenCommand,
    initProjectCommand,
    syncCurrentFileCommand,
    syncWorkspaceCommand,
    syncProjectInstructionsCommand,
    configureAutoSyncCommand,
    configureStartupSyncCommand,
    openInBrowserCommand
  );

  // add file watcher to disposables if it exists
  if (fileWatcher) {
    context.subscriptions.push(fileWatcher);
  }
}

export function deactivate() {
  if (outputChannel) {
    outputChannel.dispose();
  }
}

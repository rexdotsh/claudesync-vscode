import * as vscode from "vscode";
import { ConfigManager } from "./config";
import { GitManager } from "./gitManager";
import { SyncManager } from "./syncManager";
import { SyncResult } from "./types";

let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("ClaudeSync");

  const configManager = new ConfigManager(outputChannel);
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

    // start auto-sync after delay
    autoSyncTimer = setTimeout(async () => {
      try {
        await syncFiles([uri]);
      } catch (error) {
        outputChannel.appendLine(`Auto-sync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
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
    const vscodeConfig = vscode.workspace.getConfiguration("claudesync");
    const syncOnStartup = vscodeConfig.get("syncOnStartup") as boolean;

    if (isInitialized && config.sessionToken && syncOnStartup) {
      outputChannel.appendLine(`Sync on startup is enabled: ${syncOnStartup}`);
      vscode.commands.executeCommand("claudesync.syncWorkspace");
    } else {
      outputChannel.appendLine(
        `Skipping sync on startup. Initialized: ${isInitialized}, Has token: ${!!config.sessionToken}, Sync on startup: ${syncOnStartup}`
      );
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
      const config = vscode.workspace.getConfiguration("claudesync");
      const currentValue = config.get<boolean>("syncOnStartup") || false;

      await config.update("syncOnStartup", !currentValue, true);

      vscode.window.showInformationMessage(`Sync on startup is now ${!currentValue ? "enabled" : "disabled"}`);
    }
  );

  // command to configure remote file cleanup
  const configureCleanupRemoteCommand = vscode.commands.registerCommand(
    "claudesync.configureCleanupRemote",
    async (): Promise<void> => {
      const config = await configManager.getConfig();

      const enableCleanup = await vscode.window.showQuickPick(["Enable", "Disable"], {
        placeHolder: "Enable or disable cleanup of remote files that don't exist locally?",
      });

      if (!enableCleanup) {
        return;
      }

      await configManager.saveWorkspaceConfig({
        cleanupRemoteFiles: enableCleanup === "Enable",
      });

      if (enableCleanup === "Enable") {
        const syncNow = await vscode.window.showInformationMessage(
          "Remote file cleanup enabled. Would you like to sync now to clean up remote files?",
          "Yes",
          "No"
        );
        if (syncNow === "Yes") {
          await vscode.commands.executeCommand("claudesync.syncWorkspace");
        }
      } else {
        vscode.window.showInformationMessage("Remote file cleanup disabled");
      }
    }
  );

  // track last failed sync time to prevent rapid retries
  let lastFailedSyncTime = 0;
  const SYNC_COOLDOWN_MS = 3000;

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

    const maxRetries = 20; // claude api is very unreliable
    let attempt = 0;
    let success = false;
    let lastResult: SyncResult;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Syncing with Claude",
        cancellable: false,
      },
      async (progress) => {
        while (attempt < maxRetries && !success) {
          try {
            progress.report({ message: "Processing files..." });
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
              await new Promise((resolve) => setTimeout(resolve, 3000));
              progress.report({ message: "Syncing..." });
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
            await new Promise((resolve) => setTimeout(resolve, 3000));
            progress.report({ message: "Syncing..." });
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
          vscode.window.showErrorMessage("Failed to sync files, is your Claude session token correct?");
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

  // update project instructions
  const updateProjectInstructionsCommand = vscode.commands.registerCommand(
    "claudesync.updateProjectInstructions",
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
          const message = result.message || "Project instructions updated successfully";
          vscode.window.showInformationMessage(message);
          outputChannel.appendLine(message);
        } else {
          const errorMsg = result.error
            ? `${result.message || "Error"}: ${result.error.message}`
            : result.message || "Unknown error";
          outputChannel.appendLine(`Failed to update project instructions: ${errorMsg}`);
          vscode.window.showErrorMessage(errorMsg);
        }
      } catch (error) {
        const errorMsg = `Failed to update project instructions: ${
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

  // command to exclude file from sync
  const excludeFromSyncCommand = vscode.commands.registerCommand(
    "claudesync.excludeFromSync",
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showErrorMessage("No file selected");
        return;
      }

      const config = await configManager.getConfig();
      const relativePath = vscode.workspace.asRelativePath(uri);
      const excludePatterns = config.excludePatterns || [];

      // Check if pattern already exists
      if (excludePatterns.includes(relativePath)) {
        vscode.window.showInformationMessage(`${relativePath} is already excluded from sync`);
        return;
      }

      try {
        // Add to exclude patterns
        excludePatterns.push(relativePath);
        await configManager.saveWorkspaceConfig({ excludePatterns });
        vscode.window.showInformationMessage(`${relativePath} excluded from sync`);

        // If auto-sync is enabled, trigger a sync to clean up the remote file
        if (config.autoSync && config.cleanupRemoteFiles) {
          await vscode.commands.executeCommand("claudesync.syncWorkspace");
        }
      } catch (error) {
        const errorMsg = `Failed to exclude file: ${error instanceof Error ? error.message : String(error)}`;
        vscode.window.showErrorMessage(errorMsg);
        outputChannel.appendLine(`Error: ${errorMsg}`);

        // Try to rollback the exclude pattern change
        try {
          const index = excludePatterns.indexOf(relativePath);
          if (index !== -1) {
            excludePatterns.splice(index, 1);
            await configManager.saveWorkspaceConfig({ excludePatterns });
          }
        } catch (rollbackError) {
          outputChannel.appendLine(`Failed to rollback exclude pattern: ${rollbackError}`);
        }
      }
    }
  );

  // command to include file in sync
  const includeInSyncCommand = vscode.commands.registerCommand("claudesync.includeInSync", async (uri: vscode.Uri) => {
    if (!uri) {
      vscode.window.showErrorMessage("No file selected");
      return;
    }

    const config = await configManager.getConfig();
    const relativePath = vscode.workspace.asRelativePath(uri);
    const excludePatterns = config.excludePatterns || [];

    // Check if pattern exists
    const index = excludePatterns.indexOf(relativePath);
    if (index === -1) {
      vscode.window.showInformationMessage(`${relativePath} is not excluded from sync`);
      return;
    }

    try {
      // Remove the pattern
      excludePatterns.splice(index, 1);
      await configManager.saveWorkspaceConfig({ excludePatterns });

      // Check if we can sync the file
      const isInitialized = await syncManager.isProjectInitialized();
      if (isInitialized && config.sessionToken) {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Including in Claude project",
            cancellable: false,
          },
          async (progress) => {
            progress.report({ message: "Syncing file..." });

            let attempts = 0;
            const maxAttempts = 10;
            const delayMs = 1000; // 1 second
            let lastError = "";

            while (attempts < maxAttempts) {
              const result = await syncManager.syncFiles([uri]);

              if (result.success) {
                if (result.data?.syncedFiles > 0) {
                  vscode.window.showInformationMessage(
                    `${relativePath} included in sync and uploaded to Claude project`
                  );
                } else {
                  vscode.window.showInformationMessage(`${relativePath} included in sync`);
                }
                return;
              }

              attempts++;
              lastError = result.message || "Unknown error";

              if (attempts < maxAttempts) {
                progress.report({ message: `Syncing...` });
                await new Promise((resolve) => setTimeout(resolve, delayMs));
              }
            }

            // If we get here, all attempts failed
            const errorMsg = lastError;
            vscode.window.showWarningMessage(`${relativePath} included in sync but upload failed: ${errorMsg}`);
            outputChannel.appendLine(`Failed to sync file: ${errorMsg}`);
          }
        );
      } else {
        vscode.window.showInformationMessage(`${relativePath} included in sync`);
      }
    } catch (error) {
      const errorMsg = `Failed to include file: ${error instanceof Error ? error.message : String(error)}`;
      vscode.window.showErrorMessage(errorMsg);
      outputChannel.appendLine(`Error: ${errorMsg}`);

      // Try to rollback the exclude pattern change
      try {
        if (!excludePatterns.includes(relativePath)) {
          excludePatterns.push(relativePath);
          await configManager.saveWorkspaceConfig({ excludePatterns });
        }
      } catch (rollbackError) {
        outputChannel.appendLine(`Failed to rollback include operation: ${rollbackError}`);
      }
    }
  });

  // command to show output channel
  const showOutputCommand = vscode.commands.registerCommand("claudesync.showOutput", () => {
    outputChannel.show();
  });

  // command to toggle gitignore setting
  const toggleGitignoreCommand = vscode.commands.registerCommand("claudesync.toggleGitignore", async () => {
    const config = vscode.workspace.getConfiguration("claudesync");
    const currentValue = config.get<boolean>("addToGitignore") || false;

    await config.update("addToGitignore", !currentValue, true);

    // If we're enabling it, ensure gitignore is updated
    if (!currentValue) {
      await configManager.getConfig(); // Force config refresh
      await new GitManager(outputChannel).ensureGitIgnore();
    }

    vscode.window.showInformationMessage(`Auto-add to gitignore is now ${!currentValue ? "enabled" : "disabled"}`);
  });

  context.subscriptions.push(
    setTokenCommand,
    initProjectCommand,
    syncCurrentFileCommand,
    syncWorkspaceCommand,
    syncProjectInstructionsCommand,
    updateProjectInstructionsCommand,
    configureAutoSyncCommand,
    configureStartupSyncCommand,
    configureCleanupRemoteCommand,
    openInBrowserCommand,
    excludeFromSyncCommand,
    includeInSyncCommand,
    showOutputCommand,
    toggleGitignoreCommand
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

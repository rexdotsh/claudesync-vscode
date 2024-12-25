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

    const maxRetries = 20; // Maximum number of retries
    let attempt = 0;
    let success = false;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Syncing files with Claude AI",
        cancellable: false,
      },
      async (progress) => {
        while (attempt < maxRetries && !success) {
          try {
            outputChannel.appendLine(`Syncing ${files.length} files... (Attempt ${attempt + 1}/${maxRetries})`);
            const result = await syncManager.syncFiles(files);

            if (result.success) {
              success = true;
              outputChannel.appendLine(`Files synced successfully: ${result.message}`);
            } else if (result.message.includes("Project not initialized")) {
              const init = await vscode.window.showErrorMessage(result.message, "Initialize Project");
              if (init) {
                await vscode.commands.executeCommand("claudesync.initProject");
              }
              success = false; // Ensure we don't show success message
              break; // Exit the retry loop
            } else {
              const errorMsg = result.error ? `${result.message}: ${result.error.message}` : result.message;
              outputChannel.appendLine(`Failed to sync files: ${errorMsg}`);
              if (attempt < maxRetries - 1) {
                await new Promise((resolve) => setTimeout(resolve, 150)); // Wait 150ms before retrying
                attempt++;
                progress.report({ message: `Retrying sync... (Attempt ${attempt + 1}/${maxRetries})` });
              }
            }
          } catch (error) {
            const errorMsg = `Failed to sync files: ${error instanceof Error ? error.message : String(error)}`;
            outputChannel.appendLine(`Error: ${errorMsg}`);
            if (error instanceof Error && error.stack) {
              outputChannel.appendLine(`Stack trace: ${error.stack}`);
            }
            if (attempt < maxRetries - 1) {
              await new Promise((resolve) => setTimeout(resolve, 100)); // Wait 100ms before retrying
              attempt++;
              progress.report({ message: `Retrying sync... (Attempt ${attempt + 1}/${maxRetries})` });
            }
          }
        }

        if (success) {
          vscode.window.showInformationMessage("Files synced successfully");
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
        vscode.window.showInformationMessage("Claude session token updated successfully");
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
        const action = await vscode.window.showInformationMessage(result.message, "Sync Workspace");
        if (action === "Sync Workspace") {
          await vscode.commands.executeCommand("claudesync.syncWorkspace");
        }
      } else {
        const errorMsg = result.error ? `${result.message}: ${result.error.message}` : result.message;
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
          vscode.window.showInformationMessage(result.message);
          outputChannel.appendLine(result.message);
        } else {
          const errorMsg = result.error ? `${result.message}: ${result.error.message}` : result.message;
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
    syncWorkspaceCommand
  );
}

export function deactivate() {
  if (outputChannel) {
    outputChannel.dispose();
  }
}

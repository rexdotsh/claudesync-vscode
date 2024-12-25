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

    try {
      outputChannel.appendLine(`Syncing ${files.length} files...`);
      const result = await syncManager.syncFiles(files);
      if (result.success) {
        vscode.window.showInformationMessage(result.message);
        outputChannel.appendLine(`Files synced successfully: ${result.message}`);
      } else {
        if (result.message.includes("Project not initialized")) {
          const init = await vscode.window.showErrorMessage(result.message, "Initialize Project");
          if (init) {
            await vscode.commands.executeCommand("claudesync.initProject");
          }
        } else {
          const errorMsg = result.error ? `${result.message}: ${result.error.message}` : result.message;
          outputChannel.appendLine(`Failed to sync files: ${errorMsg}`);
          vscode.window.showErrorMessage(errorMsg);
        }
      }
    } catch (error) {
      const errorMsg = `Failed to sync files: ${error instanceof Error ? error.message : String(error)}`;
      outputChannel.appendLine(`Error: ${errorMsg}`);
      if (error instanceof Error && error.stack) {
        outputChannel.appendLine(`Stack trace: ${error.stack}`);
      }
      vscode.window.showErrorMessage(errorMsg);
    }
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
        vscode.window.showInformationMessage(result.message);
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
      // always exclude node_modules, and any patterns in the config
      const excludePatterns = ["**/node_modules/**", ...(config.excludePatterns || [])];
      outputChannel.appendLine(`Using exclude patterns: ${excludePatterns.join(", ")}`);

      const files = await vscode.workspace.findFiles("**/*", `{${excludePatterns.join(",")}}`);
      await syncFiles(files);
    } catch (error) {
      const errorMsg = `Failed to sync workspace: ${error instanceof Error ? error.message : String(error)}`;
      vscode.window.showErrorMessage(errorMsg);
    }
  });

  // Command to sync selected files
  const syncSelectedCommand = vscode.commands.registerCommand(
    "claudesync.syncSelected",
    async (uri: vscode.Uri, uris: vscode.Uri[]) => {
      const filesToSync = uris || (uri ? [uri] : []);
      if (!filesToSync.length) {
        vscode.window.showErrorMessage("No files selected to sync");
        return;
      }

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
        outputChannel.appendLine(`Syncing files: ${filesToSync.map((f) => f.fsPath).join(", ")}`);
        const result = await syncManager.syncFiles(filesToSync);
        if (result.success) {
          vscode.window.showInformationMessage(result.message);
          outputChannel.appendLine(`Files synced successfully: ${result.message}`);
        } else {
          if (result.message.includes("Project not initialized")) {
            const init = await vscode.window.showErrorMessage(result.message, "Initialize Project");
            if (init) {
              await vscode.commands.executeCommand("claudesync.initProject");
            }
          } else {
            const errorMsg = result.error ? `${result.message}: ${result.error.message}` : result.message;
            outputChannel.appendLine(`Failed to sync files: ${errorMsg}`);
            vscode.window.showErrorMessage(errorMsg);
          }
        }
      } catch (error) {
        const errorMsg = `Failed to sync files: ${error instanceof Error ? error.message : String(error)}`;
        outputChannel.appendLine(`Error: ${errorMsg}`);
        if (error instanceof Error && error.stack) {
          outputChannel.appendLine(`Stack trace: ${error.stack}`);
        }
        vscode.window.showErrorMessage(errorMsg);
      }
    }
  );

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
    syncSelectedCommand,
    syncProjectInstructionsCommand,
    syncWorkspaceCommand
  );
}

export function deactivate() {
  if (outputChannel) {
    outputChannel.dispose();
  }
}

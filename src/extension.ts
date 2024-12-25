// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { ConfigManager } from "./config";
import { SyncManager } from "./syncManager";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
  const configManager = new ConfigManager(context);
  let syncManager: SyncManager;

  // Initialize sync manager with config
  const updateSyncManager = async () => {
    const config = await configManager.getConfig();
    syncManager = new SyncManager(config);
  };
  await updateSyncManager();

  // Command to set Claude session token
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
        await configManager.saveConfig({ sessionToken: token });
        await updateSyncManager();
        vscode.window.showInformationMessage("Claude session token updated successfully");
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to save token: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  });

  // Command to initialize project
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
        vscode.window.showErrorMessage(result.message);
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to initialize project: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // Command to sync current file
  const syncCurrentFileCommand = vscode.commands.registerCommand("claudesync.syncCurrentFile", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("No active file to sync");
      return;
    }

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
      const result = await syncManager.syncFiles([editor.document.uri]);
      if (result.success) {
        vscode.window.showInformationMessage(result.message);
      } else {
        if (result.message.includes("Project not initialized")) {
          const init = await vscode.window.showErrorMessage(result.message, "Initialize Project");
          if (init) {
            await vscode.commands.executeCommand("claudesync.initProject");
          }
        } else {
          vscode.window.showErrorMessage(result.message);
        }
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to sync file: ${error instanceof Error ? error.message : String(error)}`);
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
        const result = await syncManager.syncFiles(filesToSync);
        if (result.success) {
          vscode.window.showInformationMessage(result.message);
        } else {
          if (result.message.includes("Project not initialized")) {
            const init = await vscode.window.showErrorMessage(result.message, "Initialize Project");
            if (init) {
              await vscode.commands.executeCommand("claudesync.initProject");
            }
          } else {
            vscode.window.showErrorMessage(result.message);
          }
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to sync files: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  context.subscriptions.push(setTokenCommand, initProjectCommand, syncCurrentFileCommand, syncSelectedCommand);
}

// This method is called when your extension is deactivated
export function deactivate() {}

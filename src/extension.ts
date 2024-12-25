// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { ConfigManager } from "./config";
import { SyncManager } from "./syncManager";

let outputChannel: vscode.OutputChannel;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
  // Create output channel
  outputChannel = vscode.window.createOutputChannel("ClaudeSync");
  outputChannel.show();

  const configManager = new ConfigManager(context);
  let syncManager: SyncManager;

  // Initialize sync manager with config
  const updateSyncManager = async () => {
    const config = await configManager.getConfig();
    outputChannel.appendLine(`Config loaded: ${JSON.stringify(config, null, 2)}`);
    syncManager = new SyncManager(config, outputChannel);
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
        outputChannel.appendLine("Saving new session token...");
        await configManager.saveConfig({ sessionToken: token });
        await updateSyncManager();
        vscode.window.showInformationMessage("Claude session token updated successfully");
        outputChannel.appendLine("Session token saved successfully");
      } catch (error) {
        const errorMsg = `Failed to save token: ${error instanceof Error ? error.message : String(error)}`;
        outputChannel.appendLine(`Error: ${errorMsg}`);
        vscode.window.showErrorMessage(errorMsg);
      }
    }
  });

  // Command to initialize project
  const initProjectCommand = vscode.commands.registerCommand("claudesync.initProject", async () => {
    const config = await configManager.getConfig();
    outputChannel.appendLine("Initializing project...");
    outputChannel.appendLine(`Current config: ${JSON.stringify(config, null, 2)}`);

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
        outputChannel.appendLine(`Project initialized successfully: ${result.message}`);
      } else {
        const errorMsg = result.error ? `${result.message}: ${result.error.message}` : result.message;
        outputChannel.appendLine(`Failed to initialize project: ${errorMsg}`);
        vscode.window.showErrorMessage(errorMsg);
      }
    } catch (error) {
      const errorMsg = `Failed to initialize project: ${error instanceof Error ? error.message : String(error)}`;
      outputChannel.appendLine(`Error: ${errorMsg}`);
      if (error instanceof Error && error.stack) {
        outputChannel.appendLine(`Stack trace: ${error.stack}`);
      }
      vscode.window.showErrorMessage(errorMsg);
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
      outputChannel.appendLine(`Syncing file: ${editor.document.fileName}`);
      const result = await syncManager.syncFiles([editor.document.uri]);
      if (result.success) {
        vscode.window.showInformationMessage(result.message);
        outputChannel.appendLine(`File synced successfully: ${result.message}`);
      } else {
        if (result.message.includes("Project not initialized")) {
          const init = await vscode.window.showErrorMessage(result.message, "Initialize Project");
          if (init) {
            await vscode.commands.executeCommand("claudesync.initProject");
          }
        } else {
          const errorMsg = result.error ? `${result.message}: ${result.error.message}` : result.message;
          outputChannel.appendLine(`Failed to sync file: ${errorMsg}`);
          vscode.window.showErrorMessage(errorMsg);
        }
      }
    } catch (error) {
      const errorMsg = `Failed to sync file: ${error instanceof Error ? error.message : String(error)}`;
      outputChannel.appendLine(`Error: ${errorMsg}`);
      if (error instanceof Error && error.stack) {
        outputChannel.appendLine(`Stack trace: ${error.stack}`);
      }
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

  context.subscriptions.push(setTokenCommand, initProjectCommand, syncCurrentFileCommand, syncSelectedCommand);
}

// This method is called when your extension is deactivated
export function deactivate() {
  if (outputChannel) {
    outputChannel.dispose();
  }
}

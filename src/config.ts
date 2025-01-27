import * as vscode from "vscode";
import { GitManager } from "./gitManager";
import { ClaudeSyncConfig, GlobalConfig, WorkspaceConfig } from "./types";

export class ConfigManager {
  private static readonly WORKSPACE_CONFIG_FILE = "claudesync.json";
  private gitManager: GitManager;
  private outputChannel: vscode.OutputChannel;
  private cachedConfig: ClaudeSyncConfig | null = null;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
    this.gitManager = new GitManager(outputChannel);
  }

  public clearCache(): void {
    this.cachedConfig = null;
  }

  public async getConfig(): Promise<ClaudeSyncConfig> {
    if (this.cachedConfig) {
      return this.cachedConfig;
    }
    const globalConfig = this.getGlobalConfig();
    const workspaceConfig = await this.getWorkspaceConfig();
    this.cachedConfig = { ...globalConfig, ...workspaceConfig };
    return this.cachedConfig;
  }

  private getGlobalConfig(): GlobalConfig {
    const config = vscode.workspace.getConfiguration("claudesync");
    return {
      sessionToken: config.get("sessionToken") || "",
      addToGitignore: config.get("addToGitignore") || true,
    };
  }

  public async saveGlobalConfig(config: Partial<GlobalConfig>): Promise<void> {
    const vscodeConfig = vscode.workspace.getConfiguration("claudesync");
    for (const [key, value] of Object.entries(config)) {
      await vscodeConfig.update(key, value, true);
    }
    this.cachedConfig = null;
  }

  public async saveWorkspaceConfig(config: Partial<WorkspaceConfig>): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("No workspace folder found");
    }

    const vscodeDir = vscode.Uri.joinPath(workspaceFolder.uri, ".vscode");
    const configPath = vscode.Uri.joinPath(vscodeDir, ConfigManager.WORKSPACE_CONFIG_FILE);

    try {
      try {
        await vscode.workspace.fs.stat(vscodeDir);
      } catch {
        await vscode.workspace.fs.createDirectory(vscodeDir);
      }

      const currentConfig = await this.getWorkspaceConfig();
      const newConfig = { ...currentConfig, ...config };

      await vscode.workspace.fs.writeFile(configPath, Buffer.from(JSON.stringify(newConfig, null, 2), "utf8"));
      await this.gitManager.ensureGitIgnore();
      this.cachedConfig = null;
    } catch (error) {
      this.outputChannel.appendLine(
        `Failed to save workspace configuration: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  public async clearConfig(): Promise<void> {
    const vscodeConfig = vscode.workspace.getConfiguration("claudesync");
    await vscodeConfig.update("sessionToken", undefined, true);
    this.cachedConfig = null;

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const configPath = vscode.Uri.joinPath(workspaceFolder.uri, ".vscode", ConfigManager.WORKSPACE_CONFIG_FILE);
      try {
        await vscode.workspace.fs.delete(configPath);
      } catch {
        // ignore error if file doesn't exist
      }
    }
  }

  private async getWorkspaceConfig(): Promise<WorkspaceConfig> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return this.getDefaultWorkspaceConfig();
    }

    const configPath = vscode.Uri.joinPath(workspaceFolder.uri, ".vscode", ConfigManager.WORKSPACE_CONFIG_FILE);

    try {
      const configContent = await vscode.workspace.fs.readFile(configPath);
      const config = JSON.parse(Buffer.from(configContent).toString("utf8"));
      return {
        ...this.getDefaultWorkspaceConfig(),
        ...config,
      };
    } catch {
      return this.getDefaultWorkspaceConfig();
    }
  }

  private getDefaultWorkspaceConfig(): WorkspaceConfig {
    const config = vscode.workspace.getConfiguration("claudesync");
    return {
      excludePatterns: config.get("excludePatterns") || [],
      maxFileSize: config.get("maxFileSize") || 2097152, // 2MB
      autoSync: config.get("autoSync") || false,
      autoSyncDelay: config.get("autoSyncInterval") || 30,
      syncOnStartup: config.get("syncOnStartup") || false,
      cleanupRemoteFiles: config.get("cleanupRemoteFiles") || false,
    };
  }
}

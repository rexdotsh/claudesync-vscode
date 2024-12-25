import * as vscode from "vscode";
import { GitManager } from "./gitManager";
import { ClaudeSyncConfig, GlobalConfig, WorkspaceConfig } from "./types";

export class ConfigManager {
  private static readonly GLOBAL_CONFIG_KEY = "claudeSync.global";
  private static readonly WORKSPACE_CONFIG_FILE = "claudesync.json";
  private context: vscode.ExtensionContext;
  private gitManager: GitManager;
  private outputChannel: vscode.OutputChannel;

  constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
    this.context = context;
    this.gitManager = new GitManager(outputChannel);
    this.outputChannel = outputChannel;
  }

  public async getConfig(): Promise<ClaudeSyncConfig> {
    const globalConfig = await this.getGlobalConfig();
    const workspaceConfig = await this.getWorkspaceConfig();
    return { ...globalConfig, ...workspaceConfig };
  }

  public async saveGlobalConfig(config: Partial<GlobalConfig>): Promise<void> {
    const currentConfig = await this.getGlobalConfig();
    const newConfig = { ...currentConfig, ...config };
    await this.context.globalState.update(ConfigManager.GLOBAL_CONFIG_KEY, newConfig);
  }

  public async saveWorkspaceConfig(config: Partial<WorkspaceConfig>): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("No workspace folder found");
    }

    const vscodeDir = vscode.Uri.joinPath(workspaceFolder.uri, ".vscode");
    const configPath = vscode.Uri.joinPath(vscodeDir, ConfigManager.WORKSPACE_CONFIG_FILE);

    try {
      // Create .vscode directory if it doesn't exist
      try {
        await vscode.workspace.fs.stat(vscodeDir);
      } catch {
        this.outputChannel.appendLine("Creating .vscode directory...");
        await vscode.workspace.fs.createDirectory(vscodeDir);
      }

      const currentConfig = await this.getWorkspaceConfig();
      const newConfig = { ...currentConfig, ...config };

      // Write the config file
      this.outputChannel.appendLine(`Saving configuration to ${ConfigManager.WORKSPACE_CONFIG_FILE}...`);
      await vscode.workspace.fs.writeFile(configPath, Buffer.from(JSON.stringify(newConfig, null, 2), "utf8"));

      // Ensure the config file is added to .gitignore
      await this.gitManager.ensureGitIgnore();
    } catch (error) {
      this.outputChannel.appendLine(
        `Failed to save workspace configuration: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  public async clearConfig(): Promise<void> {
    await this.context.globalState.update(ConfigManager.GLOBAL_CONFIG_KEY, undefined);

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const configPath = vscode.Uri.joinPath(workspaceFolder.uri, ".vscode", ConfigManager.WORKSPACE_CONFIG_FILE);
      try {
        await vscode.workspace.fs.delete(configPath);
        this.outputChannel.appendLine("Workspace configuration cleared.");
      } catch {
        // Ignore error if file doesn't exist
        this.outputChannel.appendLine("No workspace configuration file to delete.");
      }
    }
  }

  private async getGlobalConfig(): Promise<GlobalConfig> {
    const config = this.context.globalState.get<GlobalConfig>(ConfigManager.GLOBAL_CONFIG_KEY);
    return config || { sessionToken: "" };
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
    } catch (error) {
      // Return default config if file doesn't exist or can't be read
      this.outputChannel.appendLine("No workspace configuration found, using defaults.");
      return this.getDefaultWorkspaceConfig();
    }
  }

  private getDefaultWorkspaceConfig(): WorkspaceConfig {
    return {
      excludePatterns: this.getDefaultExcludePatterns(),
      maxFileSize: 1024 * 1024, // 1MB default
    };
  }

  private getDefaultExcludePatterns(): string[] {
    return [
      "node_modules/**",
      ".git/**",
      "dist/**",
      "build/**",
      "**/*.pyc",
      "**/__pycache__/**",
      ".env",
      ".env.*",
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "poetry.lock",
      "cargo.lock",
    ];
  }
}

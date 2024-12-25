import * as vscode from "vscode";
import { ClaudeSyncConfig, GlobalConfig, WorkspaceConfig } from "./types";

export class ConfigManager {
  private static readonly GLOBAL_CONFIG_KEY = "claudeSync.global";
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  public async getConfig(): Promise<ClaudeSyncConfig> {
    const globalConfig = await this.getGlobalConfig();
    const workspaceConfig = this.getWorkspaceConfig();
    return { ...globalConfig, ...workspaceConfig };
  }

  public async saveGlobalConfig(config: Partial<GlobalConfig>): Promise<void> {
    const currentConfig = await this.getGlobalConfig();
    const newConfig = { ...currentConfig, ...config };
    await this.context.globalState.update(ConfigManager.GLOBAL_CONFIG_KEY, newConfig);
  }

  public async saveWorkspaceConfig(config: Partial<WorkspaceConfig>): Promise<void> {
    const vsConfig = vscode.workspace.getConfiguration();
    await vsConfig.update(
      "claudesync",
      { ...this.getWorkspaceConfig(), ...config },
      vscode.ConfigurationTarget.Workspace
    );
  }

  public async clearConfig(): Promise<void> {
    await this.context.globalState.update(ConfigManager.GLOBAL_CONFIG_KEY, undefined);
    const vsConfig = vscode.workspace.getConfiguration();
    await vsConfig.update("claudesync", undefined, vscode.ConfigurationTarget.Workspace);
  }

  private async getGlobalConfig(): Promise<GlobalConfig> {
    const config = this.context.globalState.get<GlobalConfig>(ConfigManager.GLOBAL_CONFIG_KEY);
    return config || { sessionToken: "" };
  }

  private getWorkspaceConfig(): WorkspaceConfig {
    const config = vscode.workspace.getConfiguration("claudesync");
    return {
      organizationId: config.get("organizationId"),
      projectId: config.get("projectId"),
      excludePatterns: config.get("excludePatterns") || this.getDefaultExcludePatterns(),
      maxFileSize: config.get("maxFileSize") || 1024 * 1024, // 1MB default
    };
  }

  private getDefaultExcludePatterns(): string[] {
    return ["node_modules/**", ".git/**", "dist/**", "build/**", "**/*.pyc", "**/__pycache__/**", ".env", ".env.*"];
  }
}

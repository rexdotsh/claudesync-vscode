import * as vscode from "vscode";
import { ClaudeSyncConfig } from "./types";

export class ConfigManager {
  private static readonly CONFIG_KEY = "claudeSync";
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  public async getConfig(): Promise<ClaudeSyncConfig> {
    const config = this.context.globalState.get<ClaudeSyncConfig>(ConfigManager.CONFIG_KEY);
    return config || this.getDefaultConfig();
  }

  public async saveConfig(config: Partial<ClaudeSyncConfig>): Promise<void> {
    const currentConfig = await this.getConfig();
    const newConfig = { ...currentConfig, ...config };
    await this.context.globalState.update(ConfigManager.CONFIG_KEY, newConfig);
  }

  public async clearConfig(): Promise<void> {
    await this.context.globalState.update(ConfigManager.CONFIG_KEY, undefined);
  }

  private getDefaultConfig(): ClaudeSyncConfig {
    return {
      sessionToken: "",
      excludePatterns: [
        "node_modules/**",
        ".git/**",
        "dist/**",
        "build/**",
        "**/*.pyc",
        "**/__pycache__/**",
        ".env",
        ".env.*",
      ],
      maxTokens: 100000,
      maxFileSize: 1024 * 1024, // 1MB
    };
  }
}

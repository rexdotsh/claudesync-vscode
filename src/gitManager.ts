import * as vscode from "vscode";

export class GitManager {
  private static readonly GITIGNORE_FILE = ".gitignore";
  private static readonly CLAUDESYNC_IGNORE = ".vscode/claudesync.json";
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  /**
   * Ensures that .vscode/claudesync.json is added to .gitignore if the project is a git repository
   */
  public async ensureGitIgnore(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    // Check if .git directory exists
    const gitDir = vscode.Uri.joinPath(workspaceFolder.uri, ".git");
    try {
      await vscode.workspace.fs.stat(gitDir);
    } catch {
      // Not a git repository, skip
      this.outputChannel.appendLine("Not a git repository, skipping .gitignore update.");
      return;
    }

    const gitignorePath = vscode.Uri.joinPath(workspaceFolder.uri, GitManager.GITIGNORE_FILE);
    let currentContent = "";

    try {
      const fileContent = await vscode.workspace.fs.readFile(gitignorePath);
      currentContent = Buffer.from(fileContent).toString("utf8");

      if (this.hasClaudeSyncIgnore(currentContent)) {
        this.outputChannel.appendLine("Configuration file already in .gitignore.");
        return;
      }
    } catch {
      // .gitignore doesn't exist, we'll create it
      this.outputChannel.appendLine("Creating new .gitignore file.");
    }

    const newContent = this.addClaudeSyncIgnore(currentContent);
    await vscode.workspace.fs.writeFile(gitignorePath, Buffer.from(newContent, "utf8"));
    this.outputChannel.appendLine("Added configuration file to .gitignore.");
  }

  private hasClaudeSyncIgnore(content: string): boolean {
    const lines = content.split(/\r?\n/);
    return lines.some((line) => line.trim() === GitManager.CLAUDESYNC_IGNORE);
  }

  private addClaudeSyncIgnore(content: string): string {
    // ensure content ends with newline
    const normalizedContent = content.endsWith("\n") ? content : content + "\n";
    return normalizedContent + "\n" + GitManager.CLAUDESYNC_IGNORE + "\n";
  }
}

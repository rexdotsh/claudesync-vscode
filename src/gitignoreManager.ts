import ignore from "ignore";
import * as vscode from "vscode";

export class GitignoreManager {
  private ig: ReturnType<typeof ignore> | null = null;
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  public shouldIgnore(filePath: string): boolean {
    if (!this.ig) {
      return false;
    }
    return this.ig.ignores(filePath);
  }

  public async loadGitignore(workspaceFolder: vscode.Uri): Promise<void> {
    try {
      const gitignorePath = vscode.Uri.joinPath(workspaceFolder, ".gitignore");
      const content = await vscode.workspace.fs.readFile(gitignorePath);
      const gitignoreContent = Buffer.from(content).toString("utf8");
      this.loadFromContent(gitignoreContent);
    } catch (error) {
      this.outputChannel.appendLine("No .gitignore file found or failed to read it");
      this.ig = null;
    }
  }

  public loadFromContent(content: string): void {
    try {
      this.ig = ignore().add(content);
      this.outputChannel.appendLine("Successfully loaded gitignore patterns");
    } catch (error) {
      this.outputChannel.appendLine("Failed to parse gitignore content");
      this.ig = null;
    }
  }
}

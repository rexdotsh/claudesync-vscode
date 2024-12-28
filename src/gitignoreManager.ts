import * as vscode from "vscode";

export class GitignoreManager {
  private patterns: { pattern: string; isDirectory: boolean }[] = [];
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  // Static utility methods that can be used by other classes
  public static convertGlobToRegex(pattern: string): string {
    return pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape special regex chars
      .replace(/\*\*/g, ".*") // ** matches anything including /
      .replace(/\*/g, "[^/]*") // * matches anything except /
      .replace(/\?/g, "[^/]"); // ? matches any single non-/ char
  }

  public static normalizePath(path: string): string {
    return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  }

  public static isMatch(pattern: string, filePath: string, isDirectory = false): boolean {
    pattern = this.normalizePath(pattern);
    filePath = this.normalizePath(filePath);

    // For directory patterns without a slash, match anywhere in the path
    if (isDirectory && !pattern.includes("/")) {
      const dirName = pattern.replace(/\/$/, "");
      return new RegExp(`(^|/)${this.convertGlobToRegex(dirName)}(/|$)`).test(filePath);
    }

    // For file patterns without a slash, match the basename
    if (!isDirectory && !pattern.includes("/")) {
      const basename = filePath.split("/").pop() || "";
      return new RegExp(`^${this.convertGlobToRegex(pattern)}$`).test(basename);
    }

    // For patterns with slashes, match the full path
    const regexPattern = this.convertGlobToRegex(pattern);
    if (isDirectory || pattern.endsWith("/**")) {
      return new RegExp(`^${regexPattern}(/.*)?$`).test(filePath);
    }
    return new RegExp(`^${regexPattern}$`).test(filePath);
  }

  public async loadGitignore(workspaceFolder: vscode.Uri): Promise<void> {
    try {
      const gitignorePath = vscode.Uri.joinPath(workspaceFolder, ".gitignore");
      const content = await vscode.workspace.fs.readFile(gitignorePath);
      const gitignoreContent = Buffer.from(content).toString("utf8");

      this.patterns = gitignoreContent
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((pattern) => {
          pattern = GitignoreManager.normalizePath(pattern);
          const isDirectory = !pattern.includes(".") || pattern.endsWith("/");
          return { pattern, isDirectory };
        });

      const formattedPatterns = this.patterns.map((p) => {
        if (p.isDirectory && !p.pattern.includes("/")) {
          return `**/${p.pattern}/**`;
        }
        return p.pattern;
      });

      this.outputChannel.appendLine(`Loaded ${this.patterns.length} patterns from .gitignore`);
      this.outputChannel.appendLine(`Patterns: ${formattedPatterns.join(", ")}`);
    } catch (error) {
      this.outputChannel.appendLine("No .gitignore file found or failed to read it");
      this.patterns = [];
    }
  }

  public shouldIgnore(filePath: string): boolean {
    let shouldIgnore = false;

    // process patterns in order, with negations overriding previous matches
    for (const { pattern, isDirectory } of this.patterns) {
      if (pattern.startsWith("!")) {
        // if a negated pattern matches, the file should NOT be ignored
        if (GitignoreManager.isMatch(pattern.slice(1), filePath, isDirectory)) {
          shouldIgnore = false;
        }
      } else if (GitignoreManager.isMatch(pattern, filePath, isDirectory)) {
        shouldIgnore = true;
      }
    }

    return shouldIgnore;
  }
}

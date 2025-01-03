import * as vscode from "vscode";
import { ClaudeClient, Organization, Project } from "./claude/client";
import { ConfigManager } from "./config";
import { GitignoreManager } from "./gitignoreManager";
import { ClaudeSyncConfig, FileContent, SyncResult } from "./types";
import { computeSHA256Hash } from "./utils";

export class SyncManager {
  private config: ClaudeSyncConfig;
  private claudeClient: ClaudeClient;
  private currentOrg?: Organization;
  private currentProject?: Project;
  private outputChannel: vscode.OutputChannel;
  private configManager: ConfigManager;
  private gitignoreManager: GitignoreManager;

  private readonly MAX_RETRIES = 10;
  private readonly RETRY_DELAY = 1000; // 1s

  constructor(config: ClaudeSyncConfig, outputChannel: vscode.OutputChannel, configManager: ConfigManager) {
    this.config = config;
    this.outputChannel = outputChannel;
    this.claudeClient = new ClaudeClient(config);
    this.configManager = configManager;
    this.gitignoreManager = new GitignoreManager(outputChannel);
  }

  public async isProjectInitialized(): Promise<boolean> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return false;
    }

    try {
      const vscodeDir = vscode.Uri.joinPath(workspaceFolder.uri, ".vscode");
      const configPath = vscode.Uri.joinPath(vscodeDir, "claudesync.json");
      await vscode.workspace.fs.stat(configPath);
      return true;
    } catch {
      return false;
    }
  }

  private async handleError<T>(operation: string, action: () => Promise<T>): Promise<SyncResult> {
    try {
      const result = await action();
      if (typeof result === "object" && result !== null && "success" in result) {
        return result as SyncResult;
      }
      return { success: true, data: { syncedFiles: 0 } };
    } catch (error) {
      this.outputChannel.appendLine(`Error in ${operation}: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Error && error.stack) {
        this.outputChannel.appendLine(`Stack trace: ${error.stack}`);
      }
      return {
        success: false,
        message: `Failed to ${operation}`,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  private async ensureProjectAndOrg(): Promise<SyncResult> {
    if (this.currentOrg && this.currentProject) {
      return { success: true, message: "Organization and project already loaded" };
    }

    this.outputChannel.appendLine("Loading organization and project from config...");
    const config = await this.configManager.getConfig();
    const orgId = config.organizationId;
    const projectId = config.projectId;

    if (!orgId || !projectId) {
      return {
        success: false,
        message: "Project not initialized. Please run 'Initialize Project' first",
      };
    }

    const orgs = await this.claudeClient.getOrganizations();
    this.currentOrg = orgs.find((o) => o.id === orgId);

    if (!this.currentOrg) {
      return {
        success: false,
        message: "Organization not found. Please reinitialize the project",
      };
    }

    const projects = await this.claudeClient.getProjects(this.currentOrg.id);
    this.currentProject = projects.find((p) => p.id === projectId);

    if (!this.currentProject) {
      return {
        success: false,
        message: "Project not found. Please reinitialize the project",
      };
    }

    this.outputChannel.appendLine(
      `Loaded organization: ${this.currentOrg.name} and project: ${this.currentProject.name}`
    );
    return { success: true, message: "Successfully loaded organization and project" };
  }

  private async updateProjectInstructions(): Promise<SyncResult> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return { success: false, message: "No workspace folder found" };
    }

    try {
      const instructionsUri = vscode.Uri.joinPath(workspaceFolder.uri, ".projectinstructions");
      const instructionsContent = await vscode.workspace.fs.readFile(instructionsUri);
      const instructions = new TextDecoder().decode(instructionsContent);

      await this.claudeClient.updateProjectPromptTemplate(this.currentOrg!.id, this.currentProject!.id, instructions);
      this.outputChannel.appendLine("Updated project prompt template from .projectinstructions file");
      return { success: true, message: "Successfully updated project instructions" };
    } catch (error) {
      this.outputChannel.appendLine("No .projectinstructions file found or failed to read it");
      return { success: true, message: "No project instructions to update" };
    }
  }

  public async initializeProject(): Promise<SyncResult> {
    return this.handleError("initialize project", async () => {
      let retryCount = 0;

      return vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Initializing Project",
          cancellable: false,
        },
        async (progress) => {
          while (retryCount < this.MAX_RETRIES) {
            try {
              progress.report({ message: "Processing..." });
              const orgs = await this.claudeClient.getOrganizations();
              if (!orgs.length) {
                return {
                  success: false,
                  message: "No organizations found. Please make sure you have access to Claude",
                };
              }

              progress.report({ message: "Selecting organization..." });
              this.currentOrg = orgs.length === 1 ? orgs[0] : await this.selectOrganization(orgs);
              if (!this.currentOrg) {
                return { success: false, message: "No organization selected" };
              }

              const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
              if (!workspaceFolder) {
                return { success: false, message: "No workspace folder found" };
              }

              const projectName = workspaceFolder.name;
              progress.report({ message: "Getting projects..." });
              const projects = await this.claudeClient.getProjects(this.currentOrg.id);
              this.currentProject = projects.find((p) => p.name === projectName);

              let successMessage: string;
              if (!this.currentProject) {
                progress.report({ message: "Creating new project..." });
                this.currentProject = await this.claudeClient.createProject(
                  this.currentOrg.id,
                  projectName,
                  "Created by ClaudeSync from VSCode"
                );
                successMessage = `Project '${projectName}' has been successfully created with Claude!`;
              } else {
                successMessage = `Project '${projectName}' already exists.`;
              }

              progress.report({ message: "Updating project instructions..." });
              await this.updateProjectInstructions();

              progress.report({ message: "Saving configuration..." });
              await this.configManager.saveWorkspaceConfig({
                organizationId: this.currentOrg.id,
                projectId: this.currentProject.id,
              });

              return {
                success: true,
                message: successMessage,
              };
            } catch (error) {
              retryCount++;
              if (retryCount === this.MAX_RETRIES) {
                throw error;
              }

              progress.report({
                message: `Attempt ${retryCount} failed. Retrying in ${this.RETRY_DELAY / 1000}s...`,
              });

              await new Promise((resolve) => setTimeout(resolve, this.RETRY_DELAY));
              progress.report({ message: "Initializing..." });
            }
          }

          return {
            success: false,
            message: "Failed to initialize project after maximum retries",
          };
        }
      );
    });
  }

  public async syncFiles(files: vscode.Uri[]): Promise<SyncResult> {
    return this.handleError("sync files", async () => {
      const projectResult = await this.ensureProjectAndOrg();
      if (!projectResult.success) {
        return projectResult;
      }

      // load gitignore patterns if workspace folder exists
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        await this.gitignoreManager.loadGitignore(workspaceFolder.uri);
      }

      this.outputChannel.appendLine("Preparing files for sync...");
      const fileContents = await this.prepareFiles(files);
      if (!fileContents.length) {
        return { success: false, message: "No valid files to sync" };
      }
      this.outputChannel.appendLine(`Prepared ${fileContents.length} files for sync`);

      const existingFiles = await this.claudeClient.listFiles(this.currentOrg!.id, this.currentProject!.id);
      let skipped = 0;
      let synced = 0;
      let deleted = 0;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Uploading to Claude",
          cancellable: true,
        },
        async (progress, token) => {
          const total = fileContents.length;
          let current = 0;

          // First, sync all local files
          for (const file of fileContents) {
            if (token.isCancellationRequested) {
              this.outputChannel.appendLine("Upload cancelled by user");
              return;
            }

            progress.report({
              message: `${++current}/${total}: ${file.path}`,
              increment: (1 / total) * 100,
            });

            this.outputChannel.appendLine(`Processing file: ${file.path}`);
            const existingFile = existingFiles.find((f) => f.file_name === file.path);

            if (existingFile) {
              const [remoteHash, localHash] = await Promise.all([
                computeSHA256Hash(existingFile.content),
                computeSHA256Hash(file.content),
              ]);

              if (remoteHash === localHash) {
                skipped++;
                continue;
              }

              await this.claudeClient.deleteFile(this.currentOrg!.id, this.currentProject!.id, existingFile.uuid);
            }

            await this.claudeClient.uploadFile(this.currentOrg!.id, this.currentProject!.id, file.path, file.content);
            synced++;
          }

          // Then, if cleanupRemoteFiles is enabled, remove any remote files that don't exist locally
          if (this.config.cleanupRemoteFiles && !token.isCancellationRequested) {
            progress.report({ message: "Cleaning up remote files..." });

            const localFilePaths = new Set(fileContents.map((f) => f.path));
            const filesToDelete = existingFiles.filter((f) => !localFilePaths.has(f.file_name));

            if (filesToDelete.length > 0) {
              this.outputChannel.appendLine(
                `Found ${filesToDelete.length} remote files to delete: ${filesToDelete
                  .map((f) => f.file_name)
                  .join(", ")}`
              );

              for (const file of filesToDelete) {
                try {
                  await this.claudeClient.deleteFile(this.currentOrg!.id, this.currentProject!.id, file.uuid);
                  deleted++;
                } catch (error) {
                  this.outputChannel.appendLine(
                    `Failed to delete ${file.file_name}: ${error instanceof Error ? error.message : String(error)}`
                  );
                }
              }

              if (deleted > 0) {
                this.outputChannel.appendLine(`Successfully deleted ${deleted} remote files`);
              }
            }
          }

          if (skipped > 0) {
            this.outputChannel.appendLine(`Skipped ${skipped} unchanged files`);
          }
        }
      );

      return {
        success: true,
        message: `Successfully synced ${fileContents.length} file${fileContents.length === 1 ? "" : "s"} with Claude${
          skipped > 0 ? ` (${skipped} unchanged file${skipped === 1 ? "" : "s"} skipped)` : ""
        }${deleted > 0 ? ` and removed ${deleted} remote file${deleted === 1 ? "" : "s"}` : ""}`,
        data: {
          syncedFiles: synced,
          skippedFiles: skipped,
          deletedFiles: deleted,
          totalFiles: fileContents.length,
        },
      };
    });
  }

  public async syncProjectInstructions(): Promise<SyncResult> {
    return this.handleError("sync project instructions", async () => {
      const projectResult = await this.ensureProjectAndOrg();
      if (!projectResult.success) {
        return projectResult;
      }

      const result = await this.updateProjectInstructions();
      return result.success
        ? { success: true, message: "Project instructions have been successfully updated in Claude" }
        : { success: false, message: "No .projectinstructions file found or failed to read it" };
    });
  }

  private async selectOrganization(orgs: Organization[]): Promise<Organization | undefined> {
    const selected = await vscode.window.showQuickPick(
      orgs.map((org) => ({
        label: org.name,
        description: org.id,
        org,
      })),
      { placeHolder: "Select an organization" }
    );
    return selected?.org;
  }

  private isBinaryContent(content: Uint8Array): boolean {
    // check for null bytes which are common in binary files
    let nullCount = 0;
    let nonPrintableCount = 0;
    const sampleSize = Math.min(content.length, 1024); // sample only the first 1KB

    for (let i = 0; i < sampleSize; i++) {
      if (content[i] === 0) {
        nullCount++;
      }
      // check for non-printable characters (except common whitespace)
      if ((content[i] < 32 && ![9, 10, 13].includes(content[i])) || content[i] === 127) {
        nonPrintableCount++;
      }
    }

    // if we find any null bytes, consider it binary
    if (nullCount > 0) {
      return true;
    }

    // if more than 30% of the content is non-printable, consider it binary
    return nonPrintableCount / sampleSize > 0.3;
  }

  private async prepareFiles(files: vscode.Uri[]): Promise<FileContent[]> {
    const result: FileContent[] = [];
    const binaryFiles = new Set<string>();

    for (const file of files) {
      try {
        const relativePath = vscode.workspace.asRelativePath(file);

        // skip excluded files
        if (
          this.config.excludePatterns.some((pattern) => GitignoreManager.isMatch(pattern, relativePath, true)) ||
          this.gitignoreManager.shouldIgnore(relativePath)
        ) {
          continue;
        }

        const content = await vscode.workspace.fs.readFile(file);

        // skip binary or large files
        if (content.byteLength > this.config.maxFileSize) {
          continue;
        }

        if (this.isBinaryContent(content)) {
          binaryFiles.add(relativePath);
          continue;
        }

        result.push({
          path: relativePath,
          content: new TextDecoder().decode(content),
          size: content.byteLength,
        });
      } catch {
        continue;
      }
    }

    if (binaryFiles.size > 0) {
      const updatedPatterns = [...new Set([...this.config.excludePatterns, ...binaryFiles])];
      await this.configManager.saveWorkspaceConfig({ excludePatterns: updatedPatterns });
      this.config = await this.configManager.getConfig();
      this.outputChannel.appendLine(
        `Added ${binaryFiles.size} binary file(s) to exclude patterns: ${[...binaryFiles].join(", ")}`
      );
    }

    return result;
  }

  public shouldExcludeFile(filePath: string): boolean {
    const isExcludedByConfig = this.config.excludePatterns.some((pattern) => {
      return GitignoreManager.isMatch(pattern, filePath, true);
    });

    if (isExcludedByConfig) {
      return true;
    }

    // check gitignore patterns
    return this.gitignoreManager.shouldIgnore(filePath);
  }
}

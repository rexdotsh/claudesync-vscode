import * as vscode from "vscode";
import { ClaudeClient, Organization, Project } from "./claude/client";
import { ClaudeSyncConfig, FileContent, SyncResult } from "./types";
import { computeSHA256Hash } from "./utils";

export class SyncManager {
  private config: ClaudeSyncConfig;
  private claudeClient: ClaudeClient;
  private currentOrg?: Organization;
  private currentProject?: Project;
  private outputChannel: vscode.OutputChannel;

  constructor(config: ClaudeSyncConfig, outputChannel: vscode.OutputChannel) {
    this.config = config;
    this.outputChannel = outputChannel;
    this.claudeClient = new ClaudeClient(config);
  }

  public async initializeProject(): Promise<SyncResult> {
    try {
      // get organizations
      const orgs = await this.claudeClient.getOrganizations();

      if (!orgs.length) {
        return {
          success: false,
          message: "No organizations found. Please make sure you have access to Claude AI",
        };
      }

      // let user select organization if multiple
      this.currentOrg = orgs.length === 1 ? orgs[0] : await this.selectOrganization(orgs);
      if (!this.currentOrg) {
        return {
          success: false,
          message: "No organization selected",
        };
      }

      // get workspace name for project
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return {
          success: false,
          message: "No workspace folder found",
        };
      }

      const projectName = workspaceFolder.name;

      // Create or select project
      const projects = await this.claudeClient.getProjects(this.currentOrg.id);
      this.currentProject = projects.find((p) => p.name === projectName);

      if (!this.currentProject) {
        this.currentProject = await this.claudeClient.createProject(
          this.currentOrg.id,
          projectName,
          "Created by ClaudeSync VSCode Extension"
        );
      }

      try {
        const instructionsUri = vscode.Uri.joinPath(workspaceFolder.uri, ".projectinstructions");
        const instructionsContent = await vscode.workspace.fs.readFile(instructionsUri);
        const instructions = new TextDecoder().decode(instructionsContent);

        // update project's prompt template
        await this.claudeClient.updateProjectPromptTemplate(this.currentOrg.id, this.currentProject.id, instructions);
        this.outputChannel.appendLine("Updated project prompt template from .projectinstructions file");
      } catch (error) {
        // don't fail if .projectinstructions doesn't exist
        this.outputChannel.appendLine("No .projectinstructions file found or failed to read it");
      }

      // save project info in config
      const config = vscode.workspace.getConfiguration();
      await config.update(
        "claudesync",
        {
          organizationId: this.currentOrg.id,
          projectId: this.currentProject.id,
          sessionToken: this.config.sessionToken,
          excludePatterns: this.config.excludePatterns,
          maxFileSize: this.config.maxFileSize,
        },
        vscode.ConfigurationTarget.Workspace
      );

      return {
        success: true,
        message: `Project '${projectName}' initialized with Claude!`,
      };
    } catch (error) {
      this.outputChannel.appendLine(
        `Error in initializeProject: ${error instanceof Error ? error.message : String(error)}`
      );
      if (error instanceof Error && error.stack) {
        this.outputChannel.appendLine(`Stack trace: ${error.stack}`);
      }
      return {
        success: false,
        message: "Failed to initialize project",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  public async syncFiles(files: vscode.Uri[]): Promise<SyncResult> {
    try {
      if (!this.currentOrg || !this.currentProject) {
        this.outputChannel.appendLine("Loading organization and project from config...");
        const config = vscode.workspace.getConfiguration("claudesync");
        const orgId = config.get<string>("organizationId");
        const projectId = config.get<string>("projectId");

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
      }

      // prepare files
      this.outputChannel.appendLine("Preparing files for sync...");
      const fileContents = await this.prepareFiles(files);
      if (!fileContents.length) {
        return {
          success: false,
          message: "No valid files to sync",
        };
      }
      this.outputChannel.appendLine(`Prepared ${fileContents.length} files for sync`);

      // get existing files to determine what to update/create
      const existingFiles = await this.claudeClient.listFiles(this.currentOrg.id, this.currentProject.id);

      // upload/update files
      const progress = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Syncing files with Claude AI",
          cancellable: false,
        },
        async (progress) => {
          const total = fileContents.length;
          let current = 0;
          let skipped = 0;

          for (const file of fileContents) {
            progress.report({
              message: `Syncing ${file.path} (${++current}/${total})`,
              increment: (1 / total) * 100,
            });

            this.outputChannel.appendLine(`Processing file: ${file.path}`);
            const existingFile = existingFiles.find((f) => f.file_name === file.path);

            if (existingFile) {
              // Compute hash of existing file content
              const remoteHash = await computeSHA256Hash(existingFile.content);
              const localHash = await computeSHA256Hash(file.content);

              // Only update if content has changed
              if (localHash === remoteHash) {
                skipped++;
                continue;
              }

              await this.claudeClient.deleteFile(this.currentOrg!.id, this.currentProject!.id, existingFile.uuid);
            }

            await this.claudeClient.uploadFile(this.currentOrg!.id, this.currentProject!.id, file.path, file.content);
          }

          if (skipped > 0) {
            this.outputChannel.appendLine(`Skipped ${skipped} unchanged files`);
          }
        }
      );

      return {
        success: true,
        message: `Successfully synced ${fileContents.length} files`,
      };
    } catch (error) {
      this.outputChannel.appendLine(`Error in syncFiles: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Error && error.stack) {
        this.outputChannel.appendLine(`Stack trace: ${error.stack}`);
      }
      return {
        success: false,
        message: "Failed to sync files",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  private async selectOrganization(orgs: Organization[]): Promise<Organization | undefined> {
    const selected = await vscode.window.showQuickPick(
      orgs.map((org) => ({
        label: org.name,
        description: org.id,
        org,
      })),
      {
        placeHolder: "Select an organization",
      }
    );
    return selected?.org;
  }

  private async prepareFiles(files: vscode.Uri[]): Promise<FileContent[]> {
    const result: FileContent[] = [];

    for (const file of files) {
      try {
        const content = await vscode.workspace.fs.readFile(file);
        const textContent = new TextDecoder().decode(content);

        // skip if file is too large
        if (content.byteLength > this.config.maxFileSize) {
          vscode.window.showWarningMessage(`Skipping ${file.fsPath}: File too large`);
          continue;
        }

        // skip if file should be excluded
        const relativePath = vscode.workspace.asRelativePath(file);
        if (this.shouldExcludeFile(relativePath)) {
          continue;
        }

        result.push({
          path: relativePath,
          content: textContent,
          size: content.byteLength,
        });
      } catch (error) {
        const errorMsg = `Failed to read ${file.fsPath}: ${error}`;
        vscode.window.showErrorMessage(errorMsg);
      }
    }

    return result;
  }

  private shouldExcludeFile(filePath: string): boolean {
    return this.config.excludePatterns.some((pattern) => {
      const regexPattern = pattern.replace(/\./g, "\\.").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
      return new RegExp(`^${regexPattern}$`).test(filePath);
    });
  }

  public async syncProjectInstructions(): Promise<SyncResult> {
    try {
      if (!this.currentOrg || !this.currentProject) {
        this.outputChannel.appendLine("Loading organization and project from config...");
        const config = vscode.workspace.getConfiguration("claudesync");
        const orgId = config.get<string>("organizationId");
        const projectId = config.get<string>("projectId");

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
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return {
          success: false,
          message: "No workspace folder found",
        };
      }

      try {
        const instructionsUri = vscode.Uri.joinPath(workspaceFolder.uri, ".projectinstructions");
        const instructionsContent = await vscode.workspace.fs.readFile(instructionsUri);
        const instructions = new TextDecoder().decode(instructionsContent);

        // update project's prompt template
        await this.claudeClient.updateProjectPromptTemplate(this.currentOrg.id, this.currentProject.id, instructions);

        return {
          success: true,
          message: "Successfully updated project instructions from .projectinstructions file",
        };
      } catch (error) {
        return {
          success: false,
          message: "No .projectinstructions file found or failed to read it",
        };
      }
    } catch (error) {
      this.outputChannel.appendLine(
        `Error in syncProjectInstructions: ${error instanceof Error ? error.message : String(error)}`
      );
      if (error instanceof Error && error.stack) {
        this.outputChannel.appendLine(`Stack trace: ${error.stack}`);
      }
      return {
        success: false,
        message: "Failed to sync project instructions",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}

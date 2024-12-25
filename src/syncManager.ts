import * as vscode from "vscode";
import { ClaudeClient, Organization, Project } from "./claude/client";
import { CompressionUtils } from "./compression";
import { ClaudeSyncConfig, FileContent, SyncResult } from "./types";

export class SyncManager {
  private config: ClaudeSyncConfig;
  private claudeClient: ClaudeClient;
  private currentOrg?: Organization;
  private currentProject?: Project;

  constructor(config: ClaudeSyncConfig) {
    this.config = config;
    this.claudeClient = new ClaudeClient(config);
  }

  public async initializeProject(): Promise<SyncResult> {
    try {
      // Get organizations
      const orgs = await this.claudeClient.getOrganizations();
      if (!orgs.length) {
        return {
          success: false,
          message: "No organizations found. Please make sure you have access to Claude AI",
        };
      }

      // Let user select organization if multiple
      this.currentOrg = orgs.length === 1 ? orgs[0] : await this.selectOrganization(orgs);
      if (!this.currentOrg) {
        return {
          success: false,
          message: "No organization selected",
        };
      }

      // Get workspace name for project
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

      // Save project info in config
      await vscode.workspace.getConfiguration().update(
        "claudesync",
        {
          organizationId: this.currentOrg.id,
          projectId: this.currentProject.id,
        },
        vscode.ConfigurationTarget.Workspace
      );

      return {
        success: true,
        message: `Project '${projectName}' initialized with Claude AI`,
      };
    } catch (error) {
      return {
        success: false,
        message: "Failed to initialize project",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  public async syncFiles(files: vscode.Uri[]): Promise<SyncResult> {
    try {
      // Load org and project from config if not set
      if (!this.currentOrg || !this.currentProject) {
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

      // Prepare files
      const fileContents = await this.prepareFiles(files);
      if (!fileContents.length) {
        return {
          success: false,
          message: "No valid files to sync",
        };
      }

      // Get existing files to determine what to update/create
      const existingFiles = await this.claudeClient.listFiles(this.currentOrg.id, this.currentProject.id);

      // Upload/update files
      const progress = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Syncing files with Claude AI",
          cancellable: false,
        },
        async (progress) => {
          const total = fileContents.length;
          let current = 0;

          for (const file of fileContents) {
            progress.report({
              message: `Syncing ${file.path} (${++current}/${total})`,
              increment: (1 / total) * 100,
            });

            const existingFile = existingFiles.find((f) => f.file_name === file.path);
            const compressed = await CompressionUtils.compressContent(file.content);

            if (existingFile) {
              // Delete and recreate to update
              await this.claudeClient.deleteFile(this.currentOrg!.id, this.currentProject!.id, existingFile.uuid);
            }

            await this.claudeClient.uploadFile(
              this.currentOrg!.id,
              this.currentProject!.id,
              file.path,
              compressed.content
            );
          }
        }
      );

      return {
        success: true,
        message: `Successfully synced ${fileContents.length} files`,
      };
    } catch (error) {
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

        // Skip if file is too large
        if (content.byteLength > this.config.maxFileSize) {
          vscode.window.showWarningMessage(`Skipping ${file.fsPath}: File too large`);
          continue;
        }

        // Skip if file should be excluded
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
        vscode.window.showErrorMessage(`Failed to read ${file.fsPath}: ${error}`);
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
}

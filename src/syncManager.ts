import * as vscode from "vscode";
import { ClaudeClient, Organization, Project } from "./claude/client";
import { ClaudeSyncConfig, FileContent, SyncResult } from "./types";

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
    this.outputChannel.appendLine("SyncManager initialized");
  }

  public async initializeProject(): Promise<SyncResult> {
    try {
      this.outputChannel.appendLine("Getting organizations...");
      // Get organizations
      const orgs = await this.claudeClient.getOrganizations();
      this.outputChannel.appendLine(`Found ${orgs.length} organizations`);

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
      this.outputChannel.appendLine(`Selected organization: ${this.currentOrg.name} (${this.currentOrg.id})`);

      // Get workspace name for project
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return {
          success: false,
          message: "No workspace folder found",
        };
      }

      const projectName = workspaceFolder.name;
      this.outputChannel.appendLine(`Using project name: ${projectName}`);

      // Create or select project
      this.outputChannel.appendLine("Getting projects...");
      const projects = await this.claudeClient.getProjects(this.currentOrg.id);
      this.outputChannel.appendLine(`Found ${projects.length} projects`);

      this.currentProject = projects.find((p) => p.name === projectName);

      if (!this.currentProject) {
        this.outputChannel.appendLine(`Creating new project: ${projectName}`);
        this.currentProject = await this.claudeClient.createProject(
          this.currentOrg.id,
          projectName,
          "Created by ClaudeSync VSCode Extension"
        );
        this.outputChannel.appendLine(`Project created with ID: ${this.currentProject.id}`);
      } else {
        this.outputChannel.appendLine(`Using existing project with ID: ${this.currentProject.id}`);
      }

      // Save project info in config
      this.outputChannel.appendLine("Saving project configuration...");
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
        message: `Project '${projectName}' initialized with Claude AI`,
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
      // Load org and project from config if not set
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

      // Prepare files
      this.outputChannel.appendLine("Preparing files for sync...");
      const fileContents = await this.prepareFiles(files);
      if (!fileContents.length) {
        return {
          success: false,
          message: "No valid files to sync",
        };
      }
      this.outputChannel.appendLine(`Prepared ${fileContents.length} files for sync`);

      // Get existing files to determine what to update/create
      this.outputChannel.appendLine("Getting existing files...");
      const existingFiles = await this.claudeClient.listFiles(this.currentOrg.id, this.currentProject.id);
      this.outputChannel.appendLine(`Found ${existingFiles.length} existing files`);

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

            this.outputChannel.appendLine(`Processing file: ${file.path}`);
            const existingFile = existingFiles.find((f) => f.file_name === file.path);

            if (existingFile) {
              this.outputChannel.appendLine(`Deleting existing file: ${existingFile.uuid}`);
              await this.claudeClient.deleteFile(this.currentOrg!.id, this.currentProject!.id, existingFile.uuid);
            }

            this.outputChannel.appendLine(`Uploading file: ${file.path}`);
            await this.claudeClient.uploadFile(this.currentOrg!.id, this.currentProject!.id, file.path, file.content);
            this.outputChannel.appendLine(`File uploaded successfully: ${file.path}`);
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
    this.outputChannel.appendLine("Showing organization selection dialog...");
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
    if (selected) {
      this.outputChannel.appendLine(`Selected organization: ${selected.org.name} (${selected.org.id})`);
    }
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
          this.outputChannel.appendLine(`Skipping ${file.fsPath}: File too large (${content.byteLength} bytes)`);
          vscode.window.showWarningMessage(`Skipping ${file.fsPath}: File too large`);
          continue;
        }

        // Skip if file should be excluded
        const relativePath = vscode.workspace.asRelativePath(file);
        if (this.shouldExcludeFile(relativePath)) {
          this.outputChannel.appendLine(`Skipping ${relativePath}: Matches exclude pattern`);
          continue;
        }

        result.push({
          path: relativePath,
          content: textContent,
          size: content.byteLength,
        });
        this.outputChannel.appendLine(`Added file for sync: ${relativePath} (${content.byteLength} bytes)`);
      } catch (error) {
        const errorMsg = `Failed to read ${file.fsPath}: ${error}`;
        this.outputChannel.appendLine(`Error: ${errorMsg}`);
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
}

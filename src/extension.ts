import * as vscode from 'vscode';
import { ConfigManager } from './config';
import { GitManager } from './gitManager';
import { SyncManager } from './syncManager';
import type { SyncResult } from './types';

let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('ClaudeSync');

  const configManager = new ConfigManager(outputChannel);
  let syncManager: SyncManager;
  let fileWatcher: vscode.FileSystemWatcher | undefined;

  // function to handle file changes for autosync
  let autoSyncTimer: NodeJS.Timeout | undefined;
  const handleFileChange = async (uri: vscode.Uri) => {
    const config = await configManager.getConfig();
    if (!config.autoSync || !config.sessionToken) {
      return;
    }

    // don't sync if file is in excluded patterns
    const relativePath = vscode.workspace.asRelativePath(uri);
    const excludePatterns = config.excludePatterns || [];
    if (
      excludePatterns.some((pattern) => {
        // convert glob pattern to regex
        const regexPattern = pattern
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '.');
        return new RegExp(`^${regexPattern}$`).test(relativePath);
      })
    ) {
      return;
    }

    // clear existing timer
    if (autoSyncTimer) {
      clearTimeout(autoSyncTimer);
    }

    // start auto-sync after delay
    autoSyncTimer = setTimeout(async () => {
      try {
        await syncFiles([uri]);
      } catch (error) {
        outputChannel.appendLine(
          `Auto-sync failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }, config.autoSyncDelay * 1000);
  };

  const setupFileWatcher = async () => {
    // Cleanup existing watcher if any
    if (fileWatcher) {
      fileWatcher.dispose();
      fileWatcher = undefined;
    }

    const isInitialized = await syncManager?.isProjectInitialized();
    const config = await configManager.getConfig();

    // only setup watcher if project is initialized, has a token, and auto-sync is enabled
    if (isInitialized && config.sessionToken && config.autoSync) {
      // create watcher that ignores the config file and other excluded patterns
      const excludePattern = `{**/.vscode/claudesync.json,${config.excludePatterns.join(',')}}`;
      fileWatcher = vscode.workspace.createFileSystemWatcher(
        `**/*`,
        false,
        false,
        true,
      );
      fileWatcher.onDidChange(handleFileChange);
      fileWatcher.onDidCreate(handleFileChange);

      // add to disposables
      context.subscriptions.push(fileWatcher);
    }
  };

  const configWatcher = vscode.workspace.createFileSystemWatcher(
    '**/.vscode/claudesync.json',
  );
  configWatcher.onDidChange(async () => {
    outputChannel.appendLine('Refreshing configuration...');
    configManager.clearCache(); // clear the config cache
    await configManager.getConfig(); // get fresh config
    await updateSyncManager(); // update sync manager with new config
  });
  context.subscriptions.push(configWatcher);

  const updateSyncManager = async () => {
    const config = await configManager.getConfig();
    syncManager = new SyncManager(config, outputChannel, configManager);

    // sync workspace on startup if enabled and project is initialized
    const isInitialized = await syncManager.isProjectInitialized();
    const vscodeConfig = vscode.workspace.getConfiguration('claudesync');
    const syncOnStartup = vscodeConfig.get('syncOnStartup') as boolean;

    // only log startup sync status during actual startup, not config changes
    if (!configWatcher) {
      if (isInitialized && config.sessionToken && syncOnStartup) {
        outputChannel.appendLine(
          `Sync on startup is enabled: ${syncOnStartup}`,
        );
        vscode.commands.executeCommand('claudesync.syncWorkspace');
      } else {
        outputChannel.appendLine(
          `Skipping sync on startup. Initialized: ${isInitialized}, Has token: ${!!config.sessionToken}, Sync on startup: ${syncOnStartup}`,
        );
      }
    }

    // setup file watcher based on current state
    await setupFileWatcher();
  };
  await updateSyncManager();

  // command to configure autosync
  const configureAutoSyncCommand = vscode.commands.registerCommand(
    'claudesync.configureAutoSync',
    async (): Promise<void> => {
      const config = await configManager.getConfig();

      // ask user to enable/disable autosync
      const enableAutoSync = await vscode.window.showQuickPick(
        ['Enable', 'Disable'],
        {
          placeHolder: 'Enable or disable auto-sync?',
        },
      );

      if (!enableAutoSync) {
        return;
      }

      let autoSyncDelay = config.autoSyncDelay;
      if (enableAutoSync === 'Enable') {
        const delay = await vscode.window.showInputBox({
          prompt: 'Enter auto-sync delay in seconds (10-180)',
          value: String(config.autoSyncDelay),
          validateInput: (value) => {
            const num = Number.parseInt(value);
            if (Number.isNaN(num) || num < 10 || num > 180) {
              return 'Please enter a number between 10 and 180 seconds';
            }
            return null;
          },
        });

        if (!delay) {
          vscode.window.showErrorMessage('Auto-sync delay cannot be empty');
          return;
        }
        autoSyncDelay = Number.parseInt(delay);
      }

      // save configuration
      await configManager.saveWorkspaceConfig({
        autoSync: enableAutoSync === 'Enable',
        autoSyncDelay,
      });

      // update file watcher based on new auto-sync setting
      await setupFileWatcher();

      vscode.window.showInformationMessage(
        `Auto-sync ${enableAutoSync === 'Enable' ? 'enabled' : 'disabled'}${
          enableAutoSync === 'Enable'
            ? ` with ${autoSyncDelay} seconds delay`
            : ''
        }`,
      );
    },
  );

  // command to configure startup sync
  const configureStartupSyncCommand = vscode.commands.registerCommand(
    'claudesync.configureStartupSync',
    async (): Promise<void> => {
      const config = vscode.workspace.getConfiguration('claudesync');
      const currentValue = config.get<boolean>('syncOnStartup') || false;

      await config.update('syncOnStartup', !currentValue, true);

      vscode.window.showInformationMessage(
        `Sync on startup is now ${!currentValue ? 'enabled' : 'disabled'}`,
      );
    },
  );

  // command to configure remote file cleanup
  const configureCleanupRemoteCommand = vscode.commands.registerCommand(
    'claudesync.configureCleanupRemote',
    async (): Promise<void> => {
      const config = await configManager.getConfig();

      const enableCleanup = await vscode.window.showQuickPick(
        ['Enable', 'Disable'],
        {
          placeHolder:
            "Enable or disable cleanup of remote files that don't exist locally?",
        },
      );

      if (!enableCleanup) {
        return;
      }

      await configManager.saveWorkspaceConfig({
        cleanupRemoteFiles: enableCleanup === 'Enable',
      });

      if (enableCleanup === 'Enable') {
        const syncNow = await vscode.window.showInformationMessage(
          'Remote file cleanup enabled. Would you like to sync now to clean up remote files?',
          'Yes',
          'No',
        );
        if (syncNow === 'Yes') {
          await vscode.commands.executeCommand('claudesync.syncWorkspace');
        }
      } else {
        vscode.window.showInformationMessage('Remote file cleanup disabled');
      }
    },
  );

  // track last failed sync time to prevent rapid retries
  let lastFailedSyncTime = 0;
  const SYNC_COOLDOWN_MS = 3000;

  async function syncFiles(files: vscode.Uri[]) {
    const config = await configManager.getConfig();
    if (!config.sessionToken) {
      const setToken = await vscode.window.showErrorMessage(
        'Please set your Claude session token first',
        'Set Token',
      );
      if (setToken) {
        await vscode.commands.executeCommand('claudesync.setToken');
      }
      return;
    }

    // check if project is initialized first
    const isInitialized = await syncManager.isProjectInitialized();
    if (!isInitialized) {
      const init = await vscode.window.showErrorMessage(
        'Project needs to be initialized first',
        'Initialize Project',
      );
      if (init) {
        await vscode.commands.executeCommand('claudesync.initProject');
      }
      return;
    }

    // check if we're in cooldown period after a failed sync
    const now = Date.now();
    if (now - lastFailedSyncTime < SYNC_COOLDOWN_MS) {
      outputChannel.appendLine(
        'Skipping sync attempt - in cooldown period after recent failure',
      );
      return;
    }

    if (files.length === 0) {
      vscode.window.showInformationMessage('No files to sync');
      return;
    }

    const maxRetries = 20; // claude api is very unreliable
    let attempt = 0;
    let success = false;
    let lastResult: SyncResult;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Syncing with Claude',
        cancellable: false,
      },
      async (progress) => {
        while (attempt < maxRetries && !success) {
          try {
            progress.report({ message: 'Processing files...' });
            const result = await syncManager.syncFiles(files);
            lastResult = result;

            if (result.success) {
              success = true;
              outputChannel.appendLine(`Files synced successfully`);
              break;
            } else if (result.message?.includes('Project not initialized')) {
              const init = await vscode.window.showErrorMessage(
                result.message || 'Project not initialized',
                'Initialize Project',
              );
              if (init) {
                await vscode.commands.executeCommand('claudesync.initProject');
              }
              success = false;
              break;
            } else {
              const errorMsg = result.error
                ? `${result.message}: ${result.error.message}`
                : result.message;
              outputChannel.appendLine(`Failed to sync files: ${errorMsg}`);
              attempt++;
              if (attempt >= maxRetries) {
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 3000));
              progress.report({ message: 'Syncing...' });
            }
          } catch (error) {
            const errorMsg = `Failed to sync files: ${error instanceof Error ? error.message : String(error)}`;
            outputChannel.appendLine(`Error: ${errorMsg}`);
            if (error instanceof Error && error.stack) {
              outputChannel.appendLine(`Stack trace: ${error.stack}`);
            }
            attempt++;
            if (attempt >= maxRetries) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 3000));
            progress.report({ message: 'Syncing...' });
          }
        }

        if (!success) {
          lastFailedSyncTime = Date.now(); // start cooldown period
        }

        if (success) {
          // add small delay to ensure progress notification has closed
          await new Promise((resolve) => setTimeout(resolve, 500));
          const syncedFiles = lastResult?.data?.syncedFiles || 0;
          if (syncedFiles === 0) {
            vscode.window.showInformationMessage(
              'No files needed syncing - all files were up to date.',
            );
          } else {
            vscode.window.showInformationMessage(
              `Successfully synced ${syncedFiles} file${syncedFiles === 1 ? '' : 's'} with Claude!`,
            );
          }
        } else {
          vscode.window.showErrorMessage(
            'Failed to sync files, is your Claude session token correct?',
          );
        }
      },
    );
  }

  // command to set Claude session token
  const setTokenCommand = vscode.commands.registerCommand(
    'claudesync.setToken',
    async () => {
      const token = await vscode.window.showInputBox({
        prompt:
          'Enter your Claude session token. [Click here for instructions](https://github.com/rexdotsh/claudesync-vscode?tab=readme-ov-file#quick-start-guide)',
        password: true,
        placeHolder: 'sk-ant-...',
        validateInput: (value) => {
          if (!value?.startsWith('sk-ant')) {
            return "Invalid token format. Token should start with 'sk-ant'";
          }
          return null;
        },
      });

      if (token) {
        try {
          await configManager.saveGlobalConfig({ sessionToken: token });
          await updateSyncManager();
          vscode.window.showInformationMessage(
            'Claude session token has been successfully saved and configured',
          );
        } catch (error) {
          const errorMsg = `Failed to save token: ${error instanceof Error ? error.message : String(error)}`;
          vscode.window.showErrorMessage(errorMsg);
        }
      }
    },
  );

  // command to initialize project
  const initProjectCommand = vscode.commands.registerCommand(
    'claudesync.initProject',
    async () => {
      const config = await configManager.getConfig();

      if (!config.sessionToken) {
        const setToken = await vscode.window.showErrorMessage(
          'Please set your Claude session token first',
          'Set Token',
        );
        if (setToken) {
          await vscode.commands.executeCommand('claudesync.setToken');
          return;
        }
        return;
      }

      try {
        const result = await syncManager.initializeProject();
        outputChannel.appendLine(
          `Initialize project result: ${JSON.stringify(result)}`,
        );
        if (result.success) {
          if (!result.message) {
            outputChannel.appendLine(
              'Warning: No message received from syncManager.initializeProject()',
            );
          }
          const message =
            result.message || 'Unexpected: No initialization message received';
          const action = await vscode.window.showInformationMessage(
            message,
            'Sync Workspace',
            'Open in Browser',
          );
          if (action === 'Sync Workspace') {
            await vscode.commands.executeCommand('claudesync.syncWorkspace');
          } else if (action === 'Open in Browser') {
            vscode.env.openExternal(
              vscode.Uri.parse(`https://claude.ai/project/${config.projectId}`),
            );
          }
        } else {
          const errorMsg = result.error
            ? `${result.message || 'Error'}: ${result.error.message}`
            : result.message || 'Unknown error';
          vscode.window.showErrorMessage(errorMsg);
        }
      } catch (error) {
        const errorMsg = `Failed to initialize project: ${error instanceof Error ? error.message : String(error)}`;
        vscode.window.showErrorMessage(errorMsg);
      }
    },
  );

  // command to sync current file
  const syncCurrentFileCommand = vscode.commands.registerCommand(
    'claudesync.syncCurrentFile',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active file to sync');
        return;
      }
      await syncFiles([editor.document.uri]);
    },
  );

  // command to sync entire workspace
  const syncWorkspaceCommand = vscode.commands.registerCommand(
    'claudesync.syncWorkspace',
    async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder found');
        return;
      }

      try {
        const config = await configManager.getConfig();
        const excludePatterns = config.excludePatterns || [];
        outputChannel.appendLine(
          `Using exclude patterns from config: ${excludePatterns.join(', ')}`,
        );

        const files = await vscode.workspace.findFiles('**/*');
        outputChannel.appendLine(
          `Found ${files.length} total files before filtering`,
        );
        await syncFiles(files);
      } catch (error) {
        const errorMsg = `Failed to sync workspace: ${error instanceof Error ? error.message : String(error)}`;
        vscode.window.showErrorMessage(errorMsg);
      }
    },
  );

  // Command to sync project instructions
  const syncProjectInstructionsCommand = vscode.commands.registerCommand(
    'claudesync.syncProjectInstructions',
    async () => {
      const config = await configManager.getConfig();
      if (!config.sessionToken) {
        const setToken = await vscode.window.showErrorMessage(
          'Please set your Claude session token first',
          'Set Token',
        );
        if (setToken) {
          await vscode.commands.executeCommand('claudesync.setToken');
          return;
        }
        return;
      }

      try {
        const result = await syncManager.syncProjectInstructions();
        if (result.success) {
          const message =
            result.message || 'Project instructions synced successfully';
          vscode.window.showInformationMessage(message);
          outputChannel.appendLine(message);
        } else {
          const errorMsg = result.error
            ? `${result.message || 'Error'}: ${result.error.message}`
            : result.message || 'Unknown error';
          outputChannel.appendLine(
            `Failed to sync project instructions: ${errorMsg}`,
          );
          vscode.window.showErrorMessage(errorMsg);
        }
      } catch (error) {
        const errorMsg = `Failed to sync project instructions: ${
          error instanceof Error ? error.message : String(error)
        }`;
        outputChannel.appendLine(`Error: ${errorMsg}`);
        if (error instanceof Error && error.stack) {
          outputChannel.appendLine(`Stack trace: ${error.stack}`);
        }
        vscode.window.showErrorMessage(errorMsg);
      }
    },
  );

  // update project instructions
  const updateProjectInstructionsCommand = vscode.commands.registerCommand(
    'claudesync.updateProjectInstructions',
    async () => {
      const config = await configManager.getConfig();
      if (!config.sessionToken) {
        const setToken = await vscode.window.showErrorMessage(
          'Please set your Claude session token first',
          'Set Token',
        );
        if (setToken) {
          await vscode.commands.executeCommand('claudesync.setToken');
          return;
        }
        return;
      }

      try {
        const result = await syncManager.syncProjectInstructions();
        if (result.success) {
          const message =
            result.message || 'Project instructions updated successfully';
          vscode.window.showInformationMessage(message);
          outputChannel.appendLine(message);
        } else {
          const errorMsg = result.error
            ? `${result.message || 'Error'}: ${result.error.message}`
            : result.message || 'Unknown error';
          outputChannel.appendLine(
            `Failed to update project instructions: ${errorMsg}`,
          );
          vscode.window.showErrorMessage(errorMsg);
        }
      } catch (error) {
        const errorMsg = `Failed to update project instructions: ${
          error instanceof Error ? error.message : String(error)
        }`;
        outputChannel.appendLine(`Error: ${errorMsg}`);
        if (error instanceof Error && error.stack) {
          outputChannel.appendLine(`Stack trace: ${error.stack}`);
        }
        vscode.window.showErrorMessage(errorMsg);
      }
    },
  );

  // command to open project in browser
  const openInBrowserCommand = vscode.commands.registerCommand(
    'claudesync.openInBrowser',
    async () => {
      const config = await configManager.getConfig();
      if (!config.sessionToken) {
        const setToken = await vscode.window.showErrorMessage(
          'Please set your Claude session token first',
          'Set Token',
        );
        if (setToken) {
          await vscode.commands.executeCommand('claudesync.setToken');
        }
        return;
      }

      if (!config.projectId) {
        const init = await vscode.window.showErrorMessage(
          'Project needs to be initialized first',
          'Initialize Project',
        );
        if (init) {
          await vscode.commands.executeCommand('claudesync.initProject');
        }
        return;
      }

      vscode.env.openExternal(
        vscode.Uri.parse(`https://claude.ai/project/${config.projectId}`),
      );
    },
  );

  // helper function to check if a uri is a directory and get its pattern
  async function getExcludePattern(
    uri: vscode.Uri,
  ): Promise<{ isDirectory: boolean; pattern: string }> {
    const relativePath = vscode.workspace.asRelativePath(uri);
    const stat = await vscode.workspace.fs.stat(uri);
    const isDirectory =
      (stat.type & vscode.FileType.Directory) === vscode.FileType.Directory;
    return {
      isDirectory,
      pattern: isDirectory ? `${relativePath}/**` : relativePath,
    };
  }

  // helper function to check if a pattern exists in any form, such as `scripts`, `scripts/`, or `scripts/**`
  function findMatchingPattern(
    patterns: string[],
    targetPath: string,
    isDirectory: boolean,
  ): string | undefined {
    // normalize path to use forward slashes
    const normalizedPath = targetPath.replace(/\\/g, '/');
    const variations = isDirectory
      ? [normalizedPath, `${normalizedPath}/`, `${normalizedPath}/**`]
      : [normalizedPath];

    return patterns.find((pattern) =>
      variations.includes(pattern.replace(/\\/g, '/')),
    );
  }

  // helper function to sync after include/exclude operations
  async function syncAfterPatternChange(
    uri: vscode.Uri,
    isDirectory: boolean,
    relativePath: string,
  ) {
    const config = await configManager.getConfig();
    const isInitialized = await syncManager.isProjectInitialized();

    if (isInitialized && config.sessionToken) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        const files = await vscode.workspace.findFiles('**/*');
        await syncFiles(files);
      }
    }
  }

  // command to exclude file from sync
  const excludeFromSyncCommand = vscode.commands.registerCommand(
    'claudesync.excludeFromSync',
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showErrorMessage('No file selected');
        return;
      }

      const relativePath = vscode.workspace.asRelativePath(uri);
      try {
        const config = await configManager.getConfig();
        const excludePatterns = config.excludePatterns || [];
        const { isDirectory, pattern } = await getExcludePattern(uri);

        // check if pattern already exists in any form
        const existingPattern = findMatchingPattern(
          excludePatterns,
          relativePath,
          isDirectory,
        );
        if (existingPattern) {
          vscode.window.showInformationMessage(
            `${isDirectory ? 'Directory' : 'File'} '${relativePath}' is already excluded from Claude project`,
          );
          return;
        }

        // add to exclude patterns
        excludePatterns.push(pattern);
        await configManager.saveWorkspaceConfig({ excludePatterns });
        vscode.window.showInformationMessage(
          `${isDirectory ? 'Directory' : 'File'} '${relativePath}' excluded from Claude project`,
        );

        // if auto-sync is enabled or cleanup is enabled, trigger a sync
        if (config.autoSync || config.cleanupRemoteFiles) {
          await syncAfterPatternChange(uri, isDirectory, relativePath);
        }
      } catch (error) {
        const errorMsg = `Failed to exclude ${relativePath}: ${error instanceof Error ? error.message : String(error)}`;
        vscode.window.showErrorMessage(errorMsg);
        outputChannel.appendLine(`Error: ${errorMsg}`);
        if (error instanceof Error && error.stack) {
          outputChannel.appendLine(`Stack trace: ${error.stack}`);
        }
      }
    },
  );

  // command to include file in sync
  const includeInSyncCommand = vscode.commands.registerCommand(
    'claudesync.includeInSync',
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showErrorMessage('No file selected');
        return;
      }

      const relativePath = vscode.workspace.asRelativePath(uri);
      try {
        const config = await configManager.getConfig();
        const excludePatterns = config.excludePatterns || [];
        const { isDirectory, pattern } = await getExcludePattern(uri);

        // find matching pattern in any form
        const existingPattern = findMatchingPattern(
          excludePatterns,
          relativePath,
          isDirectory,
        );
        if (!existingPattern) {
          vscode.window.showInformationMessage(
            `${isDirectory ? 'Directory' : 'File'} '${relativePath}' is not excluded from Claude project`,
          );
          return;
        }

        // remove the pattern
        const index = excludePatterns.indexOf(existingPattern);
        excludePatterns.splice(index, 1);
        await configManager.saveWorkspaceConfig({ excludePatterns });

        // attempt to sync the file/directory
        await syncAfterPatternChange(uri, isDirectory, relativePath);

        if (
          !(await syncManager.isProjectInitialized()) ||
          !config.sessionToken
        ) {
          vscode.window.showInformationMessage(
            `${isDirectory ? 'Directory' : 'File'} '${relativePath}' included in Claude project`,
          );
        }
      } catch (error) {
        const errorMsg = `Failed to include ${relativePath}: ${error instanceof Error ? error.message : String(error)}`;
        vscode.window.showErrorMessage(errorMsg);
        outputChannel.appendLine(`Error: ${errorMsg}`);
        if (error instanceof Error && error.stack) {
          outputChannel.appendLine(`Stack trace: ${error.stack}`);
        }

        // try to rollback the exclude pattern change
        try {
          const config = await configManager.getConfig();
          const excludePatterns = config.excludePatterns || [];
          const { pattern } = await getExcludePattern(uri);
          if (!excludePatterns.includes(pattern)) {
            excludePatterns.push(pattern);
            await configManager.saveWorkspaceConfig({ excludePatterns });
          }
        } catch (rollbackError) {
          outputChannel.appendLine(
            `Failed to rollback include operation: ${rollbackError}`,
          );
        }
      }
    },
  );

  // command to show output channel
  const showOutputCommand = vscode.commands.registerCommand(
    'claudesync.showOutput',
    () => {
      outputChannel.show();
    },
  );

  // command to toggle gitignore setting
  const toggleGitignoreCommand = vscode.commands.registerCommand(
    'claudesync.toggleGitignore',
    async () => {
      const config = vscode.workspace.getConfiguration('claudesync');
      const currentValue = config.get<boolean>('addToGitignore') || false;

      await config.update('addToGitignore', !currentValue, true);

      // If we're enabling it, ensure gitignore is updated
      if (!currentValue) {
        await configManager.getConfig(); // Force config refresh
        await new GitManager(outputChannel).ensureGitIgnore();
      }

      vscode.window.showInformationMessage(
        `Auto-add to gitignore is now ${!currentValue ? 'enabled' : 'disabled'}`,
      );
    },
  );

  context.subscriptions.push(
    setTokenCommand,
    initProjectCommand,
    syncCurrentFileCommand,
    syncWorkspaceCommand,
    syncProjectInstructionsCommand,
    updateProjectInstructionsCommand,
    configureAutoSyncCommand,
    configureStartupSyncCommand,
    configureCleanupRemoteCommand,
    openInBrowserCommand,
    excludeFromSyncCommand,
    includeInSyncCommand,
    showOutputCommand,
    toggleGitignoreCommand,
  );

  // add file watcher to disposables if it exists
  if (fileWatcher) {
    context.subscriptions.push(fileWatcher);
  }
}

export function deactivate() {
  if (outputChannel) {
    outputChannel.dispose();
  }
}

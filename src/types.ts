export interface GlobalConfig {
  sessionToken: string;
  addToGitignore: boolean;
}

export interface WorkspaceConfig {
  organizationId?: string;
  projectId?: string;
  excludePatterns: string[];
  maxFileSize: number; // in bytes
  autoSync: boolean;
  autoSyncDelay: number; // in seconds
  syncOnStartup: boolean;
  cleanupRemoteFiles: boolean;
}

export interface ClaudeSyncConfig extends GlobalConfig, WorkspaceConfig {}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  hash?: string;
}

export interface RemoteFileContent {
  uuid: string;
  file_name: string;
  content: string;
  created_at: string;
}

export interface SyncResult {
  success: boolean;
  message?: string;
  error?: Error;
  data?: {
    syncedFiles: number;
  };
}

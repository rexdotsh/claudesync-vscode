export interface ClaudeSyncConfig {
  sessionToken: string;
  workspaceRoot?: string;
  excludePatterns: string[];
  maxFileSize: number; // in bytes
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
}

export interface SyncResult {
  success: boolean;
  message: string;
  error?: Error;
}

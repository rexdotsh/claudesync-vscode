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
  message: string;
  error?: Error;
}

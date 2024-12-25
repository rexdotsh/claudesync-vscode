import axios, { AxiosError } from "axios";
import { ClaudeSyncConfig } from "../types";

export interface Organization {
  id: string;
  name: string;
}

export interface Project {
  id: string;
  name: string;
  archived_at?: string;
}

export interface FileDoc {
  uuid: string;
  file_name: string;
  content: string;
  created_at: string;
}

export class ClaudeClient {
  private readonly baseUrl = "https://api.claude.ai/api";
  private readonly sessionToken: string;

  constructor(config: ClaudeSyncConfig) {
    this.sessionToken = config.sessionToken;
  }

  private async makeRequest<T>(method: string, endpoint: string, data?: any): Promise<T> {
    try {
      const response = await axios({
        method,
        url: `${this.baseUrl}${endpoint}`,
        data,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Content-Type": "application/json",
          Cookie: `sessionKey=${this.sessionToken}`,
        },
        validateStatus: null, // Don't throw on any status
      });

      if (response.status === 403) {
        throw new Error("Invalid session token or unauthorized access");
      }

      if (response.status === 429) {
        const resetTime = new Date(response.data.error.message.resetsAt);
        throw new Error(`Rate limit exceeded. Try again after ${resetTime.toLocaleString()}`);
      }

      if (response.status >= 400) {
        throw new Error(`API request failed: ${response.statusText}`);
      }

      return response.data;
    } catch (error) {
      if (error instanceof AxiosError) {
        if (error.response?.status === 403) {
          throw new Error("Invalid session token or unauthorized access");
        }
        if (error.response?.status === 429) {
          const resetTime = new Date(error.response.data.error.message.resetsAt);
          throw new Error(`Rate limit exceeded. Try again after ${resetTime.toLocaleString()}`);
        }
        throw new Error(`API request failed: ${error.message}`);
      }
      throw new Error(`API request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getOrganizations(): Promise<Organization[]> {
    const response = await this.makeRequest<any[]>("GET", "/organizations");
    return response
      .filter(
        (org) =>
          new Set(org.capabilities || []).has("chat") &&
          (new Set(org.capabilities || []).has("claude_pro") || new Set(org.capabilities || []).has("raven"))
      )
      .map((org) => ({
        id: org.uuid,
        name: org.name,
      }));
  }

  async getProjects(organizationId: string, includeArchived = false): Promise<Project[]> {
    const response = await this.makeRequest<any[]>("GET", `/organizations/${organizationId}/projects`);
    return response
      .filter((project) => includeArchived || !project.archived_at)
      .map((project) => ({
        id: project.uuid,
        name: project.name,
        archived_at: project.archived_at,
      }));
  }

  async createProject(organizationId: string, name: string, description = ""): Promise<Project> {
    const data = {
      name,
      description,
      is_private: true,
    };
    const response = await this.makeRequest<any>("POST", `/organizations/${organizationId}/projects`, data);
    return {
      id: response.uuid,
      name: response.name,
      archived_at: response.archived_at,
    };
  }

  async listFiles(organizationId: string, projectId: string): Promise<FileDoc[]> {
    const response = await this.makeRequest<any[]>(
      "GET",
      `/organizations/${organizationId}/projects/${projectId}/docs`
    );
    return response.map((file) => ({
      uuid: file.uuid,
      file_name: file.file_name,
      content: file.content,
      created_at: file.created_at,
    }));
  }

  async uploadFile(organizationId: string, projectId: string, fileName: string, content: string): Promise<FileDoc> {
    const data = {
      file_name: fileName,
      content,
    };
    return this.makeRequest<FileDoc>("POST", `/organizations/${organizationId}/projects/${projectId}/docs`, data);
  }

  async deleteFile(organizationId: string, projectId: string, fileUuid: string): Promise<void> {
    await this.makeRequest<void>("DELETE", `/organizations/${organizationId}/projects/${projectId}/docs/${fileUuid}`);
  }
}

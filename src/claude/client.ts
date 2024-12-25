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
      const url = `${this.baseUrl}${endpoint}`;
      console.log(`Making ${method} request to ${url}`);
      console.log(`Cookie: ${`sessionKey=${this.sessionToken}`}`);
      const response = await axios({
        method,
        url,
        data,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Content-Type": "application/json",
          Accept: "application/json",
          Cookie: `sessionKey=${this.sessionToken}`,
        },
        withCredentials: true,
        validateStatus: null,
      });

      console.log(`Response status: ${response.status}`);
      console.log(`Response headers:`, response.headers);
      if (response.status === 403) {
        console.error("Authentication failed - invalid session token");
        console.error("Response data:", response.data);
        throw new Error(
          "Invalid session token or unauthorized access. Please make sure your token is correct and you're logged into claude.ai"
        );
      }

      if (response.status === 429) {
        console.error("Rate limit exceeded", response.data);
        const resetTime = new Date(response.data.error.message.resetsAt);
        throw new Error(`Rate limit exceeded. Try again after ${resetTime.toLocaleString()}`);
      }

      if (response.status >= 400) {
        console.error(`API error ${response.status}:`, response.data);
        throw new Error(`API request failed (${response.status}): ${response.data?.error || response.statusText}`);
      }

      return response.data;
    } catch (error) {
      if (error instanceof AxiosError) {
        console.error("Axios error:", {
          status: error.response?.status,
          data: error.response?.data,
          message: error.message,
          config: {
            url: error.config?.url,
            headers: error.config?.headers,
          },
        });

        if (error.response?.status === 403) {
          throw new Error(
            "Invalid session token or unauthorized access. Please make sure your token is correct and you're logged into claude.ai"
          );
        }
        if (error.response?.status === 429) {
          const resetTime = new Date(error.response.data.error.message.resetsAt);
          throw new Error(`Rate limit exceeded. Try again after ${resetTime.toLocaleString()}`);
        }
        throw new Error(`API request failed: ${error.message} (${error.response?.status || "unknown status"})`);
      }
      console.error("Non-Axios error:", error);
      throw new Error(`API request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getOrganizations(): Promise<Organization[]> {
    console.log("Getting organizations");
    const response = await this.makeRequest<any[]>("GET", "/organizations");
    console.log(`Got ${response.length} organizations`);
    console.log("Organizations response:", response);

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
    console.log(`Getting projects for organization ${organizationId}`);
    const response = await this.makeRequest<any[]>("GET", `/organizations/${organizationId}/projects`);
    console.log(`Got ${response.length} projects`);
    console.log("Projects response:", response);

    return response
      .filter((project) => includeArchived || !project.archived_at)
      .map((project) => ({
        id: project.uuid,
        name: project.name,
        archived_at: project.archived_at,
      }));
  }

  async createProject(organizationId: string, name: string, description = ""): Promise<Project> {
    console.log(`Creating project "${name}" in organization ${organizationId}`);
    const data = {
      name,
      description,
      is_private: true,
    };
    const response = await this.makeRequest<any>("POST", `/organizations/${organizationId}/projects`, data);
    console.log(`Created project with ID ${response.uuid}`);
    console.log("Create project response:", response);

    return {
      id: response.uuid,
      name: response.name,
      archived_at: response.archived_at,
    };
  }

  async listFiles(organizationId: string, projectId: string): Promise<FileDoc[]> {
    console.log(`Listing files for project ${projectId} in organization ${organizationId}`);
    const response = await this.makeRequest<any[]>(
      "GET",
      `/organizations/${organizationId}/projects/${projectId}/docs`
    );
    console.log(`Found ${response.length} files`);
    console.log("List files response:", response);

    return response.map((file) => ({
      uuid: file.uuid,
      file_name: file.file_name,
      content: file.content,
      created_at: file.created_at,
    }));
  }

  async uploadFile(organizationId: string, projectId: string, fileName: string, content: string): Promise<FileDoc> {
    console.log(`Uploading file "${fileName}" to project ${projectId}`);
    const data = {
      file_name: fileName,
      content,
    };
    const response = await this.makeRequest<FileDoc>(
      "POST",
      `/organizations/${organizationId}/projects/${projectId}/docs`,
      data
    );
    console.log(`Uploaded file with UUID ${response.uuid}`);
    console.log("Upload file response:", response);
    return response;
  }

  async deleteFile(organizationId: string, projectId: string, fileUuid: string): Promise<void> {
    console.log(`Deleting file ${fileUuid} from project ${projectId}`);
    await this.makeRequest<void>("DELETE", `/organizations/${organizationId}/projects/${projectId}/docs/${fileUuid}`);
    console.log(`Deleted file ${fileUuid}`);
  }
}

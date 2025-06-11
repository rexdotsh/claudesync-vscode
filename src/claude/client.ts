import axios, { AxiosError } from 'axios';
import type { ClaudeSyncConfig } from '../types';

export interface Organization {
  id: string;
  name: string;
}

export interface Project {
  id: string;
  name: string;
  archived_at?: string;
}

interface FileDoc {
  uuid: string;
  file_name: string;
  content: string;
  created_at: string;
}

interface OrganizationResponse {
  uuid: string;
  name: string;
  capabilities: string[];
}

interface ProjectResponse {
  uuid: string;
  name: string;
  archived_at?: string;
}

export class ClaudeClient {
  private readonly baseUrl = 'https://claude.ai/api';
  private readonly sessionToken: string;

  constructor(config: ClaudeSyncConfig) {
    this.sessionToken = config.sessionToken;
  }

  private async makeRequest<T>(
    method: string,
    endpoint: string,
    data?: Record<string, unknown>,
  ): Promise<T> {
    try {
      const url = `${this.baseUrl}${endpoint}`;
      console.log(`Making ${method} request to ${url}`);
      const response = await axios({
        method,
        url,
        data,
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)',
          'Accept-Encoding': 'gzip',
          Accept: 'application/json',
          Cookie: `sessionKey=${this.sessionToken};`,
        },
        validateStatus: null,
      });

      if (response.status === 403) {
        console.error('Authentication failed - invalid session token');
        console.error('Response data:', response.data);
        throw new Error(
          "Invalid session token or unauthorized access. Please make sure your token is correct and you're logged into claude.ai",
        );
      }

      if (response.status === 429) {
        console.error('Rate limit exceeded', response.data);
        const resetTime = new Date(response.data.error.message.resetsAt);
        throw new Error(
          `Rate limit exceeded. Try again after ${resetTime.toLocaleString()}`,
        );
      }

      if (response.status >= 400) {
        console.error(`API error ${response.status}:`, response.data);
        throw new Error(
          `API request failed (${response.status}): ${response.data?.error || response.statusText}`,
        );
      }

      return response.data;
    } catch (error) {
      if (error instanceof AxiosError) {
        console.error('Axios error:', {
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
            "Invalid session token or unauthorized access. Please make sure your token is correct and you're logged into claude.ai",
          );
        }
        if (error.response?.status === 429) {
          const resetTime = new Date(
            error.response.data.error.message.resetsAt,
          );
          throw new Error(
            `Rate limit exceeded. Try again after ${resetTime.toLocaleString()}`,
          );
        }
        throw new Error(
          `API request failed: ${error.message} (${error.response?.status || 'unknown status'})`,
        );
      }
      console.error('Non-Axios error:', error);
      throw new Error(
        `API request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getOrganizations(): Promise<Organization[]> {
    const response = await this.makeRequest<OrganizationResponse[]>(
      'GET',
      '/organizations',
    );

    return response
      .filter((org) => {
        const caps = new Set(org.capabilities || []);
        // check for atleast chat, and one of the following: claude_pro, claude_max, raven
        return (
          caps.has('chat') &&
          (caps.has('claude_pro') ||
            // ref: https://github.com/rexdotsh/claudesync-vscode/issues/4
            caps.has('claude_max') ||
            // ref: https://github.com/jahwag/ClaudeSync/blob/9f151a78bdfdddc892a3148d0e906078dd63b17f/src/claudesync/providers/base_claude_ai.py#L180
            caps.has('raven'))
        );
      })
      .map((org) => ({
        id: org.uuid,
        name: org.name,
      }));
  }

  async getProjects(
    organizationId: string,
    includeArchived = false,
  ): Promise<Project[]> {
    const response = await this.makeRequest<ProjectResponse[]>(
      'GET',
      `/organizations/${organizationId}/projects`,
    );

    return response
      .filter((project) => includeArchived || !project.archived_at)
      .map((project) => ({
        id: project.uuid,
        name: project.name,
        archived_at: project.archived_at,
      }));
  }

  async createProject(
    organizationId: string,
    name: string,
    description = '',
  ): Promise<Project> {
    const data = {
      name,
      description,
      is_private: true,
    };
    const response = await this.makeRequest<ProjectResponse>(
      'POST',
      `/organizations/${organizationId}/projects`,
      data,
    );

    return {
      id: response.uuid,
      name: response.name,
      archived_at: response.archived_at,
    };
  }

  async listFiles(
    organizationId: string,
    projectId: string,
  ): Promise<FileDoc[]> {
    interface FileDocResponse {
      uuid: string;
      file_name: string;
      content: string;
      created_at: string;
    }

    const response = await this.makeRequest<FileDocResponse[]>(
      'GET',
      `/organizations/${organizationId}/projects/${projectId}/docs`,
    );

    return response.map((file) => ({
      uuid: file.uuid,
      file_name: file.file_name,
      content: file.content,
      created_at: file.created_at,
    }));
  }

  async uploadFile(
    organizationId: string,
    projectId: string,
    fileName: string,
    content: string,
  ): Promise<FileDoc> {
    const data = {
      file_name: fileName,
      content,
    };
    const response = await this.makeRequest<FileDoc>(
      'POST',
      `/organizations/${organizationId}/projects/${projectId}/docs`,
      data,
    );
    return response;
  }

  async deleteFile(
    organizationId: string,
    projectId: string,
    fileUuid: string,
  ): Promise<void> {
    await this.makeRequest(
      'DELETE',
      `/organizations/${organizationId}/projects/${projectId}/docs/${fileUuid}`,
    );
  }

  async updateProjectPromptTemplate(
    organizationId: string,
    projectId: string,
    promptTemplate: string,
  ): Promise<void> {
    await this.makeRequest(
      'PUT',
      `/organizations/${organizationId}/projects/${projectId}`,
      {
        prompt_template: promptTemplate,
      },
    );
  }
}

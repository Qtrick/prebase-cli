import {
  FileInspection,
  FileNode,
  GraphSnapshot,
  RepositoryInfo,
  DependencyEdge,
} from '../types/graph';
import {
  CommitDetails,
  FileHistoryResult,
  GitStatus,
  HistoryPage,
  ServerEvent,
} from '../types/temporal';

export function getSessionToken(): string {
  const urlParams = new URLSearchParams(window.location.search);
  const tokenFromUrl = urlParams.get('token');
  if (tokenFromUrl) {
    sessionStorage.setItem('prebase_token', tokenFromUrl);
    return tokenFromUrl;
  }
  return sessionStorage.getItem('prebase_token') || '';
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const token = getSessionToken();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['x-prebase-session'] = token;
  }

  const response = await fetch(path, { headers, signal });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error ${response.status} on ${path}: ${errorText}`);
  }

  return response.json();
}

export const api = {
  getHealth: (signal?: AbortSignal) =>
    request<{ status: string; version: string }>('/api/v1/health', signal),
  getStatus: (signal?: AbortSignal) =>
    request<{ indexing_status: string; revision: number }>('/api/v1/status', signal),
  getRepository: (signal?: AbortSignal) =>
    request<RepositoryInfo>('/api/v1/repository', signal),
  getNetwork: (signal?: AbortSignal) =>
    request<GraphSnapshot>('/api/v1/network', signal),
  searchFiles: (query: string, limit = 50, signal?: AbortSignal) =>
    request<FileNode[]>(`/api/v1/files?q=${encodeURIComponent(query)}&limit=${limit}`, signal),
  inspectFile: (fileId: string, signal?: AbortSignal) =>
    request<FileInspection>(`/api/v1/files/${encodeURIComponent(fileId)}`, signal),
  inspectEdge: (edgeId: string, signal?: AbortSignal) =>
    request<DependencyEdge>(`/api/v1/edges/${encodeURIComponent(edgeId)}`, signal),
  getSource: (filePath: string, signal?: AbortSignal) =>
    request<{ path: string; content: string }>(`/api/v1/source/${filePath}`, signal),

  // Temporal & Git
  getHistory: (limit = 50, cursor?: string | null, signal?: AbortSignal) => {
    let url = `/api/v1/history?limit=${limit}`;
    if (cursor) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
    }
    return request<HistoryPage>(url, signal);
  },
  getCommitDetails: (hash: string, signal?: AbortSignal) =>
    request<CommitDetails>(`/api/v1/commits/${encodeURIComponent(hash)}`, signal),
  getFileHistory: (path: string, limit = 50, signal?: AbortSignal) =>
    request<FileHistoryResult>(
      `/api/v1/file-history?path=${encodeURIComponent(path)}&limit=${limit}`,
      signal
    ),
  getGitStatus: (signal?: AbortSignal) =>
    request<GitStatus>('/api/v1/git/status', signal),

  // Server-Sent Events (SSE)
  subscribeToEvents: (
    onEvent: (event: ServerEvent) => void,
    onError?: (err: Event) => void
  ): (() => void) => {
    const token = getSessionToken();
    const url = `/api/v1/events?token=${encodeURIComponent(token)}`;
    const eventSource = new EventSource(url);

    eventSource.onmessage = (e) => {
      try {
        if (!e.data || e.data === 'heartbeat') return;
        const parsed = JSON.parse(e.data) as ServerEvent;
        onEvent(parsed);
      } catch (err) {
        // ignore parse error on heartbeat
      }
    };

    eventSource.onerror = (e) => {
      if (onError) onError(e);
    };

    return () => {
      eventSource.close();
    };
  },
};

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

let inMemorySessionToken: string = '';

export function getSessionToken(): string {
  if (inMemorySessionToken) return inMemorySessionToken;
  const tokenFromStorage = sessionStorage.getItem('prebase_token');
  if (tokenFromStorage) {
    inMemorySessionToken = tokenFromStorage;
    return tokenFromStorage;
  }
  return '';
}

export async function initSession(): Promise<string> {
  const urlParams = new URLSearchParams(window.location.search);
  const bootstrapToken = urlParams.get('bootstrap');
  const tokenFromUrl = urlParams.get('token');

  if (bootstrapToken) {
    try {
      const resp = await fetch('/api/v1/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bootstrap_token: bootstrapToken }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.session_token) {
          inMemorySessionToken = data.session_token;
          sessionStorage.setItem('prebase_token', data.session_token);
        }
      }
    } catch {
      // ignore network errors on init
    }
    // Clean bootstrap parameter from browser address bar
    urlParams.delete('bootstrap');
    const newSearch = urlParams.toString();
    const cleanUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash;
    window.history.replaceState({}, '', cleanUrl);
  } else if (tokenFromUrl) {
    inMemorySessionToken = tokenFromUrl;
    sessionStorage.setItem('prebase_token', tokenFromUrl);
    urlParams.delete('token');
    const newSearch = urlParams.toString();
    const cleanUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash;
    window.history.replaceState({}, '', cleanUrl);
  }

  return getSessionToken();
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
    onStatusChange?: (status: 'connected' | 'reconnecting' | 'error') => void
  ): (() => void) => {
    const token = getSessionToken();
    const url = `/api/v1/events?token=${encodeURIComponent(token)}`;
    const eventSource = new EventSource(url);

    eventSource.onopen = () => {
      if (onStatusChange) onStatusChange('connected');
    };

    eventSource.onmessage = (e) => {
      try {
        if (!e.data || e.data === 'heartbeat') return;
        const parsed = JSON.parse(e.data) as ServerEvent;
        onEvent(parsed);
      } catch (err) {
        // ignore parse error on heartbeat
      }
    };

    eventSource.onerror = () => {
      if (onStatusChange) onStatusChange('reconnecting');
    };

    return () => {
      eventSource.close();
    };
  },
};

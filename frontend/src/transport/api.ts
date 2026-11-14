import {
  FileInspection,
  FileNode,
  GraphSnapshot,
  RepositoryInfo,
  DependencyEdge,
  WatcherHealth,
} from '../types/graph';
import {
  CommitDetails,
  FileHistoryResult,
  GitStatus,
  HistoryPage,
  ServerEvent,
} from '../types/temporal';
import { createNetworkSnapshotCoordinator } from './networkSnapshotCoordinator';

export interface SessionInitResult {
  success: boolean;
  hadBootstrapToken: boolean;
  error?: string;
  isAuthError?: boolean;
}

export async function initSession(): Promise<SessionInitResult> {
  const urlParams = new URLSearchParams(window.location.search);
  const bootstrapToken = urlParams.get('bootstrap');
  const tokenFromUrl = urlParams.get('token');

  // Purge legacy query token from URL without storing in browser storage
  if (tokenFromUrl) {
    urlParams.delete('token');
    const newSearch = urlParams.toString();
    const cleanUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash;
    window.history.replaceState({}, '', cleanUrl);
  }

  if (!bootstrapToken) {
    return { success: true, hadBootstrapToken: false };
  }

  try {
    const response = await fetch('/api/v1/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ bootstrap_token: bootstrapToken }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const isAuthError = response.status === 401 || response.status === 400;

      // Single-use token was consumed or is invalid: clean from URL to avoid repeated failed exchanges
      urlParams.delete('bootstrap');
      const newSearch = urlParams.toString();
      const cleanUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);

      return {
        success: false,
        hadBootstrapToken: true,
        isAuthError,
        error: `Authentication failed (${response.status}): ${errorText || 'Invalid or expired bootstrap token.'}`,
      };
    }

    // Success: Token consumed, session cookie established
    urlParams.delete('bootstrap');
    const newSearch = urlParams.toString();
    const cleanUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash;
    window.history.replaceState({}, '', cleanUrl);

    return { success: true, hadBootstrapToken: true };
  } catch (networkErr: unknown) {
    // Transient network failure (e.g. server still starting or disconnected).
    // DO NOT strip bootstrap token from URL! Preserve the credential so reload can retry.
    const msg = networkErr instanceof Error ? networkErr.message : String(networkErr);
    return {
      success: false,
      hadBootstrapToken: true,
      isAuthError: false,
      error: `Network failure connecting to local server: ${msg}`,
    };
  }
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  const response = await fetch(path, {
    headers,
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 401) {
      throw new Error(`Authentication required (401): Please launch PreBase from your terminal and open the authenticated link.`);
    }
    throw new Error(`API error ${response.status} on ${path}: ${errorText}`);
  }

  return response.json();
}

export const defaultNetworkCoordinator = createNetworkSnapshotCoordinator((signal) =>
  request<GraphSnapshot>('/api/v1/network', signal)
);

export const api = {
  getHealth: (signal?: AbortSignal) =>
    request<{ status: string; version: string }>('/api/v1/health', signal),
  getStatus: (signal?: AbortSignal) =>
    request<{ indexing_status: string; revision: number; watcher_health: WatcherHealth }>('/api/v1/status', signal),
  getRepository: (signal?: AbortSignal) =>
    request<RepositoryInfo>('/api/v1/repository', signal),
  getNetwork: (signal?: AbortSignal): Promise<GraphSnapshot> => {
    return defaultNetworkCoordinator.fetchSnapshot(signal);
  },
  searchFiles: (query: string, limit = 50, signal?: AbortSignal) =>
    request<FileNode[]>(`/api/v1/files?q=${encodeURIComponent(query)}&limit=${limit}`, signal),
  inspectFile: (fileId: string, signal?: AbortSignal) =>
    request<FileInspection>(`/api/v1/files/${encodeURIComponent(fileId)}`, signal),
  inspectEdge: (edgeId: string, signal?: AbortSignal) =>
    request<DependencyEdge>(`/api/v1/edges/${encodeURIComponent(edgeId)}`, signal),
  getSource: (filePath: string, signal?: AbortSignal) => {
    const encoded = filePath.split('/').map(encodeURIComponent).join('/');
    return request<{ path: string; content: string }>(`/api/v1/source/${encoded}`, signal);
  },

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
    // Authenticate cleanly via HttpOnly session cookie without token exposure in URL
    const eventSource = new EventSource('/api/v1/events', { withCredentials: true });

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

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

let inFlightSessionInit: Promise<SessionInitResult> | null = null;

function scrubAuthParamFromUrl(paramName: string) {
  if (typeof window === 'undefined') return;
  const currentParams = new URLSearchParams(window.location.search);
  if (currentParams.has(paramName)) {
    currentParams.delete(paramName);
    const newSearch = currentParams.toString();
    const cleanUrl =
      window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash;
    window.history.replaceState(window.history.state, '', cleanUrl);
  }
}

export async function initSession(): Promise<SessionInitResult> {
  if (inFlightSessionInit) {
    return inFlightSessionInit;
  }

  const promise = (async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const bootstrapToken = urlParams.get('bootstrap');
    const tokenFromUrl = urlParams.get('token');

    // Purge legacy query token from URL without storing in browser storage
    if (tokenFromUrl) {
      scrubAuthParamFromUrl('token');
    }

    if (!bootstrapToken) {
      // Direct visit without bootstrap token in URL:
      // Truthfully verify if the browser possesses a valid ambient session cookie
      try {
        const response = await fetch('/api/v1/auth/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({}),
        });

        if (response.ok) {
          const data = await response.json();
          if (data.authenticated) {
            return { success: true, hadBootstrapToken: false };
          }
        }

        return {
          success: false,
          hadBootstrapToken: false,
          isAuthError: true,
          error:
            'Authentication required: please launch PreBase from your terminal and open the authenticated link.',
        };
      } catch (networkErr: unknown) {
        const msg = networkErr instanceof Error ? networkErr.message : String(networkErr);
        return {
          success: false,
          hadBootstrapToken: false,
          isAuthError: false,
          error: `Network failure connecting to local server: ${msg}`,
        };
      }
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

        // Single-use token was consumed or is invalid: clean from URL to avoid repeated failed exchanges.
        // On 500/503 (transient server errors), DO NOT purge token from URL so user or reload can retry!
        if (isAuthError) {
          scrubAuthParamFromUrl('bootstrap');
        }

        return {
          success: false,
          hadBootstrapToken: true,
          isAuthError,
          error: `Authentication failed (${response.status}): ${errorText || 'Invalid or expired bootstrap token.'}`,
        };
      }

      // Success: Token consumed, session cookie established
      scrubAuthParamFromUrl('bootstrap');

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
  })();

  inFlightSessionInit = promise;
  promise.finally(() => {
    if (inFlightSessionInit === promise) {
      inFlightSessionInit = null;
    }
  });

  return promise;
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
    let isExplicitlyClosed = false;

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
      if (isExplicitlyClosed) return;
      if (eventSource.readyState === EventSource.CLOSED) {
        // Subscription terminally closed (e.g. server process terminated or rejected auth)
        if (onStatusChange) onStatusChange('error');
      } else {
        // EventSource.CONNECTING: browser native reconnection is attempting recovery
        if (onStatusChange) onStatusChange('reconnecting');
      }
    };

    return () => {
      isExplicitlyClosed = true;
      eventSource.close();
    };
  },
};

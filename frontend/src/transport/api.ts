import {
  FileInspection,
  FileNode,
  GraphSnapshot,
  RepositoryInfo,
  DependencyEdge,
} from '../types/graph';

function getSessionToken(): string {
  const urlParams = new URLSearchParams(window.location.search);
  const tokenFromUrl = urlParams.get('token');
  if (tokenFromUrl) {
    sessionStorage.setItem('prebase_token', tokenFromUrl);
    return tokenFromUrl;
  }
  return sessionStorage.getItem('prebase_token') || '';
}

async function request<T>(path: string): Promise<T> {
  const token = getSessionToken();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['x-prebase-session'] = token;
  }

  const response = await fetch(path, { headers });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error ${response.status} on ${path}: ${errorText}`);
  }

  return response.json();
}

export const api = {
  getHealth: () => request<{ status: string; version: string }>('/api/v1/health'),
  getStatus: () => request<{ indexing_status: string; revision: number }>('/api/v1/status'),
  getRepository: () => request<RepositoryInfo>('/api/v1/repository'),
  getNetwork: () => request<GraphSnapshot>('/api/v1/network'),
  searchFiles: (query: string, limit = 50) =>
    request<FileNode[]>(`/api/v1/files?q=${encodeURIComponent(query)}&limit=${limit}`),
  inspectFile: (fileId: string) =>
    request<FileInspection>(`/api/v1/files/${fileId}`),
  inspectEdge: (edgeId: string) =>
    request<DependencyEdge>(`/api/v1/edges/${edgeId}`),
  getSource: (filePath: string) =>
    request<{ path: string; content: string }>(`/api/v1/source/${filePath}`),
};


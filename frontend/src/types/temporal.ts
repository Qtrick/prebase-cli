export type FileChangeStatus = 'Added' | 'Modified' | 'Deleted' | 'Renamed' | 'Copied';

export interface FileChange {
  path: string;
  old_path?: string | null;
  status: FileChangeStatus;
  similarity?: number | null;
}

export interface CommitStats {
  files_changed: number;
  insertions: number;
  deletions: number;
}

export interface CommitSummary {
  hash: string;
  short_hash: string;
  parent_hashes: string[];
  author_name: string;
  author_email: string;
  author_timestamp: number;
  summary: string;
  lane: number;
}

export interface CommitDetails {
  hash: string;
  short_hash: string;
  parent_hashes: string[];
  author_name: string;
  author_email: string;
  author_date: string;
  committer_name: string;
  committer_email: string;
  committer_date: string;
  message: string;
  stats: CommitStats;
  files: FileChange[];
  comparison_basis?: string | null;
}

export interface HistoryPage {
  commits: CommitSummary[];
  next_cursor: string | null;
  has_more: boolean;
  total_commits: number | null;
}

export interface FileHistoryResult {
  file_path: string;
  commits: CommitSummary[];
}

export interface GitStatus {
  is_git_repo: boolean;
  branch: string | null;
  head_commit: string | null;
  is_dirty: boolean;
  dirty_files: string[];
  is_worktree?: boolean;
}

export interface NetworkUpdatedEventData {
  revision: number;
  changed_files: string[];
  node_count: number;
  edge_count: number;
}

export interface GitUpdatedEventData {
  head_commit: string | null;
  branch: string | null;
}

export type ServerEvent =
  | { type: 'network.updated'; data: NetworkUpdatedEventData }
  | { type: 'git.updated'; data: GitUpdatedEventData }
  | { type: 'reconcile.required'; data: { current_revision: number } }
  | { type: 'heartbeat'; data: { timestamp: number } };


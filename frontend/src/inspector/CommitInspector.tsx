import React, { useEffect, useState, useRef } from 'react';
import { CommitDetails, CommitSummary, FileChange, GitStatus } from '../types/temporal';
import { FileNode, GraphSnapshot } from '../types/graph';
import { api } from '../transport/api';
import { useCopyFeedback } from '../utils/clipboard';
import {
  X,
  GitCommit,
  GitBranch,
  Clock,
  User,
  Calendar,
  FileCode,
  ArrowRight,
  Copy,
  Check,
  Loader2,
  AlertCircle,
  PanelRightClose,
} from 'lucide-react';

interface CommitInspectorProps {
  selectedCommit: CommitSummary | null;
  snapshot: GraphSnapshot | null;
  onClose: () => void;
  onNavigateToNetwork: (node: FileNode) => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  gitStatus?: GitStatus | null;
  totalCommits?: number | null;
  loadedCommitsCount?: number;
  temporalFilterPath?: string | null;
  onClearFilter?: () => void;
}

export const CommitInspector: React.FC<CommitInspectorProps> = ({
  selectedCommit,
  snapshot,
  onClose,
  onNavigateToNetwork,
  isCollapsed = false,
  onToggleCollapse,
  gitStatus,
  totalCommits,
  loadedCommitsCount,
  temporalFilterPath,
  onClearFilter,
}) => {
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copied, copy } = useCopyFeedback();
  const [notice, setNotice] = useState<string | null>(null);

  const requestTokenRef = useRef(0);

  useEffect(() => {
    if (!selectedCommit) {
      setDetails(null);
      setError(null);
      setNotice(null);
      return;
    }

    const currentToken = ++requestTokenRef.current;
    const abortController = new AbortController();

    setLoading(true);
    setError(null);
    setNotice(null);

    api
      .getCommitDetails(selectedCommit.hash, abortController.signal)
      .then((res) => {
        if (currentToken === requestTokenRef.current) {
          setDetails(res);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (currentToken === requestTokenRef.current) {
          if (err instanceof Error && err.name === 'AbortError') return;
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
          setLoading(false);
        }
      });

    return () => {
      abortController.abort();
    };
  }, [selectedCommit]);

  const handleCopyHash = () => {
    if (!selectedCommit) return;
    void copy(selectedCommit.hash);
  };

  const handleFileClick = (file: FileChange) => {
    if (!snapshot) return;

    // Check if file exists in the current repository network snapshot
    const match = snapshot.nodes.find(
      (n) => n.id === file.path || n.relative_path === file.path
    );

    if (match) {
      onNavigateToNetwork(match);
    } else {
      setNotice(`"${file.path}" is a historical file not present in the current working tree.`);
      setTimeout(() => setNotice(null), 4000);
    }
  };

  if (!selectedCommit) {
    return (
      <aside className={`inspector-panel ${isCollapsed ? 'collapsed' : ''}`}>
        <div className="inspector-header">
          <div className="inspector-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Clock size={16} color="#38bdf8" />
            <span>Git History Overview</span>
          </div>
          <div className="header-action-group">
            {onToggleCollapse && (
              <button
                className="icon-action-btn"
                onClick={onToggleCollapse}
                title="Collapse inspector"
                aria-label="Collapse inspector"
              >
                <PanelRightClose size={15} />
              </button>
            )}
          </div>
        </div>

        <div className="inspector-content animate-reveal">
          {temporalFilterPath && (
            <div className="stat-card" style={{ borderLeft: '3px solid var(--accent-sky)' }}>
              <div className="stat-row-between">
                <span className="stat-label">File History Filter</span>
                {onClearFilter && (
                  <button className="copy-btn" onClick={onClearFilter} title="Show full repository history">
                    <span>Clear Filter</span>
                  </button>
                )}
              </div>
              <span className="stat-value mono" style={{ fontSize: '12px' }}>{temporalFilterPath}</span>
            </div>
          )}

          {gitStatus && (
            <div className="stat-card">
              <span className="stat-label">Active Branch & HEAD</span>
              <div className="meta-line" style={{ marginTop: '6px' }}>
                <GitBranch size={14} color="#38bdf8" />
                <span className="mono" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                  {gitStatus.branch || 'HEAD (detached)'}
                </span>
              </div>
              {gitStatus.head_commit && (
                <div className="meta-line" style={{ marginTop: '4px' }}>
                  <GitCommit size={14} color="#94a3b8" />
                  <span className="mono dim" style={{ fontSize: '11px' }}>
                    {gitStatus.head_commit.slice(0, 7)}
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="stat-card">
            <span className="stat-label">Timeline Commits</span>
            <div style={{ marginTop: '6px', fontSize: '13px', color: 'var(--text-primary)' }}>
              <strong>{loadedCommitsCount || 0}</strong> {totalCommits ? `of ${totalCommits}` : ''} commits loaded
            </div>
          </div>

          <div className="stat-card">
            <span className="stat-label">Navigation Guide</span>
            <ul style={{ margin: '8px 0 0 0', paddingLeft: '16px', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              <li>Click any commit dot or summary in the DAG to inspect file diffs and stats.</li>
              <li>Use <kbd style={{ padding: '1px 5px', background: 'var(--bg-hover)', borderRadius: '3px', fontSize: '11px' }}>↑</kbd> and <kbd style={{ padding: '1px 5px', background: 'var(--bg-hover)', borderRadius: '3px', fontSize: '11px' }}>↓</kbd> arrow keys to navigate commits.</li>
              <li>Drag to pan the timeline; scroll wheel to zoom.</li>
              <li>Clicking an analyzed file in a commit opens the Network Graph focused on that file.</li>
            </ul>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className={`inspector-panel ${isCollapsed ? 'collapsed' : ''}`}>
      {/* Header */}
      <div className="inspector-header">
        <div className="inspector-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <GitCommit size={16} color="#38bdf8" />
          <span className="mono">{selectedCommit.short_hash}</span>
        </div>
        <div className="header-action-group">
          {onToggleCollapse && (
            <button
              className="icon-action-btn"
              onClick={onToggleCollapse}
              title="Collapse inspector"
              aria-label="Collapse inspector"
            >
              <PanelRightClose size={15} />
            </button>
          )}
          <button className="close-btn" onClick={onClose} title="Close inspector">
            <X size={16} />
          </button>
        </div>
      </div>

      <div key={selectedCommit.hash} className="inspector-content animate-reveal">
        {/* Notice toast if file clicked isn't in working tree */}
        {notice && (
          <div className="notice-banner">
            <AlertCircle size={15} color="#f59e0b" />
            <span>{notice}</span>
          </div>
        )}

        {/* Commit Hash and Copy */}
        <div className="stat-card">
          <div className="stat-row-between">
            <span className="stat-label">Full Commit SHA</span>
            <button className="copy-btn" onClick={handleCopyHash} title="Copy SHA">
              {copied ? <Check size={13} color="#2dd4bf" /> : <Copy size={13} />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <span className="stat-value mono sha-text">{selectedCommit.hash}</span>
        </div>

        {/* Author & Date */}
        <div className="stat-card">
          <div className="meta-line">
            <User size={14} color="#94a3b8" />
            <span>
              <strong>{selectedCommit.author_name}</strong>{' '}
              <span className="dim">&lt;{selectedCommit.author_email}&gt;</span>
            </span>
          </div>
          {details && (
            <div className="meta-line" style={{ marginTop: '6px' }}>
              <Calendar size={14} color="#94a3b8" />
              <span className="dim">{details.author_date}</span>
            </div>
          )}
        </div>

        {/* Message */}
        <div className="stat-card">
          <span className="stat-label">Commit Message</span>
          <p className="commit-message-body">
            {details ? details.message : selectedCommit.summary}
          </p>
        </div>

        {loading ? (
          <div className="loading-box">
            <Loader2 size={24} className="spinner" color="#38bdf8" />
            <span>Loading changed files & diff stats...</span>
          </div>
        ) : error ? (
          <div className="error-box">
            <AlertCircle size={16} color="#ef4444" />
            <span>{error}</span>
          </div>
        ) : details ? (
          <>
            {/* Comparison Basis for Merge Commits */}
            {details.comparison_basis && (
              <div className="stat-card" style={{ borderColor: 'rgba(56, 189, 248, 0.4)' }}>
                <span className="stat-label">Merge Comparison Basis</span>
                <span className="stat-value" style={{ fontSize: '12px', color: '#38bdf8' }}>
                  {details.comparison_basis}
                </span>
              </div>
            )}

            {/* Diff Stats */}
            <div className="stats-grid">
              <div className="stat-card">
                <span className="stat-label">Files Changed</span>
                <span className="stat-value">{details.stats.files_changed}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Diff</span>
                <span className="stat-value mono">
                  <span style={{ color: '#2dd4bf' }}>+{details.stats.insertions}</span>{' '}
                  <span style={{ color: '#f43f5e' }}>-{details.stats.deletions}</span>
                </span>
              </div>
            </div>

            {/* Changed Files */}
            <div className="relations-section">
              <div className="section-title">
                <FileCode size={15} color="#38bdf8" />
                <span>Changed Files ({details.files.length})</span>
              </div>

              {details.files.length === 0 ? (
                <p className="dim empty-text">No file changes recorded for this commit.</p>
              ) : (
                <ul className="file-changes-list">
                  {details.files.map((file, idx) => {
                    const existsInNetwork = snapshot?.nodes.some(
                      (n) => n.id === file.path || n.relative_path === file.path
                    );

                    return (
                      <li
                        key={idx}
                        className={`file-change-item ${existsInNetwork ? 'interactive' : 'historical'}`}
                        tabIndex={existsInNetwork ? 0 : undefined}
                        role={existsInNetwork ? 'button' : undefined}
                        onClick={() => handleFileClick(file)}
                        onKeyDown={(e) => {
                          if (existsInNetwork && (e.key === 'Enter' || e.key === ' ')) {
                            e.preventDefault();
                            handleFileClick(file);
                          }
                        }}
                        title={
                          existsInNetwork
                            ? 'Click to locate file in Network Graph'
                            : 'Historical file not present in current working tree'
                        }
                      >
                        <span className={`status-badge ${file.status.toLowerCase()}`}>
                          {file.status[0]}
                        </span>

                        <div className="file-change-paths">
                          <span className="file-path mono">{file.path}</span>
                          {file.old_path && (
                            <span className="file-old-path mono">from {file.old_path}</span>
                          )}
                        </div>

                        {existsInNetwork && (
                          <span className="jump-hint">
                            <ArrowRight size={13} />
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        ) : null}
      </div>
    </aside>
  );
};

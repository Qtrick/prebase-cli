import React, { useEffect, useState, useRef } from 'react';
import { CommitDetails, CommitSummary, FileChange } from '../types/temporal';
import { FileNode, GraphSnapshot } from '../types/graph';
import { api } from '../transport/api';
import {
  X,
  GitCommit,
  User,
  Calendar,
  FileCode,
  ArrowRight,
  Copy,
  Check,
  Loader2,
  AlertCircle,
} from 'lucide-react';

interface CommitInspectorProps {
  selectedCommit: CommitSummary | null;
  snapshot: GraphSnapshot | null;
  onClose: () => void;
  onNavigateToNetwork: (node: FileNode) => void;
}

export const CommitInspector: React.FC<CommitInspectorProps> = ({
  selectedCommit,
  snapshot,
  onClose,
  onNavigateToNetwork,
}) => {
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
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
    navigator.clipboard.writeText(selectedCommit.hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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

  if (!selectedCommit) return null;

  return (
    <aside className="inspector-panel">
      {/* Header */}
      <div className="inspector-header">
        <div className="inspector-title">
          <GitCommit size={16} color="#38bdf8" />
          <span className="mono">{selectedCommit.short_hash}</span>
        </div>
        <button className="icon-btn" onClick={onClose} title="Close inspector">
          <X size={16} />
        </button>
      </div>

      <div className="inspector-content">
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
                        onClick={() => handleFileClick(file)}
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

import React, { useEffect, useState, useCallback } from 'react';
import { DependencyEdge, FileNode, GraphSnapshot, RepositoryInfo } from '../types/graph';
import { CommitSummary, GitStatus, ServerEvent } from '../types/temporal';
import { api, initSession } from '../transport/api';
import { NetworkCanvas } from '../graphs/network/NetworkCanvas';
import { TemporalCanvas } from '../graphs/temporal/TemporalCanvas';
import { SearchBox } from '../search/SearchBox';
import { Inspector } from '../inspector/Inspector';
import { CommitInspector } from '../inspector/CommitInspector';
import {
  Share2,
  Clock,
  Maximize2,
  RotateCcw,
  CheckCircle2,
  Loader2,
  AlertCircle,
  FolderGit2,
  Layers,
  GitBranch,
  X,
  Radio,
  Sun,
  Moon,
  ArrowDown,
} from 'lucide-react';
import './App.css';

export const App: React.FC = () => {
  // Read initial view from URL (?view=temporal or ?view=network)
  const initialView = (() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('view') === 'temporal' ? 'temporal' : 'network';
  })();

  const [activeTab, setActiveTab] = useState<'network' | 'temporal'>(initialView);

  // Theme state
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('prebase_theme') as 'dark' | 'light') || 'dark';
  });

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem('prebase_theme', next);
      document.documentElement.setAttribute('data-theme', next);
      return next;
    });
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Network state
  const [repoInfo, setRepoInfo] = useState<RepositoryInfo | null>(null);
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [status, setStatus] = useState<string>('Scanning');
  const [error, setError] = useState<string | null>(null);

  const [selectedNode, setSelectedNode] = useState<FileNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<DependencyEdge | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);

  // Temporal state & Anchor Pagination
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<CommitSummary | null>(null);
  const [temporalLoading, setTemporalLoading] = useState(false);
  const [temporalFilterPath, setTemporalFilterPath] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMoreCommits, setHasMoreCommits] = useState(false);
  const [totalCommits, setTotalCommits] = useState<number | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Live SSE sync state
  const [liveRevision, setLiveRevision] = useState<number>(0);
  const [liveNotice, setLiveNotice] = useState<string | null>(null);
  const [watcherStatus, setWatcherStatus] = useState<
    'connected' | 'reconnecting' | 'error' | 'disabled'
  >('connected');

  // View triggers (true bounding box fit view & reset view)
  const [fitViewCounter, setFitViewCounter] = useState(0);
  const [resetViewCounter, setResetViewCounter] = useState(0);

  // 1. Initial session bootstrap & repository info
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const checkStatus = async () => {
      try {
        const repo = await api.getRepository();
        setRepoInfo(repo);
        setLiveRevision(repo.analysis_revision);

        const st = await api.getStatus();
        setStatus(st.indexing_status);

        if (st.indexing_status === 'Ready') {
          const snap = await api.getNetwork();
          setSnapshot(snap);
          setLiveRevision(snap.revision);
        } else if (st.indexing_status === 'Failed') {
          setError('Repository analysis failed. Please check CLI terminal output.');
        } else {
          timer = setTimeout(checkStatus, 700);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Failed to connect to local server: ${msg}`);
      }
    };

    // Initialize session from bootstrap token first, then start fetching
    initSession().then(() => {
      checkStatus();
      api.getGitStatus().then(setGitStatus).catch(() => {});
    });

    return () => clearTimeout(timer);
  }, []);

  // 2. Fetch Git commit history with anchor pagination
  const loadCommits = useCallback(async (filterPath?: string | null) => {
    setTemporalLoading(true);
    try {
      if (filterPath) {
        const res = await api.getFileHistory(filterPath, 100);
        setCommits(res.commits);
        setNextCursor(null);
        setHasMoreCommits(false);
        setTotalCommits(res.commits.length);
      } else {
        const res = await api.getHistory(50, null);
        setCommits(res.commits);
        setNextCursor(res.next_cursor);
        setHasMoreCommits(res.has_more);
        setTotalCommits(res.total_commits);
      }
    } catch {
      setCommits([]);
      setNextCursor(null);
      setHasMoreCommits(false);
      setTotalCommits(null);
    } finally {
      setTemporalLoading(false);
    }
  }, []);

  const handleLoadMoreCommits = useCallback(async () => {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const res = await api.getHistory(50, nextCursor);
      setCommits((prev) => [...prev, ...res.commits]);
      setNextCursor(res.next_cursor);
      setHasMoreCommits(res.has_more);
      setTotalCommits(res.total_commits);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('410') || msg.includes('StaleCursor')) {
        setLiveNotice('Commit history updated on disk. Reloading history from HEAD...');
        setTimeout(() => setLiveNotice(null), 3500);
        loadCommits(temporalFilterPath);
      }
    } finally {
      setIsLoadingMore(false);
    }
  }, [nextCursor, isLoadingMore, loadCommits, temporalFilterPath]);

  // Load commits when active tab is temporal or filter changes
  useEffect(() => {
    if (activeTab === 'temporal') {
      loadCommits(temporalFilterPath);
    }
  }, [activeTab, temporalFilterPath, loadCommits]);

  // 3. Authenticated Server-Sent Events (SSE) for Live Updates & Reconnection Reconciliation
  useEffect(() => {
    const unsubscribe = api.subscribeToEvents(
      (event: ServerEvent) => {
        setWatcherStatus('connected');
        if (event.type === 'network.updated') {
          const { revision, changed_files } = event.data;
          setLiveRevision(revision);

          // Fetch latest network snapshot without full page reload
          api
            .getNetwork()
            .then((newSnap) => {
              setSnapshot(newSnap);
              setStatus('Ready');

              // Flash subtle live-update toast
              const fileNotice =
                changed_files.length > 0 && changed_files[0] !== '*'
                  ? `${changed_files.length} file(s) updated`
                  : 'Graph reanalyzed';
              setLiveNotice(`Live update: ${fileNotice} (rev ${revision})`);
              setTimeout(() => setLiveNotice(null), 3500);

              // Re-sync selected node if still exists in the new snapshot
              setSelectedNode((prev) => {
                if (!prev) return null;
                return newSnap.nodes.find((n) => n.id === prev.id) || null;
              });
            })
            .catch(() => {});
        } else if (event.type === 'git.updated') {
          api.getGitStatus().then(setGitStatus).catch(() => {});
          if (activeTab === 'temporal') {
            loadCommits(temporalFilterPath);
          }
        }
      },
      (status) => {
        setWatcherStatus(status);
        if (status === 'connected') {
          // Re-fetch state on reconnect to reconcile any missed updates
          api.getStatus().then((st) => {
            if (st.revision > liveRevision) {
              api.getNetwork().then((newSnap) => {
                setSnapshot(newSnap);
                setLiveRevision(st.revision);
              }).catch(() => {});
            }
          }).catch(() => {});
        }
      }
    );

    return () => {
      unsubscribe();
    };
  }, [activeTab, temporalFilterPath, loadCommits, liveRevision]);

  // 4. Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const targetTag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      const isInput = targetTag === 'input' || targetTag === 'textarea';

      if (e.key === 'Escape') {
        setSelectedNode(null);
        setSelectedEdge(null);
        setSelectedCommit(null);
        setFocusedNodeId(null);
        return;
      }

      if (!isInput) {
        if (e.key === '1') {
          setActiveTab('network');
        } else if (e.key === '2') {
          setActiveTab('temporal');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Selection handlers
  const handleSelectNode = useCallback((node: FileNode | null) => {
    setSelectedNode(node);
    setSelectedEdge(null);
    if (node) {
      setFocusedNodeId(node.id);
    }
  }, []);

  const handleSelectEdge = useCallback((edge: DependencyEdge | null) => {
    setSelectedEdge(edge);
    setSelectedNode(null);
  }, []);

  // Cross-Graph: Switch from Network Inspector to Temporal with file history filter
  const handleViewFileHistory = useCallback((filePath: string) => {
    setTemporalFilterPath(filePath);
    setActiveTab('temporal');
    setSelectedNode(null);
    setSelectedEdge(null);
  }, []);

  // Cross-Graph: Switch from Temporal Commit Inspector to Network Graph focused on file
  const handleNavigateToNetwork = useCallback((node: FileNode) => {
    setActiveTab('network');
    setSelectedCommit(null);
    setSelectedNode(node);
    setSelectedEdge(null);
    setFocusedNodeId(node.id);
  }, []);

  return (
    <div className="app-shell">
      {/* 1. Left Sidebar */}
      <aside className="sidebar">
        <div className="brand-header">
          <div className="brand-logo">
            <div className="logo-orb" />
            <span className="brand-name">PreBase</span>
          </div>
          <div className="header-actions">
            <button
              className="theme-toggle-btn"
              onClick={toggleTheme}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            <span className="brand-version">v0.1</span>
          </div>
        </div>

        <div className="repo-badge">
          <FolderGit2 size={16} className="repo-icon" />
          <div className="repo-meta">
            <span className="repo-title">{repoInfo?.repository_name || 'Loading...'}</span>
            <span className="repo-path mono">{repoInfo?.repository_root_display || ''}</span>
          </div>
        </div>

        {gitStatus?.branch && (
          <div className="git-branch-badge">
            <GitBranch size={13} color="#818cf8" />
            <span className="mono">{gitStatus.branch}</span>
            {gitStatus.is_dirty && <span className="dirty-dot" title="Working tree has uncommitted changes" />}
          </div>
        )}

        <nav className="nav-menu">
          <button
            className={`nav-item ${activeTab === 'network' ? 'active' : ''}`}
            onClick={() => setActiveTab('network')}
          >
            <Share2 size={16} />
            <span>Network Graph</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'temporal' ? 'active' : ''}`}
            onClick={() => setActiveTab('temporal')}
          >
            <Clock size={16} />
            <span>Temporal Graph</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="status-indicator">
            {status === 'Ready' ? (
              <>
                <CheckCircle2 size={15} color="#2dd4bf" />
                <span>Index Ready (r{liveRevision})</span>
              </>
            ) : status === 'Failed' ? (
              <>
                <AlertCircle size={15} color="#ef4444" />
                <span>Index Failed</span>
              </>
            ) : (
              <>
                <Loader2 size={15} className="spinner" color="#38bdf8" />
                <span>{status}…</span>
              </>
            )}
          </div>

          <div className="live-watcher-badge">
            <Radio
              size={12}
              className={watcherStatus === 'connected' ? 'pulse-icon' : ''}
              color={
                watcherStatus === 'connected'
                  ? '#2dd4bf'
                  : watcherStatus === 'reconnecting'
                  ? '#f59e0b'
                  : '#ef4444'
              }
            />
            <span>
              {watcherStatus === 'connected'
                ? 'Live Watcher Active'
                : watcherStatus === 'reconnecting'
                ? 'Reconnecting...'
                : 'Watcher Inactive'}
            </span>
          </div>

          {snapshot && (
            <div className="stats-summary">
              <span className="stat-line">
                <Layers size={13} /> {snapshot.nodes.length} files
              </span>
              <span className="stat-line">
                <Share2 size={13} /> {snapshot.edges.length} relationships
              </span>
            </div>
          )}
        </div>
      </aside>

      {/* 2. Main Workspace */}
      <main className="main-content">
        {/* Top Floating Control Bar */}
        <header className="workspace-header">
          {activeTab === 'network' ? (
            <SearchBox
              files={snapshot?.nodes || []}
              onSelectNode={(node) => handleSelectNode(node)}
            />
          ) : (
            <div className="temporal-header-info">
              <Clock size={15} color="#38bdf8" />
              <span>Git Commit History & Ancestry DAG</span>
              {commits.length > 0 && (
                <span className="dim">
                  ({commits.length} {totalCommits ? `of ${totalCommits}` : ''} commits)
                </span>
              )}
            </div>
          )}

          <div className="view-controls">
            <button
              className="ctrl-btn"
              onClick={() => setFitViewCounter((c) => c + 1)}
              title="Fit View to All Nodes"
            >
              <Maximize2 size={15} />
              <span>Fit View</span>
            </button>
            <button
              className="ctrl-btn"
              onClick={() => {
                setSelectedNode(null);
                setSelectedEdge(null);
                setSelectedCommit(null);
                setFocusedNodeId(null);
                setResetViewCounter((c) => c + 1);
              }}
              title="Reset Camera View"
            >
              <RotateCcw size={15} />
              <span>Reset</span>
            </button>
          </div>
        </header>

        {/* Live sync toast notification */}
        {liveNotice && (
          <div className="live-toast">
            <Radio size={14} color="#2dd4bf" />
            <span>{liveNotice}</span>
          </div>
        )}

        {/* Active Filter Banner in Temporal View */}
        {activeTab === 'temporal' && temporalFilterPath && (
          <div className="temporal-filter-bar">
            <span>
              Showing history touching: <strong className="mono">{temporalFilterPath}</strong>
              <span className="dim" style={{ marginLeft: '8px' }}>
                (Dashed edges denote ancestry across omitted intermediate commits)
              </span>
            </span>
            <button
              className="clear-filter-btn"
              onClick={() => setTemporalFilterPath(null)}
              title="Clear file filter"
            >
              <X size={13} />
              <span>Show All History</span>
            </button>
          </div>
        )}

        {/* View Content */}
        {activeTab === 'network' ? (
          <div className="graph-container">
            {error ? (
              <div className="error-overlay">
                <AlertCircle size={32} color="#ef4444" />
                <h3>Unable to load graph</h3>
                <p>{error}</p>
              </div>
            ) : !snapshot ? (
              <div className="loading-overlay">
                <Loader2 size={36} className="spinner" color="#2dd4bf" />
                <h3>Analyzing repository structure...</h3>
                <p>Tree-sitter is extracting imports and resolving module dependencies.</p>
              </div>
            ) : snapshot.nodes.length === 0 ? (
              <div className="empty-overlay">
                <h3>No supported JavaScript/TypeScript files found</h3>
                <p>Ensure the directory contains .js, .jsx, .ts, or .tsx files.</p>
              </div>
            ) : (
              <NetworkCanvas
                snapshot={snapshot}
                selectedNodeId={selectedNode?.id || null}
                selectedEdgeId={selectedEdge?.id || null}
                onSelectNode={handleSelectNode}
                onSelectEdge={handleSelectEdge}
                focusedNodeId={focusedNodeId}
                fitViewTrigger={fitViewCounter}
                resetViewTrigger={resetViewCounter}
              />
            )}
          </div>
        ) : (
          <div className="graph-container">
            {temporalLoading ? (
              <div className="loading-overlay">
                <Loader2 size={36} className="spinner" color="#38bdf8" />
                <h3>Loading Git ancestry DAG...</h3>
                <p>Reading commit topology and lane allocations.</p>
              </div>
            ) : commits.length === 0 ? (
              <div className="empty-overlay">
                <Clock size={36} color="#64748b" />
                <h3>No Git commit history available</h3>
                <p>
                  {temporalFilterPath
                    ? `No commits found touching "${temporalFilterPath}".`
                    : 'The target directory is not a Git repository or has 0 commits.'}
                </p>
                {temporalFilterPath && (
                  <button className="primary-btn" onClick={() => setTemporalFilterPath(null)}>
                    Clear File Filter
                  </button>
                )}
              </div>
            ) : (
              <>
                <TemporalCanvas
                  commits={commits}
                  selectedCommitHash={selectedCommit?.hash || null}
                  onSelectCommit={setSelectedCommit}
                  isFiltered={Boolean(temporalFilterPath)}
                  fitViewTrigger={fitViewCounter}
                  resetViewTrigger={resetViewCounter}
                />

                {/* Floating Load More Commits Button */}
                {hasMoreCommits && (
                  <div className="pagination-float-bar">
                    <button
                      className="pagination-btn"
                      disabled={isLoadingMore}
                      onClick={handleLoadMoreCommits}
                    >
                      {isLoadingMore ? (
                        <>
                          <Loader2 size={14} className="spinner" color="#38bdf8" />
                          <span>Loading older commits...</span>
                        </>
                      ) : (
                        <>
                          <ArrowDown size={14} color="#38bdf8" />
                          <span>
                            Load older commits ({commits.length} {totalCommits ? `of ${totalCommits}` : ''})
                          </span>
                        </>
                      )}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </main>

      {/* 3. Right Inspector (Network Inspector or Temporal Commit Inspector) */}
      {activeTab === 'temporal' && selectedCommit ? (
        <CommitInspector
          selectedCommit={selectedCommit}
          snapshot={snapshot}
          onClose={() => setSelectedCommit(null)}
          onNavigateToNetwork={handleNavigateToNetwork}
        />
      ) : (
        <Inspector
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          snapshot={snapshot}
          onSelectNode={handleSelectNode}
          onClose={() => {
            setSelectedNode(null);
            setSelectedEdge(null);
          }}
          onViewFileHistory={handleViewFileHistory}
        />
      )}
    </div>
  );
};

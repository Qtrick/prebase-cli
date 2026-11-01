import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { DependencyEdge, FileNode, GraphSnapshot, RepositoryInfo, WatcherHealth, ViewportInsets } from '../types/graph';
import { CommitSummary, GitStatus, ServerEvent } from '../types/temporal';
import { api, initSession } from '../transport/api';
import { NetworkCanvas, RevealRequest } from '../graphs/network/NetworkCanvas';
import { RelationshipCanvas, Viewport2D } from '../graphs/relationship/RelationshipCanvas';
import {
  resolveWatcherStatusInfo,
  reconcileSelectedNodeOnSnapshot,
} from '../transport/statusInfo';
import {
  reconcileFocusNodeOnSnapshot,
  pushFocusHistory,
  popFocusHistory,
  resolveBackTargetName,
} from '../graphs/relationship/relationshipHistory';
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
  Compass,
} from 'lucide-react';
import './App.css';

export const App: React.FC = () => {
  // Read initial view and focus from URL (?view=temporal | ?view=2d | ?view=3d, ?focus=<path>)
  const initialParams = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view');
    const focus = params.get('focus');
    return {
      activeTab: view === 'temporal' ? ('temporal' as const) : ('network' as const),
      networkViewMode: view === '2d' ? ('2d' as const) : ('3d' as const),
      initialFocusPath: focus ? decodeURIComponent(focus) : null,
    };
  }, []);

  const [activeTab, setActiveTab] = useState<'network' | 'temporal'>(initialParams.activeTab);
  const [networkViewMode, setNetworkViewMode] = useState<'3d' | '2d'>(initialParams.networkViewMode);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [focusHistory, setFocusHistory] = useState<string[]>([]);
  const [missingFocusPath, setMissingFocusPath] = useState<string | null>(null);
  const [independent2DViewport, setIndependent2DViewport] = useState<Viewport2D>({ panX: 0, panY: 0, zoom: 1.0 });
  const focusResolvedRef = useRef(false);

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
  const selectedNodeRef = useRef(selectedNode);
  selectedNodeRef.current = selectedNode;
  const [selectedEdge, setSelectedEdge] = useState<DependencyEdge | null>(null);
  const [revealRequest, setRevealRequest] = useState<RevealRequest | null>(null);
  const [announcement, setAnnouncement] = useState<string>('');

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

  // Live SSE sync & watcher state
  const [liveRevision, setLiveRevision] = useState<number>(0);
  const [liveNotice, setLiveNotice] = useState<string | null>(null);
  const [watcherHealth, setWatcherHealth] = useState<WatcherHealth>('active');
  const [sseState, setSseState] = useState<'connected' | 'reconnecting' | 'error'>('connected');
  const [isDelayedReconnecting, setIsDelayedReconnecting] = useState(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const latestAppliedRevisionRef = useRef<number>(0);

  // View triggers (true bounding box fit view & reset view)
  const [fitViewCounter, setFitViewCounter] = useState(0);
  const [resetViewCounter, setResetViewCounter] = useState(0);

  // Viewport insets (header floating at top 64px, margins)
  const networkInsets = useMemo<ViewportInsets>(() => ({
    top: 64,
    bottom: 20,
    left: 20,
    right: 20,
  }), []);

  // SSE Reconnecting Grace Period (2.0s delay prevents flashing "Reconnecting..." on brief blips)
  useEffect(() => {
    if (sseState === 'reconnecting') {
      reconnectTimerRef.current = setTimeout(() => {
        setIsDelayedReconnecting(true);
      }, 2000);
    } else {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      setIsDelayedReconnecting(false);
    }
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
    };
  }, [sseState]);

  // 1. Initial session bootstrap & repository info
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const checkStatus = async () => {
      try {
        const repo = await api.getRepository();
        setRepoInfo(repo);
        if (repo.watcher_health) {
          setWatcherHealth(repo.watcher_health);
        }

        const st = await api.getStatus();
        setStatus(st.indexing_status);
        if (st.watcher_health) {
          setWatcherHealth(st.watcher_health);
        }

        if (st.indexing_status === 'Ready') {
          const snap = await api.getNetwork();
          if (snap.revision >= latestAppliedRevisionRef.current) {
            latestAppliedRevisionRef.current = snap.revision;
            setSnapshot(snap);
            setLiveRevision(snap.revision);

            // Resolve initial focus target from CLI or URL parameters
            if (initialParams.initialFocusPath && !focusResolvedRef.current) {
              focusResolvedRef.current = true;
              const targetPath = initialParams.initialFocusPath.trim();
              const matched = snap.nodes.find(
                (n) =>
                  n.relative_path === targetPath ||
                  n.id === targetPath ||
                  n.filename === targetPath ||
                  n.relative_path.toLowerCase() === targetPath.toLowerCase()
              );
              if (matched) {
                setSelectedNode(matched);
                setFocusNodeId(matched.id);
                setMissingFocusPath(null);
              } else {
                setMissingFocusPath(targetPath);
              }
            }
          }
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
      api.getGitStatus().then(setGitStatus).catch(() => { });
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

  // Stable refs for background SSE callbacks without effect churn
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const temporalFilterPathRef = useRef(temporalFilterPath);
  temporalFilterPathRef.current = temporalFilterPath;
  const loadCommitsRef = useRef(loadCommits);
  loadCommitsRef.current = loadCommits;

  // 3. Authenticated Server-Sent Events (SSE) for Live Updates & Reconnection Reconciliation
  useEffect(() => {
    const applySnapshot = (newSnap: GraphSnapshot, changedFiles: string[]) => {
      if (newSnap.revision >= latestAppliedRevisionRef.current) {
        latestAppliedRevisionRef.current = newSnap.revision;
        setSnapshot(newSnap);
        setLiveRevision(newSnap.revision);
        setStatus('Ready');

        // Flash subtle live-update toast
        const fileNotice =
          changedFiles.length > 0 && changedFiles[0] !== '*'
            ? `${changedFiles.length} file(s) updated`
            : 'Graph reanalyzed';
        setLiveNotice(`Live update: ${fileNotice} (rev ${newSnap.revision})`);
        setTimeout(() => setLiveNotice(null), 3500);

        // Re-sync selected node if still exists in the new snapshot
        setSelectedNode((prev) => reconcileSelectedNodeOnSnapshot(prev, newSnap.nodes));
        // Re-sync 2D focus node if still exists; do not auto-select random node on deletion
        setFocusNodeId((prev) => {
          const { nextFocusNodeId, missingNotice } = reconcileFocusNodeOnSnapshot(prev, newSnap.nodes);
          if (missingNotice) setMissingFocusPath(missingNotice);
          return nextFocusNodeId;
        });
      }
    };

    const unsubscribe = api.subscribeToEvents(
      (event: ServerEvent) => {
        setSseState('connected');
        if (event.type === 'network.updated') {
          const { revision, changed_files } = event.data;
          if (revision > latestAppliedRevisionRef.current) {
            api
              .getNetwork()
              .then((newSnap) => applySnapshot(newSnap, changed_files))
              .catch(() => { });
          }
        } else if (event.type === 'git.updated') {
          api.getGitStatus().then(setGitStatus).catch(() => { });
          if (activeTabRef.current === 'temporal') {
            loadCommitsRef.current(temporalFilterPathRef.current);
          }
        } else if (event.type === 'reconcile.required') {
          api.getStatus().then((st) => {
            if (st.watcher_health) setWatcherHealth(st.watcher_health);
            if (st.revision > latestAppliedRevisionRef.current) {
              api
                .getNetwork()
                .then((newSnap) => applySnapshot(newSnap, ['*']))
                .catch(() => { });
            }
          }).catch(() => { });
        }
      },
      (status) => {
        setSseState(status);
        if (status === 'connected') {
          // Re-fetch status on reconnect to reconcile any missed updates
          api.getStatus().then((st) => {
            if (st.watcher_health) setWatcherHealth(st.watcher_health);
            if (st.revision > latestAppliedRevisionRef.current) {
              api
                .getNetwork()
                .then((newSnap) => applySnapshot(newSnap, ['*']))
                .catch(() => { });
            }
          }).catch(() => { });
        }
      }
    );

    return () => {
      unsubscribe();
    };
  }, []); // Run ONCE on mount — eliminates EventSource reconnect churn on every tab/filter/revision update

  // 4. Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const targetTag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      const isInput = targetTag === 'input' || targetTag === 'textarea';
      if (isInput) return;

      if (e.key === 'Escape') {
        setSelectedNode(null);
        setSelectedEdge(null);
        setSelectedCommit(null);
        setRevealRequest(null);
        return;
      }

      if (e.key === '1') {
        setActiveTab('network');
      } else if (e.key === '2') {
        setActiveTab('temporal');
      } else if (e.key === 'v' || e.key === 'V') {
        if (activeTabRef.current === 'network') {
          setNetworkViewMode((prev) => {
            const next = prev === '3d' ? '2d' : '3d';
            const curSelected = selectedNodeRef.current;
            if (next === '2d' && curSelected) {
              setFocusNodeId(curSelected.id);
              setMissingFocusPath(null);
            }
            return next;
          });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Mode switching handlers
  const handleSwitchNetworkMode = useCallback(
    (mode: '3d' | '2d') => {
      if (mode === '2d') {
        if (selectedNode) {
          setFocusNodeId(selectedNode.id);
          setMissingFocusPath(null);
        }
      }
      setNetworkViewMode(mode);
    },
    [selectedNode]
  );

  const handleRefocusNode2D = useCallback(
    (newNodeId: string) => {
      setFocusHistory((prev) => pushFocusHistory(prev, focusNodeId, newNodeId));
      setFocusNodeId(newNodeId);
      setMissingFocusPath(null);
      const node = snapshot?.nodes.find((n) => n.id === newNodeId);
      if (node) {
        setSelectedNode(node);
      }
    },
    [focusNodeId, snapshot]
  );

  const handleBackFocus2D = useCallback(() => {
    const { nextHistory, prevFocusId } = popFocusHistory(focusHistory);
    if (!prevFocusId) return;
    setFocusHistory(nextHistory);
    setFocusNodeId(prevFocusId);
    setMissingFocusPath(null);
    const node = snapshot?.nodes.find((n) => n.id === prevFocusId);
    if (node) {
      setSelectedNode(node);
    }
  }, [focusHistory, snapshot]);

  // URL synchronization: updates view and focus parameters using history.replaceState
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (activeTab === 'temporal') {
      params.set('view', 'temporal');
      params.delete('focus');
    } else {
      params.set('view', networkViewMode);
      if (networkViewMode === '2d') {
        const focused = snapshot?.nodes.find((n) => n.id === focusNodeId);
        if (focused) {
          params.set('focus', focused.relative_path);
        } else if (missingFocusPath) {
          params.set('focus', missingFocusPath);
        } else {
          params.delete('focus');
        }
      } else {
        if (selectedNode) {
          params.set('focus', selectedNode.relative_path);
        } else {
          params.delete('focus');
        }
      }
    }
    const newSearch = params.toString();
    const cleanUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash;
    window.history.replaceState({}, '', cleanUrl);
  }, [activeTab, networkViewMode, focusNodeId, selectedNode, snapshot, missingFocusPath]);

  // Selection handlers (Decoupled from camera focus!)
  const handleSelectNode = useCallback(
    (node: FileNode | null, options?: { reveal?: boolean }) => {
      setSelectedNode(node);
      setSelectedEdge(null);
      if (node && options?.reveal) {
        setRevealRequest({
          nodeId: node.id,
          timestamp: performance.now(),
          onlyIfOutside: true,
        });
      }
    },
    []
  );

  const handleExplicitRevealNode = useCallback((nodeId: string) => {
    setRevealRequest({
      nodeId,
      timestamp: performance.now(),
      onlyIfOutside: false,
    });
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
    setRevealRequest({
      nodeId: node.id,
      timestamp: performance.now(),
      onlyIfOutside: false,
    });
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

          {/* Live Watcher & SSE Stream Status (Decoupled & Grace Period aware) */}
          {(() => {
            const statusInfo = resolveWatcherStatusInfo(
              watcherHealth,
              sseState,
              liveRevision,
              isDelayedReconnecting
            );

            return (
              <div
                className="live-watcher-badge"
                title={statusInfo.text}
                role="status"
                aria-label={statusInfo.text}
              >
                <Radio
                  size={12}
                  className={statusInfo.pulse ? 'pulse-icon' : ''}
                  color={statusInfo.color}
                />
                <span>{statusInfo.text}</span>
              </div>
            );
          })()}

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
              onSelectNode={(node, options) => {
                handleSelectNode(node, options);
                if (networkViewMode === '2d' && node) {
                  setFocusNodeId(node.id);
                  setMissingFocusPath(null);
                }
              }}
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

          {activeTab === 'network' && (
            <div className="network-mode-switcher" role="radiogroup" aria-label="Network View Mode">
              <button
                className={`mode-btn ${networkViewMode === '3d' ? 'active' : ''}`}
                onClick={() => handleSwitchNetworkMode('3d')}
                title="3D Repository Overview (Shortcut: V)"
                role="radio"
                aria-checked={networkViewMode === '3d'}
              >
                <Layers size={14} />
                <span>3D Overview</span>
              </button>
              <button
                className={`mode-btn ${networkViewMode === '2d' ? 'active' : ''}`}
                onClick={() => handleSwitchNetworkMode('2d')}
                title="Contextual 2D Relationship Explorer (Shortcut: V)"
                role="radio"
                aria-checked={networkViewMode === '2d'}
              >
                <Compass size={14} />
                <span>2D Relationships</span>
              </button>
            </div>
          )}

          <div className="view-controls">
            <button
              className="ctrl-btn"
              onClick={() => setFitViewCounter((c) => c + 1)}
              title={networkViewMode === '2d' ? 'Fit 2D Relationship View' : 'Fit View to All Nodes'}
            >
              <Maximize2 size={15} />
              <span>Fit View</span>
            </button>
            <button
              className="ctrl-btn"
              onClick={() => {
                setResetViewCounter((c) => c + 1);
              }}
              title={networkViewMode === '2d' ? 'Reset 2D Camera' : 'Reset Camera to Standard 3D View'}
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
            ) : networkViewMode === '3d' ? (
              <NetworkCanvas
                snapshot={snapshot}
                selectedNodeId={selectedNode?.id || null}
                selectedEdgeId={selectedEdge?.id || null}
                onSelectNode={handleSelectNode}
                onSelectEdge={handleSelectEdge}
                revealRequest={revealRequest}
                fitViewTrigger={fitViewCounter}
                resetViewTrigger={resetViewCounter}
                insets={networkInsets}
                onAnnounce={setAnnouncement}
              />
            ) : (
              <RelationshipCanvas
                snapshot={snapshot}
                focusNodeId={focusNodeId}
                selectedNodeId={selectedNode?.id || null}
                selectedEdgeId={selectedEdge?.id || null}
                onSelectNode={handleSelectNode}
                onSelectEdge={handleSelectEdge}
                onRefocusNode={handleRefocusNode2D}
                onBackFocus={handleBackFocus2D}
                canGoBack={focusHistory.length > 0}
                backTargetName={resolveBackTargetName(focusHistory, snapshot.nodes)}
                fitViewTrigger={fitViewCounter}
                resetViewTrigger={resetViewCounter}
                initialViewport={independent2DViewport}
                onViewportChange={setIndependent2DViewport}
                missingFocusPath={missingFocusPath}
                theme={theme}
                onAnnounce={setAnnouncement}
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
          onRevealNode={handleExplicitRevealNode}
          networkViewMode={networkViewMode}
          focusNodeId={focusNodeId}
          onExplore2D={(node) => {
            handleSwitchNetworkMode('2d');
            setFocusNodeId(node.id);
            setSelectedNode(node);
          }}
          onRefocus2D={handleRefocusNode2D}
          onSwitchTo3D={() => handleSwitchNetworkMode('3d')}
        />
      )}

      {/* Screen Reader Live Region for Accessibility Announcements */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
};

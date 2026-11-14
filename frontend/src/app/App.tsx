import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { DependencyEdge, FileNode, GraphSnapshot, RepositoryInfo, WatcherHealth, ViewportInsets } from '../types/graph';
import { CommitSummary, GitStatus, ServerEvent } from '../types/temporal';
import { api, initSession, defaultNetworkCoordinator } from '../transport/api';
import { NetworkCanvas, RevealRequest } from '../graphs/network/NetworkCanvas';
import { RelationshipCanvas, Viewport2D } from '../graphs/relationship/RelationshipCanvas';
import {
  resolveWatcherStatusInfo,
  reconcileSelectedNodeOnSnapshot,
  reconcileSelectedEdgeOnSnapshot,
  reconcileSelectedAreaOnSnapshot,
} from '../transport/statusInfo';
import {
  reconcileFocusNodeOnSnapshot,
  reconcileFocusHistoryOnSnapshot,
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
  Target,
  PanelRightOpen,
} from 'lucide-react';
import './App.css';

export interface InitialUrlParams {
  activeTab: 'network' | 'temporal';
  networkViewMode: '2d' | '3d';
  initialFocusPath: string | null;
}

export function parseInitialUrlParams(search: string): InitialUrlParams {
  try {
    const params = new URLSearchParams(search);
    const view = params.get('view');
    const focus = params.get('focus');
    return {
      activeTab: view === 'temporal' ? ('temporal' as const) : ('network' as const),
      networkViewMode: view === '2d' ? ('2d' as const) : ('3d' as const),
      initialFocusPath: focus || null,
    };
  } catch {
    return {
      activeTab: 'network' as const,
      networkViewMode: '3d' as const,
      initialFocusPath: null,
    };
  }
}

/**
 * Resolves the initial focus node from the requested focus path against snapshot nodes.
 * Preserves exact whitespace (leading, trailing, and internal) so filenames or paths
 * with whitespace are not stripped or corrupted.
 */
export function resolveInitialFocusNode(
  targetPath: string | null | undefined,
  nodes: readonly FileNode[]
): FileNode | null {
  if (!targetPath) return null;
  return (
    nodes.find(
      (n) =>
        n.relative_path === targetPath ||
        n.id === targetPath ||
        n.filename === targetPath ||
        n.relative_path.toLowerCase() === targetPath.toLowerCase()
    ) || null
  );
}

export interface KeyboardShortcutTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (attr: string) => string | null;
}

export interface KeyboardShortcutEventLike {
  target?: EventTarget | KeyboardShortcutTargetLike | null;
  key?: string;
  isComposing?: boolean;
  keyCode?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

export function shouldIgnoreGlobalShortcut(e: KeyboardShortcutEventLike): boolean {
  const target = e.target as (KeyboardShortcutTargetLike & { isContentEditable?: boolean }) | null | undefined;
  if (!target) return true;
  const targetTag = (target as HTMLElement).tagName?.toLowerCase();
  const isEditable =
    targetTag === 'input' ||
    targetTag === 'textarea' ||
    targetTag === 'select' ||
    Boolean(target.isContentEditable) ||
    target.getAttribute?.('contenteditable') === 'true' ||
    target.getAttribute?.('role') === 'textbox';
  if (isEditable) return true;

  if (e.isComposing || e.keyCode === 229) return true;

  return false;
}

export function hasModifierCombination(e: KeyboardShortcutEventLike): boolean {
  return Boolean(e.metaKey || e.ctrlKey || e.altKey);
}

export const App: React.FC = () => {
  // Read initial view and focus from URL (?view=temporal | ?view=2d | ?view=3d, ?focus=<path>)
  const initialParams = useMemo(() => {
    return parseInitialUrlParams(typeof window !== 'undefined' ? window.location.search : '');
  }, []);

  const [activeTab, setActiveTab] = useState<'network' | 'temporal'>(initialParams.activeTab);
  const [networkViewMode, setNetworkViewMode] = useState<'3d' | '2d'>(initialParams.networkViewMode);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [focusHistory, setFocusHistory] = useState<string[]>([]);
  const [missingFocusPath, setMissingFocusPath] = useState<string | null>(null);
  const [independent2DViewport, setIndependent2DViewport] = useState<Viewport2D>({ panX: 0, panY: 0, zoom: 1.0 });
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const focusResolvedRef = useRef(false);
  const liveNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLiveNoticeTimeRef = useRef<number>(0);
  const commitsRequestTokenRef = useRef(0);
  const commitsAbortControllerRef = useRef<AbortController | null>(null);

  // Theme state
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const stored = localStorage.getItem('prebase_theme');
    return stored === 'light' ? 'light' : 'dark';
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
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  const [revealRequest, setRevealRequest] = useState<RevealRequest | null>(null);
  const [keepGraphCentered, setKeepGraphCentered] = useState(true);
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
  const [sessionInitialized, setSessionInitialized] = useState(false);
  const [liveRevision, setLiveRevision] = useState<number>(0);
  const [liveNotice, setLiveNotice] = useState<string | null>(null);
  const [watcherHealth, setWatcherHealth] = useState<WatcherHealth>('active');
  const [sseState, setSseState] = useState<'connected' | 'reconnecting' | 'error'>('connected');
  const [isDelayedReconnecting, setIsDelayedReconnecting] = useState(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const coordinator = defaultNetworkCoordinator;

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
          if (coordinator.shouldApplySnapshot(snap.revision)) {
            coordinator.recordAppliedRevision(snap.revision);
            setSnapshot(snap);
            setLiveRevision(snap.revision);

            // Resolve initial focus target from CLI or URL parameters
            if (initialParams.initialFocusPath && !focusResolvedRef.current) {
              focusResolvedRef.current = true;
              const targetPath = initialParams.initialFocusPath;
              const matched = resolveInitialFocusNode(targetPath, snap.nodes);
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
    initSession()
      .then((initRes) => {
        setSessionInitialized(true);
        if (!initRes.success) {
          if (initRes.isAuthError) {
            setError(
              initRes.error ||
              'Authentication failed: bootstrap token invalid or already consumed. Please check your terminal and use the URL printed under "Server running at".'
            );
          } else {
            setError(
              initRes.error ||
              'Could not reach local server. Please verify PreBase is running in your terminal.'
            );
          }
          return;
        }
        checkStatus();
        api.getGitStatus().then(setGitStatus).catch(() => { });
      })
      .catch((err) => {
        setSessionInitialized(true);
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Failed to initialize session: ${msg}`);
      });

    return () => clearTimeout(timer);
  }, []);

  const showLiveNotice = useCallback((message: string, duration = 3500) => {
    const now = Date.now();
    // ponytail: throttle rapid notification churn to prevent visual and screen-reader flooding
    if (now - lastLiveNoticeTimeRef.current < 1500 && liveNoticeTimerRef.current) {
      return;
    }
    lastLiveNoticeTimeRef.current = now;
    if (liveNoticeTimerRef.current) clearTimeout(liveNoticeTimerRef.current);
    setLiveNotice(message);
    liveNoticeTimerRef.current = setTimeout(() => {
      setLiveNotice(null);
      liveNoticeTimerRef.current = null;
    }, duration);
  }, []);

  useEffect(() => {
    return () => {
      if (liveNoticeTimerRef.current) clearTimeout(liveNoticeTimerRef.current);
      if (commitsAbortControllerRef.current) commitsAbortControllerRef.current.abort();
    };
  }, []);

  // 2. Fetch Git commit history with anchor pagination
  const loadCommits = useCallback(async (filterPath?: string | null) => {
    const currentToken = ++commitsRequestTokenRef.current;
    if (commitsAbortControllerRef.current) {
      commitsAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    commitsAbortControllerRef.current = controller;

    setTemporalLoading(true);
    try {
      if (filterPath) {
        const res = await api.getFileHistory(filterPath, 100, controller.signal);
        if (currentToken !== commitsRequestTokenRef.current) return;
        setCommits(res.commits);
        setNextCursor(null);
        setHasMoreCommits(false);
        setTotalCommits(res.commits.length);
      } else {
        const res = await api.getHistory(50, null, controller.signal);
        if (currentToken !== commitsRequestTokenRef.current) return;
        setCommits(res.commits);
        setNextCursor(res.next_cursor);
        setHasMoreCommits(res.has_more);
        setTotalCommits(res.total_commits);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      if (currentToken !== commitsRequestTokenRef.current) return;
      setCommits([]);
      setNextCursor(null);
      setHasMoreCommits(false);
      setTotalCommits(null);
    } finally {
      if (currentToken === commitsRequestTokenRef.current) {
        setTemporalLoading(false);
      }
    }
  }, []);

  const handleLoadMoreCommits = useCallback(async () => {
    if (!nextCursor || isLoadingMore) return;
    const currentToken = ++commitsRequestTokenRef.current;
    setIsLoadingMore(true);
    try {
      const res = await api.getHistory(50, nextCursor);
      if (currentToken !== commitsRequestTokenRef.current) return;
      setCommits((prev) => [...prev, ...res.commits]);
      setNextCursor(res.next_cursor);
      setHasMoreCommits(res.has_more);
      setTotalCommits(res.total_commits);
    } catch (err: unknown) {
      if (currentToken !== commitsRequestTokenRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('410') || msg.includes('StaleCursor')) {
        showLiveNotice('Commit history updated on disk. Reloading history from HEAD...');
        loadCommits(temporalFilterPath);
      }
    } finally {
      if (currentToken === commitsRequestTokenRef.current) {
        setIsLoadingMore(false);
      }
    }
  }, [nextCursor, isLoadingMore, loadCommits, temporalFilterPath, showLiveNotice]);

  // Load commits when active tab is temporal or filter changes (gated by session initialization)
  useEffect(() => {
    if (sessionInitialized && !error && activeTab === 'temporal') {
      loadCommits(temporalFilterPath);
    }
  }, [sessionInitialized, error, activeTab, temporalFilterPath, loadCommits]);

  // Stable refs for background SSE callbacks without effect churn
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const temporalFilterPathRef = useRef(temporalFilterPath);
  temporalFilterPathRef.current = temporalFilterPath;
  const loadCommitsRef = useRef(loadCommits);
  loadCommitsRef.current = loadCommits;

  // 3. Authenticated Server-Sent Events (SSE) for Live Updates & Reconnection Reconciliation
  useEffect(() => {
    if (!sessionInitialized) return;

    const applySnapshot = (newSnap: GraphSnapshot, changedFiles: string[]) => {
      if (coordinator.shouldApplySnapshot(newSnap.revision)) {
        coordinator.recordAppliedRevision(newSnap.revision);
        setSnapshot(newSnap);
        setLiveRevision(newSnap.revision);
        setStatus('Ready');

        // Flash subtle live-update toast
        const fileNotice =
          changedFiles.length > 0 && changedFiles[0] !== '*'
            ? `${changedFiles.length} file(s) updated`
            : 'Graph reanalyzed';
        showLiveNotice(`Live update: ${fileNotice} (rev ${newSnap.revision})`);

        // Re-sync selected node if still exists in the new snapshot
        setSelectedNode((prev) => reconcileSelectedNodeOnSnapshot(prev, newSnap.nodes));
        // Re-sync selected edge if still exists in the new snapshot (reconciles stale evidence)
        setSelectedEdge((prev) => reconcileSelectedEdgeOnSnapshot(prev, newSnap.edges));
        // Re-sync selected area if still has files in the new snapshot
        setSelectedAreaId((prev) => reconcileSelectedAreaOnSnapshot(prev, newSnap.nodes));
        // Re-sync 2D focus node if still exists; do not auto-select random node on deletion
        setFocusNodeId((prev) => {
          const { nextFocusNodeId, missingNotice } = reconcileFocusNodeOnSnapshot(prev, newSnap.nodes);
          if (missingNotice) setMissingFocusPath(missingNotice);
          return nextFocusNodeId;
        });
        // Re-sync 2D focus history by pruning entries deleted on disk
        setFocusHistory((prev) => reconcileFocusHistoryOnSnapshot(prev, newSnap.nodes));

        // If a newer revision was announced while this network fetch was in flight,
        // trigger follow-up fetch so the UI never remains on a stale snapshot
        if (coordinator.hasPendingNewerRevision()) {
          api
            .getNetwork()
            .then((newerSnap) => applySnapshot(newerSnap, ['*']))
            .catch(() => { });
        }
      }
    };

    const unsubscribe = api.subscribeToEvents(
      (event: ServerEvent) => {
        setSseState('connected');
        if (event.type === 'network.updated') {
          const { revision, changed_files } = event.data;
          if (coordinator.shouldProcessSseEvent(revision)) {
            coordinator.recordObservedEventRevision(revision);
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
            if (coordinator.shouldApplySnapshot(st.revision)) {
              coordinator.recordObservedEventRevision(st.revision);
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
            if (coordinator.shouldApplySnapshot(st.revision)) {
              coordinator.recordObservedEventRevision(st.revision);
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
  }, [sessionInitialized]); // Subscribes once session token is initialized

  // 4. Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 1. Ignore if typing in editable element, dialog, or during IME composition
      if (shouldIgnoreGlobalShortcut(e)) return;

      // 2. Escape key clears selection
      if (e.key === 'Escape') {
        setSelectedNode(null);
        setSelectedEdge(null);
        setSelectedCommit(null);
        setRevealRequest(null);
        return;
      }

      // 3. Do not hijack browser shortcuts or modifier key combinations (Cmd/Ctrl/Alt)
      if (hasModifierCombination(e)) return;

      if (e.key === 'c' || e.key === 'C') {
        if (activeTabRef.current === 'network') {
          setKeepGraphCentered((prev) => {
            const next = !prev;
            setAnnouncement(next ? 'Keep centered on' : 'Keep centered off');
            return next;
          });
        }
      } else if (e.key === '1') {
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
    let remaining = [...focusHistory];
    while (remaining.length > 0) {
      const { nextHistory, prevFocusId } = popFocusHistory(remaining);
      remaining = nextHistory;
      if (prevFocusId) {
        const node = snapshot?.nodes.find((n) => n.id === prevFocusId);
        if (node) {
          setFocusHistory(remaining);
          setFocusNodeId(prevFocusId);
          setSelectedNode(node);
          setSelectedEdge(null);
          setMissingFocusPath(null);
          return;
        }
      }
    }
    setFocusHistory([]);
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
      if (node) {
        setSelectedEdge(null);
      }
      if (node && options?.reveal) {
        setRevealRequest({
          nodeId: node.id,
          timestamp: performance.now(),
          onlyIfOutside: false,
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
    if (edge) {
      setSelectedNode(null);
    }
  }, []);

  const handleSelectArea = useCallback((areaId: string | null) => {
    setSelectedAreaId(areaId);
    if (areaId) {
      setSelectedNode(null);
      setSelectedEdge(null);
    }
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
            {activeTab === 'network' && networkViewMode === '3d' && (
              <button
                id="centerLock"
                className={`ctrl-btn ${keepGraphCentered ? 'active' : ''}`}
                onClick={() => {
                  setKeepGraphCentered((prev) => {
                    const next = !prev;
                    setAnnouncement(next ? 'Keep centered on' : 'Keep centered off');
                    return next;
                  });
                }}
                title={keepGraphCentered ? 'Keep graph centered (Active) (Shortcut: C)' : 'Keep graph centered (Shortcut: C)'}
                role="checkbox"
                aria-checked={keepGraphCentered}
                aria-pressed={keepGraphCentered}
              >
                <Target size={15} />
                <span>{keepGraphCentered ? 'Centered' : 'Center Lock'}</span>
              </button>
            )}
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
          <div className="live-toast" role="status" aria-live="polite">
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
        {error ? (
          <div className="graph-container">
            <div className="error-overlay">
              <AlertCircle size={32} color="#ef4444" />
              <h3>{error.includes('Authentication') ? 'Authentication Required' : 'Unable to load graph'}</h3>
              <p>{error}</p>
              <button
                className="primary-btn history-retry-btn"
                onClick={() => window.location.reload()}
                style={{ marginTop: '12px' }}
              >
                Retry Connection
              </button>
            </div>
          </div>
        ) : activeTab === 'network' ? (
          <div className="graph-container">
            {!snapshot ? (
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
              <>
                <div className="graph-mode-stage" style={{ position: 'relative', width: '100%', height: '100%' }}>
                  <div
                    className={`canvas-view-layer ${networkViewMode === '3d' ? 'active' : 'inactive'}`}
                    aria-hidden={networkViewMode !== '3d'}
                  >
                    <NetworkCanvas
                      snapshot={snapshot}
                      selectedNodeId={selectedNode?.id || null}
                      selectedEdgeId={selectedEdge?.id || null}
                      selectedAreaId={selectedAreaId}
                      onSelectNode={handleSelectNode}
                      onSelectEdge={handleSelectEdge}
                      revealRequest={revealRequest}
                      fitViewTrigger={fitViewCounter}
                      resetViewTrigger={resetViewCounter}
                      keepGraphCentered={keepGraphCentered}
                      onToggleCenterLock={() => setKeepGraphCentered((prev) => !prev)}
                      isVisible={networkViewMode === '3d'}
                      insets={networkInsets}
                      onAnnounce={setAnnouncement}
                      theme={theme}
                    />
                  </div>
                  <div
                    className={`canvas-view-layer ${networkViewMode === '2d' ? 'active' : 'inactive'}`}
                    aria-hidden={networkViewMode !== '2d'}
                  >
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
                      isVisible={networkViewMode === '2d'}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="graph-container">
            {temporalLoading ? (
              <div className="loading-overlay">
                <Loader2 size={36} className="spinner" color="#38bdf8" />
                <h3>Loading commit history...</h3>
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
                  theme={theme}
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

      {/* 3. Right Inspector (Network Inspector or Temporal Commit Inspector / Overview) */}
      {activeTab === 'temporal' ? (
        <CommitInspector
          selectedCommit={selectedCommit}
          snapshot={snapshot}
          onClose={() => setSelectedCommit(null)}
          onNavigateToNetwork={handleNavigateToNetwork}
          isCollapsed={inspectorCollapsed}
          onToggleCollapse={() => setInspectorCollapsed((c) => !c)}
          gitStatus={gitStatus}
          totalCommits={totalCommits}
          loadedCommitsCount={commits.length}
          temporalFilterPath={temporalFilterPath}
          onClearFilter={() => setTemporalFilterPath(null)}
        />
      ) : (
        <Inspector
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          selectedAreaId={selectedAreaId}
          onSelectArea={handleSelectArea}
          snapshot={snapshot}
          onSelectNode={handleSelectNode}
          onClose={() => {
            setSelectedNode(null);
            setSelectedEdge(null);
            setSelectedAreaId(null);
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
          isCollapsed={inspectorCollapsed}
          onToggleCollapse={() => setInspectorCollapsed((c) => !c)}
        />
      )}

      {/* Floating Reopen Inspector Button when Collapsed */}
      {inspectorCollapsed && (
        <button
          className="inspector-reopen-btn"
          onClick={() => setInspectorCollapsed(false)}
          title="Open inspector"
          aria-label="Open inspector"
        >
          <PanelRightOpen size={14} />
          <span>Inspect</span>
        </button>
      )}

      {/* Screen Reader Live Region for Accessibility Announcements */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
};

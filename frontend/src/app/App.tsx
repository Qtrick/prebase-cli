import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  DependencyEdge,
  FileNode,
  GraphSnapshot,
  RepositoryInfo,
  WatcherHealth,
  ViewportInsets,
  CycleGroup,
  DependencyPathResult,
} from '../types/graph';
import { CommitSummary, GitStatus, ServerEvent } from '../types/temporal';
import { api, initSession, defaultNetworkCoordinator } from '../transport/api';
import { registerWorkspaceNavigateHandler } from '../transport/workspaceNavigation';
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
import { AreaEdge } from '../utils/repositoryAreas';
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
  Download,
  Filter,
  SlidersHorizontal,
  ChevronDown,
  Check,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { PreBaseMark } from './PreBaseMark';
import {
  readHideGroupLabelsPreference,
  writeHideGroupLabelsPreference,
} from '../utils/graphPreferences';
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
 * Resolves the initial focus node from the requested focus path against snapshot nodes
 * using strict deterministic precedence:
 * 1. Exact canonical relative path or canonical file ID match.
 * 2. Case-insensitive relative path match (only if unambiguous).
 * 3. Exact filename match (only if unambiguous).
 * 4. Case-insensitive filename match (only if unambiguous).
 * Preserves exact whitespace and Unicode so paths with whitespace are not corrupted.
 */
export function resolveInitialFocusNode(
  targetPath: string | null | undefined,
  nodes: readonly FileNode[]
): FileNode | null {
  if (!targetPath) return null;

  // 1. Exact canonical relative path or exact file ID match
  const exact = nodes.find(
    (n) => n.relative_path === targetPath || n.id === targetPath
  );
  if (exact) return exact;

  // 2. Case-insensitive relative path match (only if unambiguous)
  const targetLower = targetPath.toLowerCase();
  const caseInsensitiveMatches = nodes.filter(
    (n) => n.relative_path.toLowerCase() === targetLower
  );
  if (caseInsensitiveMatches.length === 1) {
    return caseInsensitiveMatches[0];
  }

  // 3. Exact filename match (only if unambiguous)
  const filenameMatches = nodes.filter((n) => n.filename === targetPath);
  if (filenameMatches.length === 1) {
    return filenameMatches[0];
  }

  // 4. Case-insensitive filename match (only if unambiguous)
  const filenameLowerMatches = nodes.filter(
    (n) => n.filename.toLowerCase() === targetLower
  );
  if (filenameLowerMatches.length === 1) {
    return filenameLowerMatches[0];
  }

  return null;
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
  const pendingNavFocusRef = useRef<string | null>(null);
  const liveNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLiveNoticeTimeRef = useRef<number>(0);
  const commitsRequestTokenRef = useRef(0);
  const commitsAbortControllerRef = useRef<AbortController | null>(null);

  // Theme state
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const stored = localStorage.getItem('prebase_theme');
    return stored === 'light' ? 'light' : 'dark';
  });

  // 3D Network Graph preference: hide group labels while holding the graph
  const [hideGroupLabelsOnMovement, setHideGroupLabelsOnMovement] = useState<boolean>(() =>
    readHideGroupLabelsPreference()
  );

  const toggleHideGroupLabelsOnMovement = useCallback(() => {
    setHideGroupLabelsOnMovement((prev) => {
      const next = !prev;
      writeHideGroupLabelsPreference(next);
      return next;
    });
  }, []);

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
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [status, setStatus] = useState<string>('Scanning');
  const [error, setError] = useState<string | null>(null);

  const [selectedNode, setSelectedNode] = useState<FileNode | null>(null);
  const selectedNodeRef = useRef(selectedNode);
  selectedNodeRef.current = selectedNode;
  const [selectedEdge, setSelectedEdge] = useState<DependencyEdge | null>(null);
  const [selectedAreaEdge, setSelectedAreaEdge] = useState<AreaEdge | null>(null);
  const [selectedAreaIds, setSelectedAreaIds] = useState<string[]>([]);
  const selectedAreaId = selectedAreaIds.length === 1 ? selectedAreaIds[0] : null;
  const [selectedLanguageFilter, setSelectedLanguageFilter] = useState<'all' | 'typescript' | 'rust' | 'python'>('all');
  const [sourceOnlyFilter, setSourceOnlyFilter] = useState<boolean>(false);
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
  const [temporalError, setTemporalError] = useState<string | null>(null);

  // Live SSE sync & watcher state
  const [sessionInitialized, setSessionInitialized] = useState(false);
  const [liveRevision, setLiveRevision] = useState<number>(0);
  const [liveNotice, setLiveNotice] = useState<string | null>(null);
  const [watcherHealth, setWatcherHealth] = useState<WatcherHealth>('active');
  const [sseState, setSseState] = useState<'connected' | 'reconnecting' | 'error'>('connected');
  const [isDelayedReconnecting, setIsDelayedReconnecting] = useState(false);
  const [reconciliationFailed, setReconciliationFailed] = useState(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const coordinator = defaultNetworkCoordinator;

  // View triggers (true bounding box fit view & reset view & zoom)
  const [fitViewCounter, setFitViewCounter] = useState(0);
  const [resetViewCounter, setResetViewCounter] = useState(0);
  const [zoomInCounter, setZoomInCounter] = useState(0);
  const [zoomOutCounter, setZoomOutCounter] = useState(0);

  // Viewport insets (header is now in normal document flow; uniform stage margins)
  const networkInsets = useMemo<ViewportInsets>(() => ({
    top: 20,
    bottom: 20,
    left: 20,
    right: 20,
  }), []);

  // Path Explorer & Cycle Group state
  const [selectedCycleGroup, setSelectedCycleGroup] = useState<CycleGroup | null>(null);
  const [activeDependencyPath, setActiveDependencyPath] = useState<DependencyPathResult | null>(null);
  const [isPathExplorerOpen, setIsPathExplorerOpen] = useState(false);
  const [pathExplorerSourceNode, setPathExplorerSourceNode] = useState<FileNode | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);

  // Toolbar menus state
  const [isFilterMenuOpen, setIsFilterMenuOpen] = useState(false);
  const [isViewMenuOpen, setIsViewMenuOpen] = useState(false);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const viewMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (filterMenuRef.current && !filterMenuRef.current.contains(e.target as Node)) {
        setIsFilterMenuOpen(false);
      }
      if (viewMenuRef.current && !viewMenuRef.current.contains(e.target as Node)) {
        setIsViewMenuOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsFilterMenuOpen(false);
        setIsViewMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleEscape);
    };
  }, []);

  // Compute highlighted nodes and edges for Path Explorer and Cycle Group Focus
  const highlightedNodeIds = useMemo<Set<string> | undefined>(() => {
    if (selectedCycleGroup) {
      return new Set(selectedCycleGroup.files);
    }
    if (activeDependencyPath?.status === 'found') {
      return new Set(activeDependencyPath.path.nodes);
    }
    return undefined;
  }, [selectedCycleGroup, activeDependencyPath]);

  const highlightedEdgeIds = useMemo<Set<string> | undefined>(() => {
    if (activeDependencyPath?.status === 'found') {
      return new Set(activeDependencyPath.path.edges.map((e) => e.id));
    }
    return undefined;
  }, [activeDependencyPath]);

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
    let cancelled = false;

    const checkStatus = async () => {
      try {
        const repo = await api.getRepository();
        if (cancelled) return;
        setRepoInfo(repo);
        if (repo.watcher_health) {
          setWatcherHealth(repo.watcher_health);
        }

        const st = await api.getStatus();
        if (cancelled) return;
        setStatus(st.indexing_status);
        if (st.watcher_health) {
          setWatcherHealth(st.watcher_health);
        }

        if (st.indexing_status === 'Ready') {
          const snap = await api.getNetwork();
          if (cancelled) return;
          if (applySnapshotRef.current) {
            applySnapshotRef.current(snap, ['*']);
          } else if (coordinator.shouldApplySnapshot(snap.revision)) {
            coordinator.recordAppliedRevision(snap.revision);
            setSnapshot(snap);
            setLiveRevision(snap.revision);

            // Resolve initial or queued CLI navigation focus target once snapshot is available
            const targetPath = pendingNavFocusRef.current ?? initialParams.initialFocusPath;
            if (targetPath && !focusResolvedRef.current) {
              focusResolvedRef.current = true;
              pendingNavFocusRef.current = null;
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
          if (!cancelled) {
            setError('Repository analysis failed. Please check CLI terminal output.');
          }
        } else {
          if (!cancelled) {
            timer = setTimeout(checkStatus, 700);
          }
        }
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Failed to connect to local server: ${msg}`);
      }
    };

    // Initialize session from bootstrap token first, then start fetching
    initSession()
      .then((initRes) => {
        if (cancelled) return;
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
        setSessionInitialized(true);
        checkStatus();
        api.getGitStatus().then((gs) => {
          if (!cancelled) setGitStatus(gs);
        }).catch(() => { });
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Failed to initialize session: ${msg}`);
      });

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
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

  const reconciliationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (liveNoticeTimerRef.current) clearTimeout(liveNoticeTimerRef.current);
      if (commitsAbortControllerRef.current) commitsAbortControllerRef.current.abort();
      if (reconciliationTimerRef.current) clearTimeout(reconciliationTimerRef.current);
      coordinator.reset();
    };
  }, [coordinator]);

  // 2. Fetch Git commit history with anchor pagination
  const loadCommits = useCallback(async (filterPath?: string | null, isBackground = false) => {
    // Clear isLoadingMore so superseding loadCommits never leaves pagination disabled
    setIsLoadingMore(false);
    const currentToken = ++commitsRequestTokenRef.current;
    if (commitsAbortControllerRef.current) {
      commitsAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    commitsAbortControllerRef.current = controller;

    if (!isBackground) {
      setTemporalLoading(true);
    }
    setTemporalError(null);
    try {
      if (filterPath) {
        const res = await api.getFileHistory(filterPath, 50, null, controller.signal);
        if (currentToken !== commitsRequestTokenRef.current) return;
        setCommits(res.commits);
        setNextCursor(res.next_cursor || null);
        setHasMoreCommits(res.has_more ?? false);
        setTotalCommits(res.total_commits ?? res.commits.length);
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
      const msg = err instanceof Error ? err.message : String(err);
      // Defect G: Preserve existing commits during temporary error; do not wipe out history
      setTemporalError(msg);
    } finally {
      if (currentToken === commitsRequestTokenRef.current) {
        setTemporalLoading(false);
        setIsLoadingMore(false);
      }
    }
  }, []);

  const handleLoadMoreCommits = useCallback(async () => {
    if (!nextCursor || isLoadingMore) return;
    if (commitsAbortControllerRef.current) {
      commitsAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    commitsAbortControllerRef.current = controller;
    const currentToken = ++commitsRequestTokenRef.current;
    setIsLoadingMore(true);
    try {
      if (temporalFilterPath) {
        const res = await api.getFileHistory(temporalFilterPath, 50, nextCursor, controller.signal);
        if (currentToken !== commitsRequestTokenRef.current) return;
        setCommits((prev) => [...prev, ...res.commits]);
        setNextCursor(res.next_cursor || null);
        setHasMoreCommits(res.has_more ?? false);
        setTotalCommits(res.total_commits ?? null);
      } else {
        const res = await api.getHistory(50, nextCursor, controller.signal);
        if (currentToken !== commitsRequestTokenRef.current) return;
        setCommits((prev) => [...prev, ...res.commits]);
        setNextCursor(res.next_cursor);
        setHasMoreCommits(res.has_more);
        setTotalCommits(res.total_commits);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      if (currentToken !== commitsRequestTokenRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('410') || msg.includes('StaleCursor')) {
        showLiveNotice('Commit history updated on disk. Reloading history from HEAD...');
        setIsLoadingMore(false);
        loadCommits(temporalFilterPath);
        return;
      }
      setTemporalError(`Failed to load older commits: ${msg}`);
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
  const reconciliationAttemptsRef = useRef(0);

  // Bounded snapshot reconciliation with exponential backoff after failed fetch or network drop
  const scheduleSnapshotReconciliation = useCallback(() => {
    if (reconciliationTimerRef.current) return;
    const attempt = reconciliationAttemptsRef.current;
    if (attempt >= 10) {
      setReconciliationFailed(true);
      setIsUpdating(false);
      return;
    }
    const delay = Math.min(8000, 200 * Math.pow(1.5, Math.min(attempt, 6)));

    reconciliationTimerRef.current = setTimeout(() => {
      reconciliationTimerRef.current = null;
      api
        .getStatus()
        .then((st) => {
          if (st.watcher_health) setWatcherHealth(st.watcher_health);
          if (coordinator.shouldApplySnapshot(st.revision)) {
            setIsUpdating(true);
            coordinator.recordObservedEventRevision(st.revision);
            api
              .getNetwork()
              .then((newSnap) => {
                applySnapshotRef.current?.(newSnap, ['*']);
                if (coordinator.isConverged()) {
                  reconciliationAttemptsRef.current = 0;
                  setReconciliationFailed(false);
                  setIsUpdating(false);
                } else {
                  reconciliationAttemptsRef.current++;
                  if (reconciliationAttemptsRef.current < 10) {
                    scheduleSnapshotReconciliation();
                  } else {
                    setReconciliationFailed(true);
                    setIsUpdating(false);
                  }
                }
              })
              .catch(() => {
                reconciliationAttemptsRef.current++;
                if (reconciliationAttemptsRef.current < 10) {
                  scheduleSnapshotReconciliation();
                } else {
                  setReconciliationFailed(true);
                  setIsUpdating(false);
                }
              });
          } else {
            // Server revision already applied or not newer
            if (coordinator.isConverged()) {
              reconciliationAttemptsRef.current = 0;
              setReconciliationFailed(false);
              setIsUpdating(false);
            } else {
              reconciliationAttemptsRef.current++;
              if (reconciliationAttemptsRef.current < 10) {
                scheduleSnapshotReconciliation();
              } else {
                setReconciliationFailed(true);
                setIsUpdating(false);
              }
            }
          }
        })
        .catch(() => {
          reconciliationAttemptsRef.current++;
          if (reconciliationAttemptsRef.current < 10) {
            scheduleSnapshotReconciliation();
          } else {
            setReconciliationFailed(true);
            setIsUpdating(false);
          }
        });
    }, delay);
  }, [coordinator]);

  const handleManualReconcile = useCallback(() => {
    setReconciliationFailed(false);
    reconciliationAttemptsRef.current = 0;
    api
      .getStatus()
      .then((st) => {
        if (st.watcher_health) setWatcherHealth(st.watcher_health);
        coordinator.recordObservedEventRevision(st.revision);
        return api.getNetwork();
      })
      .then((snap) => {
        applySnapshotRef.current?.(snap, ['*']);
      })
      .catch(() => {
        scheduleSnapshotReconciliation();
      });
  }, [coordinator, scheduleSnapshotReconciliation]);

  // Stable ref for applySnapshot
  const applySnapshotRef = useRef<((newSnap: GraphSnapshot, changedFiles: string[]) => void) | null>(null);

  // 3. Authenticated Server-Sent Events (SSE) for Live Updates & Reconnection Reconciliation
  useEffect(() => {
    if (!sessionInitialized || error) return;
    let isCancelled = false;

    const applySnapshot = (newSnap: GraphSnapshot, changedFiles: string[]) => {
      if (isCancelled) return;
      const shouldApply = coordinator.shouldApplySnapshot(newSnap.revision);
      if (shouldApply) {
        coordinator.recordAppliedRevision(newSnap.revision);
        setReconciliationFailed(false);
        reconciliationAttemptsRef.current = 0;
        setSnapshot(newSnap);
        setLiveRevision(newSnap.revision);
        setStatus('Ready');

        // Flash subtle live-update toast only for background updates, not initial load
        if (snapshotRef.current !== null) {
          const fileNotice =
            changedFiles.length > 0 && changedFiles[0] !== '*'
              ? `${changedFiles.length} file(s) updated`
              : 'Graph reanalyzed';
          showLiveNotice(`Live update: ${fileNotice} (rev ${newSnap.revision})`);
        }

        // Defect D: Resolve initial or queued CLI navigation focus target once first snapshot is applied
        const targetPath = pendingNavFocusRef.current ?? initialParams.initialFocusPath;
        if (targetPath && !focusResolvedRef.current) {
          focusResolvedRef.current = true;
          pendingNavFocusRef.current = null;
          const matched = resolveInitialFocusNode(targetPath, newSnap.nodes);
          if (matched) {
            setSelectedNode(matched);
            setFocusNodeId(matched.id);
            setMissingFocusPath(null);
          } else {
            setMissingFocusPath(targetPath);
          }
        }

        // Re-sync selected node if still exists in the new snapshot
        setSelectedNode((prev) => reconcileSelectedNodeOnSnapshot(prev, newSnap.nodes));
        // Re-sync selected edge if still exists in the new snapshot (reconciles stale evidence)
        setSelectedEdge((prev) => reconcileSelectedEdgeOnSnapshot(prev, newSnap.edges));
        // Re-sync selected areas if they still have files in the new snapshot
        setSelectedAreaIds((prev) =>
          prev.filter((areaId) => reconcileSelectedAreaOnSnapshot(areaId, newSnap.nodes) !== null)
        );
        // Re-sync 2D focus node if still exists; do not auto-select random node on deletion
        setFocusNodeId((prev) => {
          const { nextFocusNodeId, missingNotice } = reconcileFocusNodeOnSnapshot(prev, newSnap.nodes);
          if (missingNotice) setMissingFocusPath(missingNotice);
          return nextFocusNodeId;
        });
        // Re-sync 2D focus history by pruning entries deleted on disk
        setFocusHistory((prev) => reconcileFocusHistoryOnSnapshot(prev, newSnap.nodes));
      }

      // Trailing fetch check: executes even if the incoming snapshot was stale/rejected,
      // ensuring newer announced revisions are never stranded!
      if (coordinator.hasPendingNewerRevision()) {
        setIsUpdating(true);
        if (!shouldApply) {
          // If the snapshot we just received did not advance the revision, do not immediately re-fetch in a tight loop.
          // Schedule bounded reconciliation with backoff.
          scheduleSnapshotReconciliation();
        } else {
          api
            .getNetwork()
            .then((newerSnap) => applySnapshot(newerSnap, ['*']))
            .catch(() => {
              scheduleSnapshotReconciliation();
            });
        }
      } else {
        setIsUpdating(false);
      }
    };

    applySnapshotRef.current = applySnapshot;

    const unsubscribe = api.subscribeToEvents(
      (event: ServerEvent) => {
        setSseState('connected');
        if (event.type === 'network.updated') {
          const { revision, changed_files } = event.data;
          if (coordinator.shouldProcessSseEvent(revision)) {
            setIsUpdating(true);
            coordinator.recordObservedEventRevision(revision);
            api
              .getNetwork()
              .then((newSnap) => applySnapshot(newSnap, changed_files))
              .catch(() => {
                scheduleSnapshotReconciliation();
              });
          }
        } else if (event.type === 'git.updated') {
          api.getGitStatus().then(setGitStatus).catch(() => { });
          if (activeTabRef.current === 'temporal') {
            loadCommitsRef.current(temporalFilterPathRef.current, true);
          }
        } else if (event.type === 'reconcile.required') {
          api.getGitStatus().then((gs) => {
            if (!isCancelled) setGitStatus(gs);
          }).catch(() => { });
          if (activeTabRef.current === 'temporal') {
            loadCommitsRef.current(temporalFilterPathRef.current, true);
          }
          api.getStatus().then((st) => {
            if (st.watcher_health) setWatcherHealth(st.watcher_health);
            if (coordinator.shouldApplySnapshot(st.revision)) {
              setIsUpdating(true);
              coordinator.recordObservedEventRevision(st.revision);
              api
                .getNetwork()
                .then((newSnap) => applySnapshot(newSnap, ['*']))
                .catch(() => {
                  scheduleSnapshotReconciliation();
                });
            }
          }).catch(() => { });
        }
      },
      (status) => {
        setSseState(status);
        if (status === 'connected') {
          // Re-fetch git status & history on reconnect to reconcile missed Git updates (Defect H)
          api.getGitStatus().then((gs) => {
            if (!isCancelled) setGitStatus(gs);
          }).catch(() => { });
          if (activeTabRef.current === 'temporal') {
            loadCommitsRef.current(temporalFilterPathRef.current, true);
          }
          // Re-fetch status on reconnect to reconcile any missed network updates
          api.getStatus().then((st) => {
            if (st.watcher_health) setWatcherHealth(st.watcher_health);
            if (coordinator.shouldApplySnapshot(st.revision)) {
              setIsUpdating(true);
              coordinator.recordObservedEventRevision(st.revision);
              api
                .getNetwork()
                .then((newSnap) => applySnapshot(newSnap, ['*']))
                .catch(() => {
                  scheduleSnapshotReconciliation();
                });
            }
          }).catch(() => { });
        }
      }
    );

    return () => {
      isCancelled = true;
      applySnapshotRef.current = null;
      if (reconciliationTimerRef.current) {
        clearTimeout(reconciliationTimerRef.current);
        reconciliationTimerRef.current = null;
      }
      unsubscribe();
    };
  }, [sessionInitialized, error, coordinator, scheduleSnapshotReconciliation, showLiveNotice]);

  // Wire CLI session-reuse workspace navigation hook
  useEffect(() => {
    return registerWorkspaceNavigateHandler(({ view, focus }) => {
      if (view === 'temporal') {
        setActiveTab('temporal');
      } else {
        setActiveTab('network');
        setNetworkViewMode(view);
      }

      if (focus) {
        // Clear stale selection/overlay state when CLI explicitly navigates to a new focus target
        setSelectedEdge(null);
        setSelectedCycleGroup(null);
        setActiveDependencyPath(null);
        setSelectedCommit(null);
        setRevealRequest(null);

        const currentSnap = snapshotRef.current;
        if (currentSnap) {
          pendingNavFocusRef.current = null;
          focusResolvedRef.current = true;
          const matched = resolveInitialFocusNode(focus, currentSnap.nodes);
          if (matched) {
            setSelectedNode(matched);
            setFocusNodeId(matched.id);
            setMissingFocusPath(null);
          } else {
            setMissingFocusPath(focus);
          }
        } else {
          pendingNavFocusRef.current = focus;
          focusResolvedRef.current = false;
        }
      }
    });
  }, []);

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
        setSelectedCycleGroup(null);
        setActiveDependencyPath(null);
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
        setSelectedAreaEdge(null);
        setSelectedCycleGroup(null);
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
      setSelectedAreaEdge(null);
    }
  }, []);

  const handleSelectArea = useCallback((areaId: string | null) => {
    setSelectedAreaIds(areaId ? [areaId] : []);
    setSelectedAreaEdge(null);
    if (areaId) {
      setSelectedNode(null);
      setSelectedEdge(null);
    }
  }, []);

  const handleSelectAreaEdge = useCallback((edge: AreaEdge | null) => {
    setSelectedAreaEdge(edge);
    if (edge) {
      setSelectedNode(null);
      setSelectedEdge(null);
      setSelectedAreaIds((prev) => (prev.length === 1 ? prev : [edge.sourceAreaId]));
    }
  }, []);

  const handleToggleArea = useCallback((areaId: string) => {
    setSelectedAreaIds((prev) =>
      prev.includes(areaId)
        ? prev.filter((id) => id !== areaId)
        : [...prev, areaId]
    );
    setSelectedNode(null);
    setSelectedEdge(null);
    setSelectedAreaEdge(null);
  }, []);

  const handleClearAreas = useCallback(() => {
    setSelectedAreaIds([]);
    setSelectedAreaEdge(null);
  }, []);

  const handleExportCanvasImage = useCallback(() => {
    const activeCanvasSelector =
      activeTab === 'temporal'
        ? 'canvas.temporal-canvas'
        : networkViewMode === '2d'
          ? 'canvas.relationship-canvas'
          : 'canvas.network-canvas';
    const canvas =
      (document.querySelector(`main.main-content ${activeCanvasSelector}`) as HTMLCanvasElement | null) ||
      (document.querySelector('main.main-content canvas') as HTMLCanvasElement | null);
    if (!canvas) return;
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const mode =
        activeTab === 'temporal'
          ? 'git-temporal'
          : networkViewMode === '2d'
            ? 'relationship-2d'
            : 'network-3d';
      const fileName = `prebase-${mode}-${timestamp}.png`;

      if (canvas.toBlob) {
        canvas.toBlob((blob) => {
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.download = fileName;
          a.href = url;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          setAnnouncement('Graph image exported as PNG');
        }, 'image/png');
      } else {
        const dataUrl = canvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.download = fileName;
        a.href = dataUrl;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setAnnouncement('Graph image exported as PNG');
      }
    } catch (err) {
      console.error('Failed to export canvas image:', err);
    }
  }, [activeTab, networkViewMode]);

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
    setFocusNodeId(node.id);
    setMissingFocusPath(null);
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
            <PreBaseMark size={18} />
            <span className="brand-name">PreBase</span>
          </div>
          <div className="header-actions">
            <button
              className="theme-toggle-btn"
              onClick={toggleTheme}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <span className="brand-version">v0.1</span>
          </div>
        </div>

        {/* Unified Repository & Branch Context Card */}
        <div className="repo-badge repo-identity-card">
          <div className="repo-identity-main">
            <FolderGit2 size={15} className="repo-icon" />
            <div className="repo-meta">
              <span className="repo-title">{repoInfo?.repository_name || 'Loading...'}</span>
              <span className="repo-path mono">{repoInfo?.repository_root_display || ''}</span>
            </div>
          </div>
          {gitStatus?.branch && (
            <div className="git-branch-badge repo-branch-pill">
              <GitBranch size={12} className="branch-icon" />
              <span className="mono">{gitStatus.branch}</span>
              {gitStatus.is_dirty && <span className="dirty-dot" title="Working tree has uncommitted changes" />}
            </div>
          )}
        </div>

        <nav className="nav-menu" aria-label="Main Navigation">
          <button
            className={`nav-item ${activeTab === 'network' ? 'active' : ''}`}
            onClick={() => setActiveTab('network')}
            aria-label="Network"
          >
            <Share2 size={16} />
            <span>Network</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'temporal' ? 'active' : ''}`}
            onClick={() => setActiveTab('temporal')}
            aria-label="History"
          >
            <Clock size={16} />
            <span>History</span>
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
              isDelayedReconnecting,
              reconciliationFailed,
              isUpdating || coordinator.hasPendingNewerRevision()
            );

            return (
              <div
                className={`live-watcher-badge ${reconciliationFailed ? 'interactive-retry' : ''}`}
                title={reconciliationFailed ? 'Click to retry synchronization' : statusInfo.text}
                role={reconciliationFailed ? 'button' : 'status'}
                tabIndex={reconciliationFailed ? 0 : undefined}
                onClick={reconciliationFailed ? handleManualReconcile : undefined}
                onKeyDown={
                  reconciliationFailed
                    ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleManualReconcile();
                      }
                    }
                    : undefined
                }
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
        {/* Unified Workspace Chrome (Normal in-flow layout) */}
        <div className="workspace-chrome">
          <header className="workspace-header primary-toolbar" role="toolbar" aria-label="Workspace controls">
            <div className="primary-toolbar-left">
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
                  <Clock size={15} color="var(--accent-brand)" />
                  <span>Commit history</span>
                  {commits.length > 0 && (
                    <span className="dim">
                      ({commits.length} {totalCommits ? `of ${totalCommits}` : ''} commits)
                    </span>
                  )}
                </div>
              )}
            </div>

            {activeTab === 'network' && (
              <div className="workspace-header-actions primary-toolbar-right">
                <div className="network-mode-switcher" role="radiogroup" aria-label="Network View Mode">
                  <button
                    className={`mode-btn ${networkViewMode === '3d' ? 'active' : ''}`}
                    onClick={() => handleSwitchNetworkMode('3d')}
                    title="3D Repository Overview (Shortcut: V)"
                    role="radio"
                    aria-checked={networkViewMode === '3d'}
                  >
                    <Layers size={13} />
                    <span className="mode-full-label">3D Overview</span>
                    <span className="mode-short-label">3D</span>
                  </button>
                  <button
                    className={`mode-btn ${networkViewMode === '2d' ? 'active' : ''}`}
                    onClick={() => handleSwitchNetworkMode('2d')}
                    title="Contextual 2D Relationship Explorer (Shortcut: V)"
                    role="radio"
                    aria-checked={networkViewMode === '2d'}
                  >
                    <Compass size={13} />
                    <span className="mode-full-label">2D Relationships</span>
                    <span className="mode-short-label">2D</span>
                  </button>
                </div>

                <div className="toolbar-menu-anchor" ref={filterMenuRef}>
                  <button
                    className={`toolbar-btn ${selectedLanguageFilter !== 'all' || sourceOnlyFilter ? 'active' : ''}`}
                    onClick={() => setIsFilterMenuOpen((prev) => !prev)}
                    title="Filter repository files by scope or language"
                    aria-haspopup="menu"
                    aria-expanded={isFilterMenuOpen}
                  >
                    <Filter size={13} />
                    <span className="btn-label">Filters</span>
                    {(selectedLanguageFilter !== 'all' || sourceOnlyFilter) && <span className="active-filter-dot" />}
                    <ChevronDown size={11} className={`dropdown-chevron ${isFilterMenuOpen ? 'open' : ''}`} />
                  </button>
                  {isFilterMenuOpen && (
                    <div className="toolbar-dropdown-menu" role="menu" aria-label="Filter graph files">
                      <div className="menu-group-header">File Visibility</div>
                      <button
                        className={`menu-item ${!sourceOnlyFilter ? 'selected' : ''}`}
                        role="menuitemradio"
                        aria-checked={!sourceOnlyFilter}
                        onClick={() => {
                          setSourceOnlyFilter(false);
                          setIsFilterMenuOpen(false);
                        }}
                      >
                        <span>All Discovered Files ({snapshot?.coverage.total_discovered || 0})</span>
                        {!sourceOnlyFilter && <Check size={13} />}
                      </button>
                      <button
                        className={`menu-item ${sourceOnlyFilter ? 'selected' : ''}`}
                        role="menuitemradio"
                        aria-checked={sourceOnlyFilter}
                        onClick={() => {
                          setSourceOnlyFilter(true);
                          setIsFilterMenuOpen(false);
                        }}
                      >
                        <span>Analyzed Code Only ({snapshot?.coverage.total_analyzed || 0})</span>
                        {sourceOnlyFilter && <Check size={13} />}
                      </button>
                      <div className="menu-divider" />
                      <div className="menu-group-header">Filter Language</div>
                      <button
                        className={`menu-item ${selectedLanguageFilter === 'all' ? 'selected' : ''}`}
                        role="menuitemradio"
                        aria-checked={selectedLanguageFilter === 'all'}
                        onClick={() => {
                          setSelectedLanguageFilter('all');
                          setIsFilterMenuOpen(false);
                        }}
                      >
                        <span>All Languages</span>
                        {selectedLanguageFilter === 'all' && <Check size={13} />}
                      </button>
                      <button
                        className={`menu-item ${selectedLanguageFilter === 'typescript' ? 'selected' : ''}`}
                        role="menuitemradio"
                        aria-checked={selectedLanguageFilter === 'typescript'}
                        onClick={() => {
                          setSelectedLanguageFilter('typescript');
                          setIsFilterMenuOpen(false);
                        }}
                      >
                        <span>TypeScript / JavaScript</span>
                        {selectedLanguageFilter === 'typescript' && <Check size={13} />}
                      </button>
                      <button
                        className={`menu-item ${selectedLanguageFilter === 'rust' ? 'selected' : ''}`}
                        role="menuitemradio"
                        aria-checked={selectedLanguageFilter === 'rust'}
                        onClick={() => {
                          setSelectedLanguageFilter('rust');
                          setIsFilterMenuOpen(false);
                        }}
                      >
                        <span>Rust</span>
                        {selectedLanguageFilter === 'rust' && <Check size={13} />}
                      </button>
                      <button
                        className={`menu-item ${selectedLanguageFilter === 'python' ? 'selected' : ''}`}
                        role="menuitemradio"
                        aria-checked={selectedLanguageFilter === 'python'}
                        onClick={() => {
                          setSelectedLanguageFilter('python');
                          setIsFilterMenuOpen(false);
                        }}
                      >
                        <span>Python</span>
                        {selectedLanguageFilter === 'python' && <Check size={13} />}
                      </button>
                    </div>
                  )}
                </div>

                <div className="action-btn-group view-controls">
                  <button
                    id="zoomIn"
                    className="ctrl-btn icon-only btn-secondary"
                    onClick={() => setZoomInCounter((c) => c + 1)}
                    title="Zoom In (Shortcut: +)"
                    aria-label="Zoom in"
                  >
                    <ZoomIn size={14} />
                  </button>
                  <button
                    id="zoomOut"
                    className="ctrl-btn icon-only btn-secondary"
                    onClick={() => setZoomOutCounter((c) => c + 1)}
                    title="Zoom Out (Shortcut: -)"
                    aria-label="Zoom out"
                  >
                    <ZoomOut size={14} />
                  </button>
                  <button
                    id="fitView"
                    className="ctrl-btn icon-only"
                    onClick={() => setFitViewCounter((c) => c + 1)}
                    title={networkViewMode === '2d' ? 'Fit 2D Relationship View (Shortcut: F)' : 'Fit View to All Nodes (Shortcut: F)'}
                    aria-label="Fit view"
                  >
                    <Maximize2 size={14} />
                  </button>
                  <button
                    id="resetCam"
                    className="ctrl-btn icon-only"
                    onClick={() => setResetViewCounter((c) => c + 1)}
                    title={networkViewMode === '2d' ? 'Reset 2D Camera (Shortcut: R)' : 'Reset Camera to Standard 3D View (Shortcut: R)'}
                    aria-label="Reset camera"
                  >
                    <RotateCcw size={14} />
                  </button>
                  {networkViewMode === '3d' && (
                    <button
                      id="centerLock"
                      className={`ctrl-btn icon-only ${keepGraphCentered ? 'active' : ''}`}
                      onClick={() => {
                        setKeepGraphCentered((prev) => {
                          const next = !prev;
                          setAnnouncement(next ? 'Keep centered on' : 'Keep centered off');
                          return next;
                        });
                      }}
                      title={keepGraphCentered ? 'Keep graph centered (Active) (Shortcut: C)' : 'Center lock off (Shortcut: C)'}
                      role="checkbox"
                      aria-checked={keepGraphCentered}
                      aria-label="Keep graph centered"
                    >
                      <Target size={14} />
                    </button>
                  )}
                  <div className="toolbar-menu-anchor" ref={viewMenuRef}>
                    <button
                      className="ctrl-btn icon-only"
                      onClick={() => setIsViewMenuOpen((prev) => !prev)}
                      title="Export & view utilities"
                      aria-haspopup="menu"
                      aria-expanded={isViewMenuOpen}
                      aria-label="More view options"
                    >
                      <SlidersHorizontal size={14} />
                    </button>
                    {isViewMenuOpen && (
                      <div className="toolbar-dropdown-menu right-aligned view-options-menu" role="menu" aria-label="View options">
                        <button
                          type="button"
                          className="menu-item"
                          role="menuitem"
                          onClick={() => {
                            setZoomInCounter((c) => c + 1);
                            setIsViewMenuOpen(false);
                          }}
                        >
                          <ZoomIn size={13} className="menu-item-icon" aria-hidden="true" />
                          <span className="menu-item-label">Zoom In</span>
                          <span className="menu-shortcut">+</span>
                        </button>
                        <button
                          type="button"
                          className="menu-item"
                          role="menuitem"
                          onClick={() => {
                            setZoomOutCounter((c) => c + 1);
                            setIsViewMenuOpen(false);
                          }}
                        >
                          <ZoomOut size={13} className="menu-item-icon" aria-hidden="true" />
                          <span className="menu-item-label">Zoom Out</span>
                          <span className="menu-shortcut">-</span>
                        </button>
                        <button
                          type="button"
                          className="menu-item"
                          role="menuitem"
                          onClick={() => {
                            setFitViewCounter((c) => c + 1);
                            setIsViewMenuOpen(false);
                          }}
                        >
                          <Maximize2 size={13} className="menu-item-icon" aria-hidden="true" />
                          <span className="menu-item-label">Fit View</span>
                          <span className="menu-shortcut">F</span>
                        </button>
                        <button
                          type="button"
                          className="menu-item"
                          role="menuitem"
                          onClick={() => {
                            setResetViewCounter((c) => c + 1);
                            setIsViewMenuOpen(false);
                          }}
                        >
                          <RotateCcw size={13} className="menu-item-icon" aria-hidden="true" />
                          <span className="menu-item-label">Reset Camera</span>
                          <span className="menu-shortcut">R</span>
                        </button>
                        {networkViewMode === '3d' && (
                          <>
                            <div className="menu-divider" />
                            <button
                              type="button"
                              className="menu-item menu-item-checkbox"
                              role="menuitemcheckbox"
                              aria-checked={hideGroupLabelsOnMovement}
                              onClick={toggleHideGroupLabelsOnMovement}
                            >
                              <span
                                className={`menu-checkbox-box ${hideGroupLabelsOnMovement ? 'checked' : ''}`}
                                aria-hidden="true"
                              >
                                {hideGroupLabelsOnMovement && <Check size={10} strokeWidth={3} />}
                              </span>
                              <span className="menu-item-label">Hide group labels upon graph movement</span>
                            </button>
                          </>
                        )}
                        <div className="menu-divider" />
                        <button
                          type="button"
                          id="exportPNG"
                          className="menu-item"
                          role="menuitem"
                          onClick={() => {
                            handleExportCanvasImage();
                            setIsViewMenuOpen(false);
                          }}
                          title="Export active view as PNG image"
                        >
                          <Download size={13} className="menu-item-icon" aria-hidden="true" />
                          <span className="menu-item-label">Export PNG</span>
                        </button>
                      </div>
                    )}
                  </div>
                  {inspectorCollapsed && (
                    <button
                      id="toggleInspector"
                      className="ctrl-btn inspector-reopen-btn"
                      onClick={() => setInspectorCollapsed(false)}
                      title="Open inspector"
                      aria-label="Open inspector"
                    >
                      <PanelRightOpen size={14} />
                      <span className="btn-label">Inspect</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </header>

          {/* Contextual Navigation Bar (Dedicated In-Flow Row) */}
          {activeTab === 'network' && (
            <nav className="context-nav-bar" role="navigation" aria-label="Graph Level Navigation">
              <div className="network-breadcrumb-bar in-flow">
                <button
                  type="button"
                  className={`crumb-btn ${!selectedAreaId && !selectedNode && !selectedAreaEdge ? 'active' : ''}`}
                  onClick={() => {
                    handleSelectArea(null);
                    handleSelectNode(null);
                    handleSelectAreaEdge(null);
                  }}
                  title="Return to Repository Overview"
                >
                  <Layers size={12} className="crumb-icon" />
                  <span>Overview</span>
                </button>

                {selectedAreaId && (
                  <>
                    <span className="crumb-sep" aria-hidden="true">/</span>
                    <button
                      type="button"
                      className={`crumb-btn ${!selectedNode && !selectedAreaEdge ? 'active' : ''}`}
                      onClick={() => {
                        handleSelectNode(null);
                        handleSelectAreaEdge(null);
                      }}
                      title={`Area: ${selectedAreaId}`}
                    >
                      <span className="crumb-label">Area:</span>
                      <span className="crumb-target truncate">{selectedAreaId}</span>
                    </button>
                  </>
                )}

                {selectedNode && (
                  <>
                    <span className="crumb-sep" aria-hidden="true">/</span>
                    <span
                      className="crumb-current"
                      title={selectedNode.relative_path || selectedNode.filename}
                    >
                      <span className="crumb-text truncate">{selectedNode.filename}</span>
                    </span>
                    <button
                      type="button"
                      className="crumb-clear-btn"
                      onClick={() => handleSelectNode(null)}
                      title="Deselect file"
                      aria-label="Deselect file"
                    >
                      <X size={12} />
                    </button>
                  </>
                )}

                {selectedAreaEdge && !selectedNode && (
                  <>
                    <span className="crumb-sep" aria-hidden="true">/</span>
                    <span
                      className="crumb-current relationship-crumb"
                      title={`${selectedAreaEdge.sourceAreaId} → ${selectedAreaEdge.targetAreaId} (${selectedAreaEdge.edgeCount} links)`}
                    >
                      <span className="crumb-text truncate">
                        {selectedAreaEdge.sourceAreaId} → {selectedAreaEdge.targetAreaId} ({selectedAreaEdge.edgeCount})
                      </span>
                    </span>
                    <button
                      type="button"
                      className="crumb-clear-btn"
                      onClick={() => handleSelectAreaEdge(null)}
                      title="Deselect area relationship"
                      aria-label="Deselect area relationship"
                    >
                      <X size={12} />
                    </button>
                  </>
                )}
              </div>
            </nav>
          )}
        </div>

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
                <h3>No supported source files found</h3>
                <p>PreBase indexes JavaScript, TypeScript, Rust, and Python codebases. Place supported source files in this repository to explore their dependency graph.</p>
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
                      selectedAreaIds={selectedAreaIds}
                      onSelectArea={handleSelectArea}
                      selectedAreaEdge={selectedAreaEdge}
                      onSelectAreaEdge={handleSelectAreaEdge}
                      languageFilter={selectedLanguageFilter}
                      sourceOnlyFilter={sourceOnlyFilter}
                      highlightedNodeIds={highlightedNodeIds}
                      highlightedEdgeIds={highlightedEdgeIds}
                      onSelectNode={handleSelectNode}
                      onSelectEdge={handleSelectEdge}
                      revealRequest={revealRequest}
                      fitViewTrigger={fitViewCounter}
                      resetViewTrigger={resetViewCounter}
                      zoomInTrigger={zoomInCounter}
                      zoomOutTrigger={zoomOutCounter}
                      keepGraphCentered={keepGraphCentered}
                      onToggleCenterLock={() => setKeepGraphCentered((prev) => !prev)}
                      isVisible={networkViewMode === '3d'}
                      insets={networkInsets}
                      onAnnounce={setAnnouncement}
                      theme={theme}
                      hideInternalBreadcrumb={true}
                      hideGroupLabelsOnMovement={hideGroupLabelsOnMovement}
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
                      languageFilter={selectedLanguageFilter}
                      onSelectNode={handleSelectNode}
                      onSelectEdge={handleSelectEdge}
                      onRefocusNode={handleRefocusNode2D}
                      onBackFocus={handleBackFocus2D}
                      canGoBack={focusHistory.length > 0}
                      backTargetName={resolveBackTargetName(focusHistory, snapshot.nodes)}
                      fitViewTrigger={fitViewCounter}
                      resetViewTrigger={resetViewCounter}
                      zoomInTrigger={zoomInCounter}
                      zoomOutTrigger={zoomOutCounter}
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
                {temporalError && gitStatus?.is_git_repo !== false && !temporalError.toLowerCase().includes('not a git repository') ? (
                  <>
                    <AlertCircle size={36} color="#f59e0b" />
                    <h3>Failed to load Git history</h3>
                    <p>{temporalError}</p>
                    <button className="primary-btn" onClick={() => loadCommits(temporalFilterPath)}>
                      Retry Loading History
                    </button>
                  </>
                ) : (
                  <>
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
                  </>
                )}
              </div>
            ) : (
              <>
                {temporalError && (
                  <div className="temporal-error-banner" role="alert">
                    <span>{temporalError}</span>
                    <button className="inline-retry-btn" onClick={() => loadCommits(temporalFilterPath)}>
                      Retry
                    </button>
                  </div>
                )}
                <TemporalCanvas
                  commits={commits}
                  selectedCommitHash={selectedCommit?.hash || null}
                  onSelectCommit={setSelectedCommit}
                  isFiltered={Boolean(temporalFilterPath)}
                  fitViewTrigger={fitViewCounter}
                  resetViewTrigger={resetViewCounter}
                  theme={theme}
                />

                {/* Reserved Bottom Pagination Bar */}
                {hasMoreCommits && (
                  <div className="temporal-pagination-bar" role="region" aria-label="Commit pagination">
                    <button
                      className="pagination-btn"
                      disabled={isLoadingMore}
                      onClick={handleLoadMoreCommits}
                      aria-label="Load older commits"
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
          hasMoreCommits={hasMoreCommits}
          isLoadingMore={isLoadingMore}
          onLoadMore={handleLoadMoreCommits}
        />
      ) : (
        <Inspector
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          selectedAreaId={selectedAreaId}
          selectedAreaIds={selectedAreaIds}
          selectedAreaEdge={selectedAreaEdge}
          onSelectAreaEdge={handleSelectAreaEdge}
          onSelectArea={handleSelectArea}
          onToggleArea={handleToggleArea}
          onClearAreas={handleClearAreas}
          snapshot={snapshot}
          onSelectNode={handleSelectNode}
          onClose={() => {
            setSelectedNode(null);
            setSelectedEdge(null);
            setSelectedAreaIds([]);
            setSelectedAreaEdge(null);
            setSelectedCycleGroup(null);
            setActiveDependencyPath(null);
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
          selectedCycleGroup={selectedCycleGroup}
          onSelectCycleGroup={setSelectedCycleGroup}
          isPathExplorerOpen={isPathExplorerOpen}
          onTogglePathExplorer={setIsPathExplorerOpen}
          pathExplorerSourceNode={pathExplorerSourceNode}
          activeDependencyPath={activeDependencyPath}
          onActivePathChange={setActiveDependencyPath}
          onOpenPathExplorer={(node) => {
            setPathExplorerSourceNode(node);
            setIsPathExplorerOpen(true);
          }}
          theme={theme}
        />
      )}

      {/* Screen Reader Live Region for Accessibility Announcements */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
};

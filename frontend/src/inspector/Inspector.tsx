import React, { useEffect, useState, useRef, useMemo } from 'react';
import {
  CycleGroup,
  DependencyEdge,
  DependencyPathResult,
  FileImpactAnalysis,
  FileInspection,
  FileNode,
  GraphSnapshot,
} from '../types/graph';
import { api } from '../transport/api';
import { getFileTypeColor, ENTRY_NODE_COLOR } from '../graphs/network/fileTypeColors';
import {
  deriveRepositoryStructure,
  getAreaIdForPath,
  AreaEdge,
} from '../utils/repositoryAreas';
import { useCopyFeedback } from '../utils/clipboard';
import { PathExplorer } from './PathExplorer';
import { CycleGroupInspector } from './CycleGroupInspector';
import {
  X,
  ArrowRight,
  FileCode,
  Layers,
  AlertTriangle,
  ExternalLink,
  Clock,
  LocateFixed,
  Compass,
  Copy,
  Check,
  PanelRightClose,
  Folder,
  Info,
  ChevronRight,
  ArrowLeft,
  ArrowUpRight,
  ArrowDownLeft,
  Repeat,
  CheckCircle2,
  Route,
  ChevronDown,
  ChevronUp,
  Plus,
} from 'lucide-react';

interface InspectorProps {
  selectedNode: FileNode | null;
  selectedEdge: DependencyEdge | null;
  selectedAreaId?: string | null;
  selectedAreaIds?: string[];
  onSelectArea?: (areaId: string | null) => void;
  onToggleArea?: (areaId: string) => void;
  onClearAreas?: () => void;
  selectedCycleGroup?: CycleGroup | null;
  onSelectCycleGroup?: (cg: CycleGroup | null) => void;
  isPathExplorerOpen?: boolean;
  onTogglePathExplorer?: (open: boolean) => void;
  pathExplorerSourceNode?: FileNode | null;
  activeDependencyPath?: DependencyPathResult | null;
  onActivePathChange?: (result: DependencyPathResult | null) => void;
  onOpenPathExplorer?: (node: FileNode) => void;
  snapshot: GraphSnapshot | null;
  onSelectNode: (node: FileNode) => void;
  onClose: () => void;
  onViewFileHistory?: (filePath: string) => void;
  onRevealNode?: (nodeId: string) => void;
  networkViewMode?: '3d' | '2d';
  focusNodeId?: string | null;
  onExplore2D?: (node: FileNode) => void;
  onRefocus2D?: (nodeId: string) => void;
  onSwitchTo3D?: () => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function getNodeRelationshipSentence(
  node: Pick<FileNode, 'direct_dependency_count' | 'direct_dependent_count' | 'analysis_status'> | null
): string {
  if (!node) return '';
  const depCount = node.direct_dependency_count ?? 0;
  const dependentCount = node.direct_dependent_count ?? 0;
  const isUnsupported = node.analysis_status === 'Unsupported';
  const isFailed = node.analysis_status === 'Failed';

  if (isUnsupported) {
    return 'PreBase discovered this file but does not currently analyze its internal dependencies.';
  }
  if (isFailed) {
    return "PreBase encountered an error while parsing this file's imports.";
  }
  if (depCount === 0 && dependentCount === 0) {
    return 'This file has no direct internal dependencies or dependents in this repository.';
  }
  if (depCount > 0 && dependentCount === 0) {
    return `This file uses ${depCount} internal file${depCount > 1 ? 's' : ''}, and is not directly imported by any other indexed files.`;
  }
  if (depCount === 0 && dependentCount > 0) {
    return `This file is directly used by ${dependentCount} other file${dependentCount > 1 ? 's' : ''}, and imports no other indexed files.`;
  }
  return `This file uses ${depCount} internal file${depCount > 1 ? 's' : ''} and is used by ${dependentCount} other file${dependentCount > 1 ? 's' : ''}.`;
}

export function getEdgeRelationshipSentence(edge: DependencyEdge): string {
  const isTypeOnly =
    edge.relationship_kind === 'TypeOnly' || edge.evidence.every((e) => e.is_type_only);
  if (edge.relationship_kind === 'Export') {
    return `"${edge.source_file_id}" re-exports from "${edge.target_file_id}".`;
  }
  if (edge.relationship_kind === 'DynamicImport') {
    return `"${edge.source_file_id}" dynamically imports "${edge.target_file_id}".`;
  }
  if (isTypeOnly) {
    return `"${edge.source_file_id}" imports type definitions from "${edge.target_file_id}".`;
  }
  return `"${edge.source_file_id}" directly imports from "${edge.target_file_id}".`;
}

export const Inspector: React.FC<InspectorProps> = ({
  selectedNode,
  selectedEdge,
  selectedAreaId = null,
  selectedAreaIds = [],
  onSelectArea,
  onToggleArea,
  onClearAreas,
  selectedCycleGroup = null,
  onSelectCycleGroup,
  isPathExplorerOpen = false,
  onTogglePathExplorer,
  pathExplorerSourceNode = null,
  activeDependencyPath: _activeDependencyPath = null,
  onActivePathChange,
  onOpenPathExplorer,
  snapshot,
  onSelectNode,
  onClose,
  onViewFileHistory,
  onRevealNode,
  networkViewMode = '3d',
  focusNodeId = null,
  onExplore2D,
  onRefocus2D,
  onSwitchTo3D,
  isCollapsed = false,
  onToggleCollapse,
}) => {
  const [inspection, setInspection] = useState<FileInspection | null>(null);
  const [loading, setLoading] = useState(false);
  const [sourcePreview, setSourcePreview] = useState<string | null>(null);
  const [impactAnalysis, setImpactAnalysis] = useState<FileImpactAnalysis | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [showAllImpact, setShowAllImpact] = useState<boolean>(false);
  const [showAllDeps, setShowAllDeps] = useState<boolean>(false);
  const [showAllDependents, setShowAllDependents] = useState<boolean>(false);
  const [isImpactExpanded, setIsImpactExpanded] = useState<boolean>(true);
  const [diagnosticsFilterCategory, setDiagnosticsFilterCategory] = useState<string>('all');
  const [isDiagnosticsExpanded, setIsDiagnosticsExpanded] = useState<boolean>(false);
  const { copied: copiedPath, copy: copyPath } = useCopyFeedback();
  const { copied: copiedCode, copy: copyCode } = useCopyFeedback();
  const [focusedAreaEdge, setFocusedAreaEdge] = useState<AreaEdge | null>(null);

  const requestTokenRef = useRef(0);

  // Clear focused area edge when area changes or selection clears
  useEffect(() => {
    setFocusedAreaEdge(null);
  }, [selectedAreaId]);

  const handleCopyPath = (path: string) => {
    void copyPath(path);
  };

  const handleCopyCode = (code: string) => {
    void copyCode(code);
  };

  // Compute structured repository areas and beginner suggestions
  const repoStructure = useMemo(() => {
    if (!snapshot) return null;
    return deriveRepositoryStructure(snapshot.nodes, snapshot.edges);
  }, [snapshot]);

  useEffect(() => {
    if (selectedNode) {
      const currentToken = ++requestTokenRef.current;
      const abortController = new AbortController();

      // Immediately clear prior file's inspection and source preview to eliminate stale rendering races
      setInspection(null);
      setSourcePreview(null);
      setImpactAnalysis(null);
      setShowAllImpact(false);
      setShowAllDeps(false);
      setShowAllDependents(false);
      setLoading(true);
      setImpactLoading(true);

      api
        .inspectFile(selectedNode.id, abortController.signal)
        .then((res) => {
          if (currentToken !== requestTokenRef.current) return;
          setInspection(res);
          setLoading(false);
        })
        .catch((err) => {
          if (err.name === 'AbortError') return;
          if (currentToken !== requestTokenRef.current) return;
          setInspection(null);
          setLoading(false);
        });

      // Fetch first 30 lines preview for grounded context
      api
        .getSource(selectedNode.relative_path, abortController.signal)
        .then((res) => {
          if (currentToken !== requestTokenRef.current) return;
          setSourcePreview(res.content);
        })
        .catch(() => {
          if (currentToken !== requestTokenRef.current) return;
          setSourcePreview(null);
        });

      // Fetch downstream impact analysis
      api
        .getImpact(selectedNode.id, 5, abortController.signal)
        .then((res) => {
          if (currentToken !== requestTokenRef.current) return;
          setImpactAnalysis(res);
          setImpactLoading(false);
        })
        .catch(() => {
          if (currentToken !== requestTokenRef.current) return;
          setImpactAnalysis(null);
          setImpactLoading(false);
        });

      return () => {
        abortController.abort();
      };
    } else {
      requestTokenRef.current++;
      setInspection(null);
      setSourcePreview(null);
      setImpactAnalysis(null);
      setLoading(false);
      setImpactLoading(false);
    }
  }, [selectedNode]);

  // 0A. DEPENDENCY PATH EXPLORER
  if (isPathExplorerOpen) {
    return (
      <aside className={`inspector-panel ${isCollapsed ? 'collapsed' : ''}`}>
        <PathExplorer
          initialSourceNode={pathExplorerSourceNode || selectedNode}
          snapshot={snapshot}
          onSelectNode={onSelectNode}
          onClose={() => onTogglePathExplorer?.(false)}
          onActivePathChange={onActivePathChange}
          onSwitchTo3D={onSwitchTo3D}
          onExplore2D={onExplore2D}
        />
      </aside>
    );
  }

  // 0B. CIRCULAR DEPENDENCY GROUP INSPECTOR
  if (selectedCycleGroup) {
    return (
      <aside className={`inspector-panel ${isCollapsed ? 'collapsed' : ''}`}>
        <CycleGroupInspector
          cycleGroup={selectedCycleGroup}
          snapshot={snapshot}
          onSelectNode={onSelectNode}
          onClose={() => onSelectCycleGroup?.(null)}
          onClearFocus={() => onSelectCycleGroup?.(null)}
        />
      </aside>
    );
  }

  // 1A. DETAILED INTER-AREA RELATIONSHIP VIEW
  if (!selectedNode && !selectedEdge && selectedAreaId && focusedAreaEdge) {
    const srcArea = repoStructure?.areaMap.get(focusedAreaEdge.sourceAreaId);
    const tgtArea = repoStructure?.areaMap.get(focusedAreaEdge.targetAreaId);
    const isOutgoing = focusedAreaEdge.sourceAreaId === selectedAreaId;

    return (
      <aside className={`inspector-panel ${isCollapsed ? 'collapsed' : ''}`}>
        <div className="inspector-header">
          <div className="node-title-group">
            <Layers size={16} color="#38bdf8" />
            <h3 className="file-name">Area Connection</h3>
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
            <button
              className="close-btn"
              onClick={() => setFocusedAreaEdge(null)}
              title="Return to area overview"
              aria-label="Return to area overview"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div key={focusedAreaEdge.id} className="inspector-content animate-reveal">
          <button
            type="button"
            className="area-back-btn"
            onClick={() => setFocusedAreaEdge(null)}
          >
            <ArrowLeft size={13} style={{ marginRight: '4px' }} />
            Back to area ({isOutgoing ? srcArea?.name : tgtArea?.name})
          </button>

          <div className="area-summary-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
              <span className="mono" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent-sky)' }}>
                {srcArea?.name || focusedAreaEdge.sourceAreaId}
              </span>
              <ArrowRight size={14} color="#2dd4bf" />
              <span className="mono" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent-sky)' }}>
                {tgtArea?.name || focusedAreaEdge.targetAreaId}
              </span>
            </div>
            <p className="area-summary-desc">{focusedAreaEdge.summarySentence}</p>
          </div>

          <div className="stats-grid">
            <div className="stat-card">
              <span className="stat-label">Source Files</span>
              <span className="stat-value">{focusedAreaEdge.sourceFilesCount}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Target Files</span>
              <span className="stat-value">{focusedAreaEdge.targetFilesCount}</span>
            </div>
          </div>

          <div className="relations-section" style={{ marginTop: '10px' }}>
            <div className="section-title">
              <Layers size={14} />
              <h4>Contributing Dependencies ({focusedAreaEdge.contributingFilePairs.length})</h4>
            </div>
            <ul className="relation-list">
              {focusedAreaEdge.contributingFilePairs.map((pair, idx) => {
                const srcNode = snapshot?.nodes.find((n) => n.id === pair.sourceFileId);
                const tgtNode = snapshot?.nodes.find((n) => n.id === pair.targetFileId);
                return (
                  <li key={idx} className="area-relation-pair-card">
                    <div className="pair-endpoints">
                      <button
                        type="button"
                        className="pair-endpoint-btn"
                        onClick={() => srcNode && onSelectNode(srcNode)}
                        title={`Inspect source: ${pair.sourceFileId}`}
                      >
                        <FileCode size={12} color="#38bdf8" />
                        <span className="mono">{srcNode?.filename || pair.sourceFileId}</span>
                      </button>
                      <ArrowRight size={12} color="#94a3b8" />
                      <button
                        type="button"
                        className="pair-endpoint-btn"
                        onClick={() => tgtNode && onSelectNode(tgtNode)}
                        title={`Inspect target: ${pair.targetFileId}`}
                      >
                        <FileCode size={12} color="#a78bfa" />
                        <span className="mono">{tgtNode?.filename || pair.targetFileId}</span>
                      </button>
                    </div>
                    {pair.evidenceSpecifier && (
                      <div className="pair-evidence mono">
                        "{pair.evidenceSpecifier}" {pair.line ? `line ${pair.line}` : ''}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </aside>
    );
  }

  // 1C. MULTI-AREA COMPARISON VIEW (when multiple architectural areas are selected)
  if (!selectedNode && !selectedEdge && selectedAreaIds && selectedAreaIds.length > 1) {
    const selectedAreas = selectedAreaIds
      .map((id) => repoStructure?.areaMap.get(id))
      .filter((a): a is NonNullable<typeof a> => Boolean(a));
    const selectedAreaSet = new Set(selectedAreaIds);

    // Cross-area edges strictly between the selected areas
    const crossAreaEdges = (repoStructure?.areaEdges || []).filter(
      (e) => selectedAreaSet.has(e.sourceAreaId) && selectedAreaSet.has(e.targetAreaId)
    );

    const totalFiles = selectedAreas.reduce((sum, a) => sum + a.fileCount, 0);
    const totalInternalEdges = selectedAreas.reduce((sum, a) => sum + a.internalConnections, 0);
    const totalCrossEdges = crossAreaEdges.reduce((sum, e) => sum + e.edgeCount, 0);

    return (
      <aside className={`inspector-panel ${isCollapsed ? 'collapsed' : ''}`}>
        <div className="inspector-header">
          <div className="node-title-group">
            <Layers size={16} color="#38bdf8" />
            <h3 className="file-name">Area Comparison ({selectedAreaIds.length})</h3>
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
            <button
              className="close-btn"
              onClick={() => onClearAreas?.()}
              title="Clear area selection"
              aria-label="Close comparison view"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="inspector-content animate-reveal">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span className="text-xs text-muted">Selected Areas</span>
            <button
              type="button"
              className="btn-text text-xs"
              onClick={() => onClearAreas?.()}
              style={{ color: '#ef4444', cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}
            >
              Clear all
            </button>
          </div>

          <div className="multi-area-chips">
            {selectedAreas.map((area) => (
              <span key={area.id} className="multi-area-chip">
                <span>{area.name}</span>
                <button
                  type="button"
                  className="multi-area-chip-remove"
                  onClick={() => onToggleArea?.(area.id)}
                  title={`Remove ${area.name}`}
                  aria-label={`Remove ${area.name}`}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>

          <div className="stats-grid" style={{ marginTop: '12px' }}>
            <div className="stat-card">
              <span className="stat-label">Combined Files</span>
              <span className="stat-value">{totalFiles}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Cross-Connections</span>
              <span className="stat-value">{totalCrossEdges}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Intra-Area Edges</span>
              <span className="stat-value">{totalInternalEdges}</span>
            </div>
          </div>

          {/* Cross-Area Relationships */}
          <div className="relations-section" style={{ marginTop: '14px' }}>
            <div className="section-title">
              <ArrowUpRight size={14} color="#38bdf8" />
              <h4>Cross-Area Dependencies ({crossAreaEdges.length})</h4>
            </div>
            {crossAreaEdges.length === 0 ? (
              <p className="empty-hint">
                No direct dependency relationships linking these {selectedAreaIds.length} areas.
              </p>
            ) : (
              <div className="area-edges-list">
                {crossAreaEdges.map((edge) => {
                  const srcArea = repoStructure?.areaMap.get(edge.sourceAreaId);
                  const tgtArea = repoStructure?.areaMap.get(edge.targetAreaId);
                  return (
                    <button
                      key={edge.id}
                      type="button"
                      className="area-relation-btn"
                      onClick={() => setFocusedAreaEdge(edge)}
                      title={`Inspect ${srcArea?.name || edge.sourceAreaId} → ${tgtArea?.name || edge.targetAreaId}`}
                    >
                      <div className="area-rel-info">
                        <span className="area-rel-target mono">
                          {srcArea?.name || edge.sourceAreaId} → {tgtArea?.name || edge.targetAreaId}
                        </span>
                        <span className="area-rel-meta">
                          {edge.edgeCount} connection{edge.edgeCount === 1 ? '' : 's'} across {edge.sourceFilesCount} file{edge.sourceFilesCount === 1 ? '' : 's'}
                        </span>
                      </div>
                      <ChevronRight size={13} className="link-icon" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Add more areas toggle pills */}
          {repoStructure && repoStructure.areas.length > selectedAreaIds.length && (
            <div className="relations-section" style={{ marginTop: '14px' }}>
              <div className="section-title">
                <Folder size={14} color="#94a3b8" />
                <h4>Add Area to Comparison</h4>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
                {repoStructure.areas
                  .filter((a) => !selectedAreaSet.has(a.id))
                  .slice(0, 8)
                  .map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className="lang-btn"
                      style={{ border: '1px solid var(--border-subtle)', padding: '4px 8px', fontSize: '11px' }}
                      onClick={() => onToggleArea?.(a.id)}
                      title={`Add ${a.name} to comparison`}
                    >
                      + {a.name} ({a.fileCount})
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      </aside>
    );
  }

  // 1B. AREA INSPECTOR VIEW (when an architectural area is focused)
  if (!selectedNode && !selectedEdge && selectedAreaId) {
    const currentArea = repoStructure?.areaMap.get(selectedAreaId);
    return (
      <aside className={`inspector-panel ${isCollapsed ? 'collapsed' : ''}`}>
        <div className="inspector-header">
          <div className="node-title-group">
            <Folder size={16} color="#38bdf8" />
            <h3 className="file-name">{currentArea?.name || selectedAreaId}</h3>
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
            <button
              className="close-btn"
              onClick={() => onSelectArea?.(null)}
              title="Return to repository overview"
              aria-label="Close area view"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div key={selectedAreaId} className="inspector-content animate-reveal">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <button
              type="button"
              className="area-back-btn"
              onClick={() => onSelectArea?.(null)}
              style={{ margin: 0 }}
            >
              <ArrowLeft size={13} style={{ marginRight: '4px' }} />
              Back to all areas
            </button>
            {onToggleArea && (
              <button
                type="button"
                className="btn-text text-xs"
                onClick={() => onToggleArea(selectedAreaId)}
                title="Add to multi-area comparison"
                style={{ color: '#38bdf8', cursor: 'pointer', background: 'none', border: 'none', padding: '2px 6px' }}
              >
                + Compare
              </button>
            )}
          </div>

          <div className="area-summary-card">
            <span className="area-path-mono mono">{currentArea?.displayPath || selectedAreaId}</span>
            <p className="area-summary-desc">
              This area contains {currentArea?.fileCount || 0} file{currentArea?.fileCount !== 1 ? 's' : ''} (
              {currentArea?.analyzedCount || 0} analyzed
              {currentArea && currentArea.unsupportedCount > 0 ? `, ${currentArea.unsupportedCount} unsupported` : ''}
              ) with {currentArea?.internalConnections || 0} internal connection{currentArea?.internalConnections !== 1 ? 's' : ''}.
            </p>
          </div>

          <div className="stats-grid">
            <div className="stat-card">
              <span className="stat-label">Internal Edges</span>
              <span className="stat-value">{currentArea?.internalConnections || 0}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">External Deps</span>
              <span className="stat-value">{currentArea?.totalDependencies || 0}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">External Dependents</span>
              <span className="stat-value">{currentArea?.totalDependents || 0}</span>
            </div>
          </div>

          {/* Outgoing Area Dependencies */}
          <div className="relations-section" style={{ marginTop: '10px' }}>
            <div className="section-title">
              <ArrowUpRight size={14} color="#38bdf8" />
              <h4>Areas this Area Uses ({currentArea?.outgoingAreaEdges.length || 0})</h4>
            </div>
            {(!currentArea || currentArea.outgoingAreaEdges.length === 0) ? (
              <p className="empty-hint">This area does not depend on any other areas.</p>
            ) : (
              <div className="area-edges-list">
                {currentArea.outgoingAreaEdges.map((edge) => {
                  const tgtArea = repoStructure?.areaMap.get(edge.targetAreaId);
                  return (
                    <button
                      key={edge.id}
                      type="button"
                      className="area-relation-btn"
                      onClick={() => setFocusedAreaEdge(edge)}
                      title={`Inspect dependencies on ${tgtArea?.name || edge.targetAreaId}`}
                    >
                      <div className="area-rel-info">
                        <span className="area-rel-target mono">→ {tgtArea?.name || edge.targetAreaId}</span>
                        <span className="area-rel-meta">
                          {edge.edgeCount} connection{edge.edgeCount === 1 ? '' : 's'} across {edge.sourceFilesCount} file{edge.sourceFilesCount === 1 ? '' : 's'}
                        </span>
                      </div>
                      <ChevronRight size={13} className="link-icon" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Incoming Area Dependents */}
          <div className="relations-section" style={{ marginTop: '10px' }}>
            <div className="section-title">
              <ArrowDownLeft size={14} color="#2dd4bf" />
              <h4>Areas that Use this Area ({currentArea?.incomingAreaEdges.length || 0})</h4>
            </div>
            {(!currentArea || currentArea.incomingAreaEdges.length === 0) ? (
              <p className="empty-hint">No other areas depend on this area.</p>
            ) : (
              <div className="area-edges-list">
                {currentArea.incomingAreaEdges.map((edge) => {
                  const srcArea = repoStructure?.areaMap.get(edge.sourceAreaId);
                  return (
                    <button
                      key={edge.id}
                      type="button"
                      className="area-relation-btn"
                      onClick={() => setFocusedAreaEdge(edge)}
                      title={`Inspect incoming connections from ${srcArea?.name || edge.sourceAreaId}`}
                    >
                      <div className="area-rel-info">
                        <span className="area-rel-target mono">← {srcArea?.name || edge.sourceAreaId}</span>
                        <span className="area-rel-meta">
                          {edge.edgeCount} connection{edge.edgeCount === 1 ? '' : 's'} across {edge.targetFilesCount} file{edge.targetFilesCount === 1 ? '' : 's'}
                        </span>
                      </div>
                      <ChevronRight size={13} className="link-icon" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Files in this Area */}
          <div className="relations-section" style={{ marginTop: '14px' }}>
            <div className="section-title">
              <Layers size={14} />
              <h4>Files in this Area ({currentArea?.nodes.length || 0})</h4>
            </div>
            <ul className="relation-list">
              {currentArea?.nodes.map((node) => (
                <li key={node.id} className="area-file-row">
                  <button
                    type="button"
                    className="area-file-inspect-btn"
                    onClick={() => onSelectNode(node)}
                    title={`Inspect ${node.relative_path}`}
                  >
                    <div
                      className="color-dot-small"
                      style={{ backgroundColor: getFileTypeColor(node.relative_path) }}
                    />
                    <span className="rel-path mono">{node.filename}</span>
                    {node.analysis_status === 'Unsupported' && (
                      <span className="file-badge unsupported">unsupported</span>
                    )}
                  </button>
                  {onRevealNode && (
                    <button
                      type="button"
                      className="area-file-reveal-btn"
                      onClick={() => onRevealNode(node.id)}
                      title={`Reveal ${node.filename} in 3D graph`}
                      aria-label={`Reveal ${node.filename} in 3D`}
                    >
                      <LocateFixed size={12} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </aside>
    );
  }

  // 2. REPOSITORY OVERVIEW (Default view when no node, edge, or area is selected)
  if (!selectedNode && !selectedEdge) {
    if (!snapshot) return null;
    const totalDiscovered = snapshot.coverage.total_discovered;
    const totalAnalyzed = snapshot.coverage.total_analyzed;
    const unsupportedCount = snapshot.nodes.filter((n) => n.analysis_status === 'Unsupported').length;

    return (
      <aside className={`inspector-panel ${isCollapsed ? 'collapsed' : ''}`}>
        <div className="inspector-header">
          <h3>Repository Overview</h3>
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
        <div key="overview" className="inspector-content animate-reveal">
          {/* Beginner-friendly plain English summary */}
          <div className="beginner-overview-card">
            <div className="beginner-card-title">
              <Layers size={15} color="#38bdf8" />
              <span>Repository overview</span>
            </div>
            <p className="beginner-card-text">
              PreBase discovered <strong>{totalDiscovered}</strong> files across{' '}
              <strong>{repoStructure?.areas.length || 0}</strong> architectural areas. Analyzed{' '}
              <strong>{totalAnalyzed}</strong> supported files for internal dependencies and confirmed{' '}
              <strong>{snapshot.edges.length}</strong> direct code connections.
              {unsupportedCount > 0 && (
                <span> ({unsupportedCount} files are unsupported formats excluded from AST dependency analysis.)</span>
              )}
            </p>
          </div>

          {/* Quick Action: Dependency Path Explorer */}
          <div style={{ marginBottom: '14px' }}>
            <button
              type="button"
              className="btn secondary text-xs"
              onClick={() => onTogglePathExplorer?.(true)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
                padding: '8px 12px',
                borderRadius: '6px',
                background: 'var(--card-bg, #1e293b)',
                border: '1px solid var(--border-color, #334155)',
                color: 'var(--text-primary, #f8fafc)',
                cursor: 'pointer',
              }}
              title="Find verified dependency paths between two files"
            >
              <Route size={14} color="#2dd4bf" />
              <span className="font-medium">Explore Dependency Paths</span>
            </button>
          </div>

          {/* Key Files Worth Exploring */}
          {repoStructure && repoStructure.suggestions.length > 0 && (
            <div className="exploration-section">
              <div className="section-title">
                <Compass size={14} color="#2dd4bf" />
                <h4>Start here</h4>
              </div>
              <div className="suggestion-cards-list">
                {repoStructure.suggestions.slice(0, 4).map((sug) => {
                  const node = snapshot.nodes.find((n) => n.id === sug.nodeId);
                  return (
                    <button
                      key={sug.nodeId}
                      type="button"
                      className="suggestion-card clickable"
                      onClick={() => {
                        if (node) onSelectNode(node);
                      }}
                      title={`Inspect ${sug.relativePath}`}
                    >
                      <div className="sug-header">
                        <span className="sug-title">{sug.title}</span>
                        <span className={`sug-badge ${sug.kind}`}>{sug.badge}</span>
                      </div>
                      <div className="sug-filename mono">{sug.filename}</div>
                      <p className="sug-reason">{sug.reason}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Explore by Area Section */}
          {repoStructure && repoStructure.areas.length > 0 && (
            <div className="areas-section">
              <div className="section-title">
                <Folder size={14} color="#38bdf8" />
                <h4>Areas</h4>
              </div>
              <div className="areas-grid">
                {repoStructure.areas.map((area) => (
                  <div key={area.id} style={{ display: 'flex', gap: '3px', alignItems: 'stretch' }}>
                    <button
                      type="button"
                      className={`area-pill-card ${selectedAreaIds?.includes(area.id) ? 'selected' : ''}`}
                      onClick={() => onSelectArea?.(area.id)}
                      title={`Focus on area: ${area.displayPath}`}
                      style={{ flex: 1 }}
                    >
                      <span className="area-pill-name">{area.name}</span>
                      <span className="area-pill-meta">
                        {area.fileCount} file{area.fileCount !== 1 ? 's' : ''} · {area.outgoingAreaEdges.length + area.incomingAreaEdges.length} area links
                      </span>
                    </button>
                    {onToggleArea && (
                      <button
                        type="button"
                        className="icon-action-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleArea(area.id);
                        }}
                        title={
                          selectedAreaIds?.includes(area.id)
                            ? `Deselect ${area.name}`
                            : `Add ${area.name} to comparison`
                        }
                        aria-label={
                          selectedAreaIds?.includes(area.id)
                            ? `Deselect ${area.name}`
                            : `Add ${area.name} to comparison`
                        }
                        style={{
                          borderRadius: '6px',
                          border: '1px solid var(--border-subtle, #334155)',
                          padding: '0 6px',
                          background: selectedAreaIds?.includes(area.id)
                            ? 'rgba(56, 189, 248, 0.2)'
                            : 'transparent',
                        }}
                      >
                        {selectedAreaIds?.includes(area.id) ? (
                          <Check size={12} color="#38bdf8" />
                        ) : (
                          <Plus size={12} />
                        )}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Architectural Insights: Circular Dependencies */}
          {snapshot.insights && (
            <div className="insights-section">
              <div className="section-title">
                <Repeat
                  size={14}
                  color={snapshot.insights.cycle_groups.length > 0 ? '#f59e0b' : '#2dd4bf'}
                />
                <h4>Circular Dependencies ({snapshot.insights.cycle_groups.length})</h4>
              </div>
              {snapshot.insights.cycle_groups.length === 0 ? (
                <div className="insight-clean-card">
                  <CheckCircle2 size={14} color="#2dd4bf" />
                  <span>No circular dependencies detected. Graph is a clean DAG.</span>
                </div>
              ) : (
                <div className="cycle-groups-list">
                  <p className="insight-warning-text">
                    {snapshot.insights.cycle_groups.length} cycle group(s) involving{' '}
                    {snapshot.insights.total_cycle_files} files (click group to inspect & highlight):
                  </p>
                  {snapshot.insights.cycle_groups.map((cg) => {
                    const classification =
                      cg.classification || (cg.is_type_only ? 'TypeOnly' : 'RuntimeRelevant');
                    const badgeText =
                      classification === 'RuntimeRelevant'
                        ? 'runtime'
                        : classification === 'MixedStructural'
                          ? 'mixed'
                          : 'type-only';
                    return (
                      <div
                        key={cg.id}
                        className="cycle-group-card clickable"
                        onClick={() => onSelectCycleGroup?.(cg)}
                        title={`Select and inspect Cycle Group #${cg.id}`}
                      >
                        <div className="cycle-group-header">
                          <span className="cycle-group-name">Cycle Group #{cg.id}</span>
                          <span className={`type-badge small ${badgeText}`}>{badgeText}</span>
                          <span className="cycle-files-count">
                            {cg.files.length} files ({cg.edge_count} edges)
                          </span>
                        </div>
                        <div className="cycle-path-display mono">
                          {cg.example_cycle.map((f, idx) => (
                            <React.Fragment key={idx}>
                              <button
                                type="button"
                                className="cycle-node-link clickable"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const target = snapshot.nodes.find(
                                    (n) => n.id === f || n.relative_path === f
                                  );
                                  if (target) onSelectNode(target);
                                }}
                                title={`Inspect ${f}`}
                              >
                                {f.split('/').pop()}
                              </button>
                              {idx < cg.example_cycle.length - 1 && (
                                <span className="cycle-arrow">→</span>
                              )}
                            </React.Fragment>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Architectural Insights: Top Depended-On Files */}
          {snapshot.insights && snapshot.insights.highly_depended_files.length > 0 && (
            <div className="insights-section">
              <div className="section-title">
                <Layers size={14} color="#a78bfa" />
                <h4>Most Depended-On Files</h4>
              </div>
              <div className="depended-files-list">
                {snapshot.insights.highly_depended_files.slice(0, 5).map((f) => {
                  const node = snapshot.nodes.find(
                    (n) => n.id === f.file_id || n.relative_path === f.relative_path
                  );
                  return (
                    <button
                      key={f.file_id}
                      type="button"
                      className="depended-file-item clickable"
                      onClick={() => {
                        if (node) onSelectNode(node);
                      }}
                      title={`Inspect ${f.relative_path}`}
                    >
                      <span className="depended-file-path mono">{f.relative_path}</span>
                      <span className="depended-file-counts">
                        <strong>{f.dependent_count}</strong> uses
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Architectural Insights: Area Coupling */}
          {snapshot.insights && snapshot.insights.area_couplings.length > 0 && (
            <div className="insights-section area-coupling-section">
              <div className="section-title">
                <Layers size={14} color="#38bdf8" />
                <h4>Architectural Area Coupling</h4>
              </div>
              <div className="area-couplings-list" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                {snapshot.insights.area_couplings.slice(0, 6).map((ac) => (
                  <div
                    key={ac.area_id}
                    className="area-coupling-card"
                    style={{
                      padding: '8px 10px',
                      borderRadius: '6px',
                      background: 'var(--card-bg, #1e293b)',
                      border: '1px solid var(--border-color, #334155)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <button
                        type="button"
                        className="area-name-btn clickable font-medium text-xs mono"
                        onClick={() => onSelectArea?.(ac.area_id)}
                        style={{ background: 'none', border: 'none', color: '#38bdf8', cursor: 'pointer', padding: 0 }}
                        title={`Focus on area: ${ac.area_id}`}
                      >
                        {ac.area_id}
                      </button>
                      <span className="text-xs text-muted">
                        {ac.file_count} files
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: '12px', marginTop: '4px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                      <span><strong>{ac.internal_edge_count}</strong> internal</span>
                      <span><strong>{ac.outbound_edge_count}</strong> out</span>
                      <span><strong>{ac.inbound_edge_count}</strong> in</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Architectural Insights: Diagnostics Summary */}
          {snapshot.insights && (
            <div className="diagnostics-summary-box">
              <div className="section-title">
                <Info size={14} color="#94a3b8" />
                <h4>Analysis Diagnostics</h4>
              </div>
              <div className="diagnostics-grid">
                <div className="diag-stat">
                  <span className="diag-label">Discovered</span>
                  <span className="diag-val">{snapshot.insights.diagnostics_summary.total_discovered}</span>
                </div>
                <div className="diag-stat">
                  <span className="diag-label">Analyzed</span>
                  <span className="diag-val">{snapshot.insights.diagnostics_summary.total_analyzed}</span>
                </div>
                {snapshot.insights.diagnostics_summary.total_fully_analyzed !== undefined && (
                  <div className="diag-stat">
                    <span className="diag-label">Fully Analyzed</span>
                    <span className="diag-val">{snapshot.insights.diagnostics_summary.total_fully_analyzed}</span>
                  </div>
                )}
                <div className="diag-stat">
                  <span className="diag-label">Partially Analyzed</span>
                  <span className="diag-val">{snapshot.insights.diagnostics_summary.total_partially_analyzed}</span>
                </div>
                <div className="diag-stat">
                  <span className="diag-label">Unsupported</span>
                  <span className="diag-val">{snapshot.insights.diagnostics_summary.total_unsupported}</span>
                </div>
                <div className="diag-stat">
                  <span className="diag-label">Failed</span>
                  <span className="diag-val">{snapshot.insights.diagnostics_summary.total_failed}</span>
                </div>
                <div className="diag-stat">
                  <span className="diag-label">Unresolved Imports</span>
                  <span className="diag-val">{snapshot.insights.diagnostics_summary.total_unresolved_imports}</span>
                </div>
              </div>

              {snapshot.issues.length > 0 && (
                <div style={{ marginTop: '10px' }}>
                  <button
                    type="button"
                    className="btn-text text-xs"
                    onClick={() => setIsDiagnosticsExpanded(!isDiagnosticsExpanded)}
                    style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                  >
                    {isDiagnosticsExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    {isDiagnosticsExpanded
                      ? 'Hide issues list'
                      : `View all ${snapshot.issues.length} issues`}
                  </button>

                  {isDiagnosticsExpanded && (
                    <div style={{ marginTop: '8px' }}>
                      <div style={{ marginBottom: '6px' }}>
                        <select
                          className="text-xs"
                          value={diagnosticsFilterCategory}
                          onChange={(e) => setDiagnosticsFilterCategory(e.target.value)}
                          style={{
                            padding: '3px 6px',
                            borderRadius: '4px',
                            background: 'var(--card-bg, #1e293b)',
                            border: '1px solid var(--border-color, #334155)',
                            color: 'var(--text-primary)',
                          }}
                        >
                          <option value="all">All Issues ({snapshot.issues.length})</option>
                          <option value="UnresolvedImport">Unresolved Imports</option>
                          <option value="UnresolvedInternalTarget">Unresolved Internal Targets</option>
                          <option value="UnsupportedImport">Unsupported Imports</option>
                        </select>
                      </div>

                      <ul className="issues-list" style={{ maxHeight: '180px', overflowY: 'auto' }}>
                        {snapshot.issues
                          .filter(
                            (iss) =>
                              diagnosticsFilterCategory === 'all' ||
                              iss.issue_kind === diagnosticsFilterCategory
                          )
                          .map((iss, i) => (
                            <li key={i} style={{ fontSize: '11px', marginBottom: '4px' }}>
                              <button
                                type="button"
                                className="clickable mono"
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  color: '#38bdf8',
                                  textAlign: 'left',
                                  padding: 0,
                                  cursor: 'pointer',
                                }}
                                onClick={() => {
                                  const node = snapshot.nodes.find(
                                    (n) => n.id === iss.file_path || n.relative_path === iss.file_path
                                  );
                                  if (node) onSelectNode(node);
                                }}
                              >
                                {iss.file_path}
                                {iss.line ? `:${iss.line}` : ''}:
                              </button>{' '}
                              <span className="text-muted">{iss.message}</span>
                            </li>
                          ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Analysis boundaries and honest limitations */}
          <div className="limitations-box">
            <div className="limitations-title">
              <Info size={14} color="#94a3b8" />
              <span>Coverage</span>
            </div>
            <p className="limitations-desc">
              PreBase maps verified static internal imports between files. External libraries (npm/crates), standard
              libraries, and dynamic runtime reflection are excluded from internal dependency lines.
            </p>
          </div>

          {/* Issues Box if present */}
          {snapshot.issues.length > 0 && (
            <div className="issues-box">
              <div className="issues-title">
                <AlertTriangle size={15} color="#f59e0b" />
                <span>Issues & Unresolved Imports ({snapshot.issues.length})</span>
              </div>
              <ul className="issues-list">
                {snapshot.issues.slice(0, 5).map((iss, i) => (
                  <li key={i}>
                    <strong>{iss.file_path}:</strong> {iss.message}
                  </li>
                ))}
                {snapshot.issues.length > 5 && (
                  <li className="dim">...and {snapshot.issues.length - 5} more issues</li>
                )}
              </ul>
            </div>
          )}

          <div className="guide-box">
            <h4>Quick Navigation</h4>
            <p>Click any file node on the 3D orb to inspect its code relations.</p>
            <p>Click any connection line to inspect the exact import statement.</p>
            <p className="mono hint">Press "/" anywhere to search files quickly.</p>
          </div>
        </div>
      </aside>
    );
  }

  // 3. SELECTED EDGE VIEW
  if (selectedEdge) {
    const summarySentence = getEdgeRelationshipSentence(selectedEdge);
    return (
      <aside className={`inspector-panel ${isCollapsed ? 'collapsed' : ''}`}>
        <div className="inspector-header">
          <div className="node-title-group">
            <Layers size={16} color="#2dd4bf" />
            <h3 className="file-name">Dependency Relationship</h3>
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
            <button className="close-btn" onClick={onClose} title="Close inspector" aria-label="Close inspector">
              <X size={16} />
            </button>
          </div>
        </div>

        <div key={selectedEdge.id} className="inspector-content animate-reveal">
          <div className="edge-plain-summary">
            {summarySentence}
          </div>

          <div className="relationship-card">
            <button
              type="button"
              className="rel-endpoint clickable"
              onClick={() => {
                const src = snapshot?.nodes.find((n) => n.id === selectedEdge.source_file_id);
                if (src) onSelectNode(src);
              }}
              title={`Inspect ${selectedEdge.source_file_id}`}
            >
              <FileCode size={14} color="#38bdf8" />
              <span className="mono">{selectedEdge.source_file_id}</span>
            </button>
            <div className="rel-arrow">
              <ArrowRight size={16} color="#2dd4bf" />
              <span className="rel-kind">{selectedEdge.relationship_kind}</span>
            </div>
            <button
              type="button"
              className="rel-endpoint clickable"
              onClick={() => {
                const tgt = snapshot?.nodes.find((n) => n.id === selectedEdge.target_file_id);
                if (tgt) onSelectNode(tgt);
              }}
              title={`Inspect ${selectedEdge.target_file_id}`}
            >
              <FileCode size={14} color="#a78bfa" />
              <span className="mono">{selectedEdge.target_file_id}</span>
            </button>
          </div>

          <div className="evidence-section">
            <h4>Import Evidence ({selectedEdge.evidence.length})</h4>
            {selectedEdge.evidence.map((ev, idx) => (
              <div key={idx} className="evidence-card">
                <div className="evidence-header">
                  <span className="specifier mono">"{ev.import_specifier}"</span>
                  <span className="location">
                    line {ev.line}:{ev.column}
                  </span>
                </div>
                {ev.is_type_only && <span className="type-badge">type-only</span>}
              </div>
            ))}
          </div>
        </div>
      </aside>
    );
  }

  // 4. SELECTED FILE NODE VIEW
  const fileAreaId = selectedNode ? getAreaIdForPath(selectedNode.relative_path) : null;
  const isCandidateEntry =
    repoStructure?.entryPointCandidate !== null &&
    repoStructure?.entryPointCandidate?.nodeId === selectedNode?.id;

  const relationshipSentence = getNodeRelationshipSentence(selectedNode);
  const isUnsupported = selectedNode?.analysis_status === 'Unsupported';
  const isFailed = selectedNode?.analysis_status === 'Failed';
  const depCount = selectedNode?.direct_dependency_count ?? 0;
  const dependentCount = selectedNode?.direct_dependent_count ?? 0;

  return (
    <aside className={`inspector-panel ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="inspector-header">
        <div className="node-title-group">
          <div
            className="color-dot"
            style={{
              backgroundColor: isCandidateEntry
                ? ENTRY_NODE_COLOR
                : getFileTypeColor(selectedNode?.relative_path),
            }}
          />
          <h3 className="file-name">{selectedNode?.filename}</h3>
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
          <button className="close-btn" onClick={onClose} title="Close inspector" aria-label="Close inspector">
            <X size={16} />
          </button>
        </div>
      </div>

      <div key={selectedNode?.id} className="inspector-content animate-reveal">
        <div className="file-path-wrap">
          <div className="file-path-bar mono">{selectedNode?.relative_path}</div>
          {selectedNode?.relative_path && (
            <button
              type="button"
              className="path-copy-btn"
              onClick={() => handleCopyPath(selectedNode.relative_path)}
              title={copiedPath ? 'Copied!' : 'Copy path to clipboard'}
              aria-label="Copy path"
            >
              {copiedPath ? <Check size={13} color="#2dd4bf" /> : <Copy size={13} />}
            </button>
          )}
        </div>

        {/* Plain-English summary banner */}
        <div className={`file-plain-summary-box ${isUnsupported ? 'unsupported' : isFailed ? 'failed' : ''}`}>
          <p className="file-plain-summary-text">{relationshipSentence}</p>
        </div>

        {/* Action Buttons - Clear Contextual Hierarchy */}
        <div className="inspector-action-buttons">
          {selectedNode && networkViewMode === '3d' && onExplore2D && !isUnsupported && (
            <button
              type="button"
              className="explore-2d-btn primary-action"
              onClick={() => onExplore2D(selectedNode)}
              title="Open focused 2D relationship neighborhood for this file"
            >
              <Compass size={14} />
              <span>Explore Relationships in 2D</span>
            </button>
          )}

          {selectedNode && networkViewMode === '2d' && onRefocus2D && selectedNode.id !== focusNodeId && (
            <button
              type="button"
              className="refocus-2d-btn primary-action"
              onClick={() => onRefocus2D(selectedNode.id)}
              title="Recenter 2D relationship neighborhood on this file"
            >
              <Compass size={14} />
              <span>Focus relationships here</span>
            </button>
          )}

          {selectedNode && networkViewMode === '2d' && onSwitchTo3D && (
            <button
              type="button"
              className="switch-3d-btn primary-action"
              onClick={onSwitchTo3D}
              title="Return to 3D Overview while preserving selection"
            >
              <Layers size={14} />
              <span>View in 3D Overview</span>
            </button>
          )}

          <div className="secondary-action-row">
            {selectedNode && onRevealNode && networkViewMode !== '2d' && (
              <button
                type="button"
                className="reveal-btn secondary-action"
                onClick={() => onRevealNode(selectedNode.id)}
                title="Locate and center this file in the 3D graph"
              >
                <LocateFixed size={13} />
                <span>Reveal in 3D</span>
              </button>
            )}

            {selectedNode && onViewFileHistory && (
              <button
                type="button"
                className="view-history-btn secondary-action"
                onClick={() => onViewFileHistory(selectedNode.relative_path)}
                title="Inspect historical Git commits for this file"
              >
                <Clock size={13} />
                <span>File History</span>
              </button>
            )}

            {selectedNode && onOpenPathExplorer && (
              <button
                type="button"
                className="view-path-btn secondary-action"
                onClick={() => onOpenPathExplorer(selectedNode)}
                title="Trace dependency paths to or from this file"
              >
                <Compass size={13} />
                <span>Trace Path</span>
              </button>
            )}
          </div>
        </div>

        <div className="meta-tags" style={{ marginTop: '12px' }}>
          {fileAreaId && (
            <button
              type="button"
              className="tag area-tag clickable"
              onClick={() => onSelectArea?.(fileAreaId)}
              title={`Focus on area: ${fileAreaId}`}
            >
              <Folder size={11} style={{ marginRight: '4px', display: 'inline-block', verticalAlign: 'middle' }} />
              Area: {fileAreaId}
            </button>
          )}
          {isCandidateEntry && (
            <span className="tag entry-tag">Entry Candidate</span>
          )}
          <span className="tag language-tag">{selectedNode?.language}</span>
          <span className="tag size-tag">
            {((selectedNode?.size_bytes || 0) / 1024).toFixed(1)} KB
          </span>
          <span className={`tag status-tag ${isUnsupported ? 'unsupported' : isFailed ? 'failed' : ''}`}>
            {selectedNode?.analysis_status}
          </span>
        </div>

        <div className="stats-grid" style={{ marginTop: '10px' }}>
          <div className="stat-card">
            <span className="stat-label">Files this file uses</span>
            <span className="stat-value">{depCount}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Files that use this file</span>
            <span className="stat-value">{dependentCount}</span>
          </div>
        </div>

        {loading ? (
          <div className="loading-state">Analyzing relationships...</div>
        ) : isUnsupported ? (
          <div className="limitations-box" style={{ marginTop: '12px' }}>
            <div className="limitations-title">
              <Info size={14} color="#94a3b8" />
              <span>Non-analyzed File Format</span>
            </div>
            <p className="limitations-desc">
              PreBase tracks this file in the repository index. Internal dependency extraction is supported for TypeScript/JavaScript, Rust, and Python source files.
            </p>
          </div>
        ) : (
          <>
            {/* Dependencies */}
            <div className="relations-section">
              <div className="section-title">
                <Layers size={14} />
                <h4>Files this file uses ({inspection?.dependencies.length || 0})</h4>
              </div>
              {inspection?.dependencies.length === 0 ? (
                <p className="empty-hint">No internal dependencies imported.</p>
              ) : (
                <>
                  <ul className="relation-list">
                    {(showAllDeps ? inspection?.dependencies : inspection?.dependencies.slice(0, 20))?.map((dep) => (
                      <li key={dep.id} className="relation-item-wrap">
                        <button
                          type="button"
                          className="relation-item-btn"
                          onClick={() => onSelectNode(dep)}
                          title={`Inspect ${dep.relative_path}`}
                        >
                          <div
                            className="color-dot-small"
                            style={{ backgroundColor: getFileTypeColor(dep.relative_path) }}
                          />
                          <span className="rel-path mono">{dep.relative_path}</span>
                          <ExternalLink size={12} className="link-icon" />
                        </button>
                      </li>
                    ))}
                  </ul>
                  {inspection && inspection.dependencies.length > 20 && (
                    <button
                      type="button"
                      className="toggle-all-impact-btn"
                      onClick={() => setShowAllDeps(!showAllDeps)}
                      style={{
                        background: 'transparent',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: '4px',
                        color: 'var(--text-secondary)',
                        fontSize: '11px',
                        padding: '4px 8px',
                        marginTop: '4px',
                        cursor: 'pointer',
                        display: 'block',
                        width: '100%',
                        textAlign: 'center',
                      }}
                    >
                      {showAllDeps ? 'Show first 20' : `Show remaining ${inspection.dependencies.length - 20} files`}
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Dependents */}
            <div className="relations-section">
              <div className="section-title">
                <ArrowRight size={14} />
                <h4>Files that use this file ({inspection?.dependents.length || 0})</h4>
              </div>
              {inspection?.dependents.length === 0 ? (
                <p className="empty-hint">Not imported by any internal files.</p>
              ) : (
                <>
                  <ul className="relation-list">
                    {(showAllDependents ? inspection?.dependents : inspection?.dependents.slice(0, 20))?.map((dep) => (
                      <li key={dep.id} className="relation-item-wrap">
                        <button
                          type="button"
                          className="relation-item-btn"
                          onClick={() => onSelectNode(dep)}
                          title={`Inspect ${dep.relative_path}`}
                        >
                          <div
                            className="color-dot-small"
                            style={{ backgroundColor: getFileTypeColor(dep.relative_path) }}
                          />
                          <span className="rel-path mono">{dep.relative_path}</span>
                          <ExternalLink size={12} className="link-icon" />
                        </button>
                      </li>
                    ))}
                  </ul>
                  {inspection && inspection.dependents.length > 20 && (
                    <button
                      type="button"
                      className="toggle-all-impact-btn"
                      onClick={() => setShowAllDependents(!showAllDependents)}
                      style={{
                        background: 'transparent',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: '4px',
                        color: 'var(--text-secondary)',
                        fontSize: '11px',
                        padding: '4px 8px',
                        marginTop: '4px',
                        cursor: 'pointer',
                        display: 'block',
                        width: '100%',
                        textAlign: 'center',
                      }}
                    >
                      {showAllDependents ? 'Show first 20' : `Show remaining ${inspection.dependents.length - 20} files`}
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Downstream Transitive Impact Analysis */}
            {impactLoading ? (
              <div className="relations-section impact-section">
                <div className="section-title">
                  <ArrowDownLeft size={14} color="#f59e0b" />
                  <h4>Downstream Impact</h4>
                </div>
                <div className="loading-state" style={{ fontSize: '11px', padding: '6px 0' }}>
                  Analyzing impact cascade...
                </div>
              </div>
            ) : (
              impactAnalysis && (
                <div className="relations-section impact-section">
                  <div
                    className="section-title"
                    onClick={() => setIsImpactExpanded(!isImpactExpanded)}
                    style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                    title={isImpactExpanded ? 'Collapse impact cascade' : 'Expand impact cascade'}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <ArrowDownLeft size={14} color="#f59e0b" />
                      <h4>Downstream Impact ({impactAnalysis.total_impact_count} files)</h4>
                    </div>
                    {isImpactExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </div>
                  {isImpactExpanded && (
                    <>
                      {impactAnalysis.is_part_of_cycle && (
                        <div className="impact-cycle-alert">
                          <Repeat size={12} color="#f59e0b" />
                          <span>Part of a circular dependency group</span>
                        </div>
                      )}
                      <div className="impact-stats-row">
                        <div className="impact-stat">
                          <span className="impact-stat-num">{impactAnalysis.direct_dependents_count}</span>
                          <span className="impact-stat-text">Direct dependents</span>
                        </div>
                        <div className="impact-stat">
                          <span className="impact-stat-num">{impactAnalysis.transitive_dependents_count}</span>
                          <span className="impact-stat-text">Transitive cascade</span>
                        </div>
                      </div>
                      {impactAnalysis.impacted_files.length > 0 && (
                        <div className="impact-files-list">
                          <span className="impact-list-heading">Cascade order:</span>
                          {(showAllImpact ? impactAnalysis.impacted_files : impactAnalysis.impacted_files.slice(0, 10)).map((imp) => {
                            const impNode = snapshot?.nodes.find(
                              (n) => n.id === imp.file_id || n.relative_path === imp.relative_path
                            );
                            return (
                              <button
                                key={imp.file_id}
                                type="button"
                                className="impact-item-btn clickable"
                                onClick={() => {
                                  if (impNode) onSelectNode(impNode);
                                }}
                                title={`Inspect ${imp.relative_path}`}
                              >
                                <span className="depth-badge">d{imp.depth}</span>
                                <span className="impact-path mono">{imp.relative_path}</span>
                                {imp.is_type_only && <span className="type-badge small">type</span>}
                              </button>
                            );
                          })}
                          {impactAnalysis.impacted_files.length > 10 && (
                            <button
                              type="button"
                              className="toggle-all-impact-btn"
                              onClick={() => setShowAllImpact(!showAllImpact)}
                              style={{
                                background: 'transparent',
                                border: '1px solid var(--border)',
                                borderRadius: '4px',
                                color: 'var(--text-secondary)',
                                fontSize: '11px',
                                padding: '4px 8px',
                                marginTop: '6px',
                                cursor: 'pointer',
                                display: 'block',
                                width: '100%',
                                textAlign: 'center',
                              }}
                            >
                              {showAllImpact
                                ? 'Show top 10 files'
                                : `Show all ${impactAnalysis.impacted_files.length} cascade files`}
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )
            )}

            {/* Source preview snippet */}
            {sourcePreview && (
              <div className="source-preview-section">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <h4 style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Source Preview</h4>
                  <button
                    type="button"
                    className="path-copy-btn"
                    onClick={() => handleCopyCode(sourcePreview)}
                    title={copiedCode ? 'Copied code!' : 'Copy source snippet'}
                    aria-label="Copy source code"
                  >
                    {copiedCode ? <Check size={12} color="#2dd4bf" /> : <Copy size={12} />}
                  </button>
                </div>
                <pre className="source-code-block">
                  <code>{sourcePreview.slice(0, 1200)}</code>
                  {sourcePreview.length > 1200 && '...'}
                </pre>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
};

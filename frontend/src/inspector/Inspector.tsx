import React, { useEffect, useState, useRef, useMemo } from 'react';
import { DependencyEdge, FileInspection, FileNode, GraphSnapshot } from '../types/graph';
import { api } from '../transport/api';
import { getFileTypeColor, ENTRY_NODE_COLOR } from '../graphs/network/fileTypeColors';
import {
  deriveRepositoryStructure,
  getAreaIdForPath,
  AreaEdge,
} from '../utils/repositoryAreas';
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
} from 'lucide-react';

interface InspectorProps {
  selectedNode: FileNode | null;
  selectedEdge: DependencyEdge | null;
  selectedAreaId?: string | null;
  onSelectArea?: (areaId: string | null) => void;
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
  onSelectArea,
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
  const [copiedPath, setCopiedPath] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [focusedAreaEdge, setFocusedAreaEdge] = useState<AreaEdge | null>(null);

  const requestTokenRef = useRef(0);
  const pathCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codeCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear focused area edge when area changes or selection clears
  useEffect(() => {
    setFocusedAreaEdge(null);
  }, [selectedAreaId]);

  const handleCopyPath = (path: string) => {
    if (!navigator?.clipboard) return;
    navigator.clipboard
      .writeText(path)
      .then(() => {
        setCopiedPath(true);
        if (pathCopyTimerRef.current) clearTimeout(pathCopyTimerRef.current);
        pathCopyTimerRef.current = setTimeout(() => setCopiedPath(false), 2000);
      })
      .catch(() => {});
  };

  const handleCopyCode = (code: string) => {
    if (!navigator?.clipboard) return;
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopiedCode(true);
        if (codeCopyTimerRef.current) clearTimeout(codeCopyTimerRef.current);
        codeCopyTimerRef.current = setTimeout(() => setCopiedCode(false), 2000);
      })
      .catch(() => {});
  };

  useEffect(() => {
    return () => {
      if (pathCopyTimerRef.current) clearTimeout(pathCopyTimerRef.current);
      if (codeCopyTimerRef.current) clearTimeout(codeCopyTimerRef.current);
    };
  }, []);

  // Compute structured repository areas and beginner suggestions
  const repoStructure = useMemo(() => {
    if (!snapshot) return null;
    return deriveRepositoryStructure(snapshot.nodes, snapshot.edges);
  }, [snapshot]);

  useEffect(() => {
    if (selectedNode) {
      const currentToken = ++requestTokenRef.current;
      const abortController = new AbortController();

      setLoading(true);
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

      return () => {
        abortController.abort();
      };
    } else {
      setInspection(null);
      setSourcePreview(null);
    }
  }, [selectedNode]);

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
          <button
            type="button"
            className="area-back-btn"
            onClick={() => onSelectArea?.(null)}
          >
            <ArrowLeft size={13} style={{ marginRight: '4px' }} />
            Back to all areas
          </button>

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
                  <button
                    key={area.id}
                    type="button"
                    className="area-pill-card"
                    onClick={() => onSelectArea?.(area.id)}
                    title={`Focus on area: ${area.displayPath}`}
                  >
                    <span className="area-pill-name">{area.name}</span>
                    <span className="area-pill-meta">
                      {area.fileCount} file{area.fileCount !== 1 ? 's' : ''} · {area.outgoingAreaEdges.length + area.incomingAreaEdges.length} area links
                    </span>
                  </button>
                ))}
              </div>
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

        <div className="meta-tags">
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

        {/* Action Buttons */}
        <div className="inspector-action-buttons">
          {selectedNode && onRevealNode && networkViewMode !== '2d' && (
            <button
              type="button"
              className="reveal-btn"
              onClick={() => onRevealNode(selectedNode.id)}
              title="Locate and center this file in the 3D graph"
            >
              <LocateFixed size={14} />
              <span>Reveal in 3D</span>
            </button>
          )}

          {selectedNode && networkViewMode === '3d' && onExplore2D && !isUnsupported && (
            <button
              type="button"
              className="explore-2d-btn"
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
              className="refocus-2d-btn"
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
              className="switch-3d-btn"
              onClick={onSwitchTo3D}
              title="Return to 3D Overview while preserving selection"
            >
              <Layers size={14} />
              <span>View in 3D Overview</span>
            </button>
          )}

          {selectedNode && onViewFileHistory && (
            <button
              type="button"
              className="view-history-btn"
              onClick={() => onViewFileHistory(selectedNode.relative_path)}
              title="Inspect historical Git commits for this file"
            >
              <Clock size={14} />
              <span>View File History</span>
            </button>
          )}
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
              PreBase tracks this file in the repository index, but only TypeScript and JavaScript files currently undergo AST-level dependency extraction.
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
                <ul className="relation-list">
                  {inspection?.dependencies.map((dep) => (
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
                <ul className="relation-list">
                  {inspection?.dependents.map((dep) => (
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
              )}
            </div>

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

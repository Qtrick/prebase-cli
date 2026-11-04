import React, { useEffect, useState, useRef, useMemo } from 'react';
import { DependencyEdge, FileInspection, FileNode, GraphSnapshot } from '../types/graph';
import { api } from '../transport/api';
import { getFileTypeColor, ENTRY_NODE_COLOR } from '../graphs/network/fileTypeColors';
import {
  deriveRepositoryStructure,
  getAreaIdForPath,
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
  Sparkles,
  Info,
  ChevronRight,
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

  const requestTokenRef = useRef(0);
  const pathCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codeCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          if (currentToken === requestTokenRef.current) {
            setInspection(res);
            setLoading(false);
          }
        })
        .catch((err) => {
          if (currentToken === requestTokenRef.current) {
            if (err instanceof Error && err.name === 'AbortError') return;
            setLoading(false);
          }
        });

      // Fetch source snippet
      api
        .getSource(selectedNode.relative_path, abortController.signal)
        .then((res) => {
          if (currentToken === requestTokenRef.current) {
            setSourcePreview(res.content);
          }
        })
        .catch(() => {
          if (currentToken === requestTokenRef.current) {
            setSourcePreview(null);
          }
        });

      return () => {
        abortController.abort();
      };
    } else {
      setInspection(null);
      setSourcePreview(null);
    }
  }, [selectedNode]);

  // 1. AREA INSPECTOR VIEW (when an architectural area is focused)
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
            ← Back to all areas
          </button>

          <div className="area-summary-card">
            <span className="area-path-mono mono">{currentArea?.displayPath || selectedAreaId}</span>
            <p className="area-summary-desc">
              This area contains {currentArea?.fileCount || 0} file{currentArea?.fileCount !== 1 ? 's' : ''} with{' '}
              {currentArea?.internalConnections || 0} internal connection{currentArea?.internalConnections !== 1 ? 's' : ''}.
            </p>
          </div>

          <div className="stats-grid">
            <div className="stat-card">
              <span className="stat-label">External Deps</span>
              <span className="stat-value">{currentArea?.totalDependencies || 0}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">External Dependents</span>
              <span className="stat-value">{currentArea?.totalDependents || 0}</span>
            </div>
          </div>

          <div className="relations-section" style={{ marginTop: '14px' }}>
            <div className="section-title">
              <Layers size={14} />
              <h4>Files in this Area ({currentArea?.nodes.length || 0})</h4>
            </div>
            <ul className="relation-list">
              {currentArea?.nodes.map((node) => (
                <li
                  key={node.id}
                  className="relation-item"
                  onClick={() => {
                    onSelectNode(node);
                    onRevealNode?.(node.id);
                  }}
                  title={`Inspect ${node.relative_path}`}
                >
                  <div
                    className="color-dot-small"
                    style={{ backgroundColor: getFileTypeColor(node.relative_path) }}
                  />
                  <span className="rel-path mono">{node.filename}</span>
                  <ChevronRight size={12} className="link-icon" />
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
              <Sparkles size={16} color="#38bdf8" />
              <span>What PreBase Found</span>
            </div>
            <p className="beginner-card-text">
              PreBase analyzed <strong>{snapshot.coverage.total_analyzed}</strong> files across{' '}
              <strong>{repoStructure?.areas.length || 0}</strong> codebase areas and detected{' '}
              <strong>{snapshot.edges.length}</strong> direct internal code connections.
            </p>
          </div>

          {/* Key Files Worth Exploring */}
          {repoStructure && repoStructure.suggestions.length > 0 && (
            <div className="exploration-section">
              <div className="section-title">
                <Compass size={14} color="#2dd4bf" />
                <h4>Files Worth Exploring First</h4>
              </div>
              <div className="suggestion-cards-list">
                {repoStructure.suggestions.slice(0, 4).map((sug) => {
                  const node = snapshot.nodes.find((n) => n.id === sug.nodeId);
                  return (
                    <div
                      key={sug.nodeId}
                      className="suggestion-card clickable"
                      onClick={() => {
                        if (node) {
                          onSelectNode(node);
                          onRevealNode?.(node.id);
                        }
                      }}
                      title={`Inspect ${sug.relativePath}`}
                    >
                      <div className="sug-header">
                        <span className="sug-title">{sug.title}</span>
                        <span className={`sug-badge ${sug.kind}`}>{sug.badge}</span>
                      </div>
                      <div className="sug-filename mono">{sug.filename}</div>
                      <p className="sug-reason">{sug.reason}</p>
                    </div>
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
                <h4>Explore Codebase by Area</h4>
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
                      {area.fileCount} file{area.fileCount !== 1 ? 's' : ''}
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
              <span>Analysis Scope & Boundaries</span>
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
            <strong>"{selectedEdge.source_file_id}"</strong> directly imports from{' '}
            <strong>"{selectedEdge.target_file_id}"</strong>.
          </div>

          <div className="relationship-card">
            <div
              className="rel-endpoint clickable"
              onClick={() => {
                const src = snapshot?.nodes.find((n) => n.id === selectedEdge.source_file_id);
                if (src) onSelectNode(src);
              }}
            >
              <FileCode size={14} color="#38bdf8" />
              <span className="mono">{selectedEdge.source_file_id}</span>
            </div>
            <div className="rel-arrow">
              <ArrowRight size={16} color="#2dd4bf" />
              <span className="rel-kind">{selectedEdge.relationship_kind}</span>
            </div>
            <div
              className="rel-endpoint clickable"
              onClick={() => {
                const tgt = snapshot?.nodes.find((n) => n.id === selectedEdge.target_file_id);
                if (tgt) onSelectNode(tgt);
              }}
            >
              <FileCode size={14} color="#a78bfa" />
              <span className="mono">{selectedEdge.target_file_id}</span>
            </div>
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

  const depCount = selectedNode?.direct_dependency_count ?? 0;
  const dependentCount = selectedNode?.direct_dependent_count ?? 0;

  let relationshipSentence = '';
  if (depCount === 0 && dependentCount === 0) {
    relationshipSentence = 'This file has no direct internal dependencies or dependents in this repository.';
  } else if (depCount > 0 && dependentCount === 0) {
    relationshipSentence = `This file uses ${depCount} internal file${depCount > 1 ? 's' : ''}, and is not directly imported by any other indexed files.`;
  } else if (depCount === 0 && dependentCount > 0) {
    relationshipSentence = `This file is a foundation file used by ${dependentCount} other file${dependentCount > 1 ? 's' : ''}, and imports no other indexed files.`;
  } else {
    relationshipSentence = `This file uses ${depCount} internal file${depCount > 1 ? 's' : ''} and is used by ${dependentCount} other file${dependentCount > 1 ? 's' : ''}.`;
  }

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
        <div className="file-plain-summary-box">
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
          <span className="tag status-tag">{selectedNode?.analysis_status}</span>
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
              className="reveal-btn"
              onClick={() => onRevealNode(selectedNode.id)}
              title="Locate and center this file in the 3D graph"
            >
              <LocateFixed size={14} />
              <span>Reveal in 3D</span>
            </button>
          )}

          {selectedNode && networkViewMode === '3d' && onExplore2D && (
            <button
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
                    <li
                      key={dep.id}
                      className="relation-item"
                      onClick={() => onSelectNode(dep)}
                      title={`Inspect ${dep.relative_path}`}
                    >
                      <div
                        className="color-dot-small"
                        style={{ backgroundColor: getFileTypeColor(dep.relative_path) }}
                      />
                      <span className="rel-path mono">{dep.relative_path}</span>
                      <ExternalLink size={12} className="link-icon" />
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
                    <li
                      key={dep.id}
                      className="relation-item"
                      onClick={() => onSelectNode(dep)}
                      title={`Inspect ${dep.relative_path}`}
                    >
                      <div
                        className="color-dot-small"
                        style={{ backgroundColor: getFileTypeColor(dep.relative_path) }}
                      />
                      <span className="rel-path mono">{dep.relative_path}</span>
                      <ExternalLink size={12} className="link-icon" />
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

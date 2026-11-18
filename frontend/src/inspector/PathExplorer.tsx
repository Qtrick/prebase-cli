import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  DependencyPathResult,
  FileNode,
  GraphSnapshot,
  PathDirection,
} from '../types/graph';
import { api } from '../transport/api';
import {
  Route,
  ArrowRight,
  ArrowLeftRight,
  X,
  Compass,
  Layers,
  FileCode,
  AlertCircle,
  CheckCircle2,
  Info,
} from 'lucide-react';

interface PathExplorerProps {
  initialSourceNode: FileNode | null;
  initialTargetNode?: FileNode | null;
  initialResult?: DependencyPathResult | null;
  initialDirection?: PathDirection;
  initialIncludeTypes?: boolean;
  initialShowSourceDropdown?: boolean;
  initialShowTargetDropdown?: boolean;
  initialExpandedEdgeId?: string | null;
  initialLoading?: boolean;
  initialError?: string | null;
  snapshot: GraphSnapshot | null;
  onSelectNode: (node: FileNode) => void;
  onClose: () => void;
  onActivePathChange?: (result: DependencyPathResult | null) => void;
  onSwitchTo3D?: () => void;
  onExplore2D?: (node: FileNode) => void;
}

export const PathExplorer: React.FC<PathExplorerProps> = ({
  initialSourceNode,
  initialTargetNode = null,
  initialResult = null,
  initialDirection = 'outgoing',
  initialIncludeTypes = true,
  initialShowSourceDropdown = false,
  initialShowTargetDropdown = false,
  initialExpandedEdgeId = null,
  initialLoading = false,
  initialError = null,
  snapshot,
  onSelectNode,
  onClose,
  onActivePathChange,
  onSwitchTo3D,
  onExplore2D,
}) => {
  const [sourceId, setSourceId] = useState<string>(initialSourceNode?.id || '');
  const [targetId, setTargetId] = useState<string>(initialTargetNode?.id || '');
  const [sourceQuery, setSourceQuery] = useState<string>(initialSourceNode?.relative_path || '');
  const [targetQuery, setTargetQuery] = useState<string>(initialTargetNode?.relative_path || '');
  const [direction, setDirection] = useState<PathDirection>(initialDirection);
  const [includeTypes, setIncludeTypes] = useState<boolean>(initialIncludeTypes);
  const [loading, setLoading] = useState<boolean>(initialLoading);
  const [result, setResult] = useState<DependencyPathResult | null>(initialResult);
  const [error, setError] = useState<string | null>(initialError);
  const [expandedEdgeId, setExpandedEdgeId] = useState<string | null>(initialExpandedEdgeId);

  const [showSourceDropdown, setShowSourceDropdown] = useState(initialShowSourceDropdown);
  const [showTargetDropdown, setShowTargetDropdown] = useState(initialShowTargetDropdown);

  const abortControllerRef = useRef<AbortController | null>(null);

  // Clean unmounting: cancel any pending in-flight path discovery requests
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Sync initialSourceNode if it changes
  useEffect(() => {
    if (initialSourceNode && !sourceId) {
      setSourceId(initialSourceNode.id);
      setSourceQuery(initialSourceNode.relative_path);
    }
  }, [initialSourceNode, sourceId]);

  const nodes = snapshot?.nodes || [];

  const filteredSourceNodes = useMemo(() => {
    const q = sourceQuery.toLowerCase();
    return nodes
      .filter((n) => n.relative_path.toLowerCase().includes(q))
      .slice(0, 8);
  }, [nodes, sourceQuery]);

  const filteredTargetNodes = useMemo(() => {
    const q = targetQuery.toLowerCase();
    return nodes
      .filter((n) => n.relative_path.toLowerCase().includes(q))
      .slice(0, 8);
  }, [nodes, targetQuery]);

  const handleSwapEndpoints = () => {
    const prevSrcId = sourceId;
    const prevSrcQuery = sourceQuery;
    setSourceId(targetId);
    setSourceQuery(targetQuery);
    setTargetId(prevSrcId);
    setTargetQuery(prevSrcQuery);
  };

  const executeSearch = async (
    src: string,
    tgt: string,
    dir: PathDirection,
    types: boolean
  ) => {
    if (!src || !tgt) return;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const res = await api.getDependencyPath(src, tgt, dir, types, controller.signal);
      setResult(res);
      onActivePathChange?.(res);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setResult(null);
      onActivePathChange?.(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (sourceId && targetId && sourceId !== targetId) {
      void executeSearch(sourceId, targetId, direction, includeTypes);
    } else if (sourceId && targetId && sourceId === targetId) {
      const res: DependencyPathResult = {
        status: 'same_file',
        file_id: sourceId,
        hops: 0,
      };
      setResult(res);
      onActivePathChange?.(res);
    }
  }, [sourceId, targetId, direction, includeTypes]);

  const handleClear = () => {
    setTargetId('');
    setTargetQuery('');
    setResult(null);
    onActivePathChange?.(null);
  };

  return (
    <div className="path-explorer-panel" aria-label="Dependency Path Explorer">
      <div className="path-explorer-header">
        <div className="path-explorer-title">
          <Route size={16} color="#2dd4bf" />
          <span className="font-semibold">Dependency Path Explorer</span>
        </div>
        <div className="path-explorer-header-actions">
          <button
            type="button"
            className="btn-icon"
            onClick={handleSwapEndpoints}
            title="Swap source and target endpoints"
            aria-label="Swap endpoints"
          >
            <ArrowLeftRight size={14} />
          </button>
          <button
            type="button"
            className="btn-icon"
            onClick={onClose}
            title="Close Path Explorer"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="path-explorer-controls">
        {/* Source File Input */}
        <div className="path-field-group">
          <label htmlFor="source-file-input" className="path-field-label">
            From (Source)
          </label>
          <div className="path-input-wrapper">
            <input
              id="source-file-input"
              type="text"
              className="path-search-input"
              placeholder="Search source file..."
              value={sourceQuery}
              onChange={(e) => {
                setSourceQuery(e.target.value);
                setShowSourceDropdown(true);
              }}
              onFocus={() => setShowSourceDropdown(true)}
            />
            {showSourceDropdown && filteredSourceNodes.length > 0 && (
              <ul className="path-autocomplete-dropdown" role="listbox" aria-label="Matching source files">
                {filteredSourceNodes.map((n) => (
                  <li
                    key={n.id}
                    className="path-autocomplete-item"
                    role="option"
                    aria-selected={n.id === sourceId}
                    onMouseDown={() => {
                      setSourceId(n.id);
                      setSourceQuery(n.relative_path);
                      setShowSourceDropdown(false);
                    }}
                  >
                    <span className="filename font-medium">{n.filename}</span>
                    <span className="relpath text-muted text-xs">{n.relative_path}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Target File Input */}
        <div className="path-field-group">
          <label htmlFor="target-file-input" className="path-field-label">
            To (Destination)
          </label>
          <div className="path-input-wrapper">
            <input
              id="target-file-input"
              type="text"
              className="path-search-input"
              placeholder="Search destination file..."
              value={targetQuery}
              onChange={(e) => {
                setTargetQuery(e.target.value);
                setShowTargetDropdown(true);
              }}
              onFocus={() => setShowTargetDropdown(true)}
            />
            {showTargetDropdown && filteredTargetNodes.length > 0 && (
              <ul className="path-autocomplete-dropdown" role="listbox" aria-label="Matching destination files">
                {filteredTargetNodes.map((n) => (
                  <li
                    key={n.id}
                    className="path-autocomplete-item"
                    role="option"
                    aria-selected={n.id === targetId}
                    onMouseDown={() => {
                      setTargetId(n.id);
                      setTargetQuery(n.relative_path);
                      setShowTargetDropdown(false);
                    }}
                  >
                    <span className="filename font-medium">{n.filename}</span>
                    <span className="relpath text-muted text-xs">{n.relative_path}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Direction & Filter Settings */}
        <div className="path-options-row">
          <div className="direction-toggle-group" role="group" aria-label="Path search direction">
            <button
              type="button"
              aria-pressed={direction === 'outgoing'}
              onClick={() => setDirection('outgoing')}
              className={`direction-btn ${direction === 'outgoing' ? 'active' : ''}`}
              title="Find how source depends on destination"
            >
              Uses (A → B)
            </button>
            <button
              type="button"
              aria-pressed={direction === 'incoming'}
              onClick={() => setDirection('incoming')}
              className={`direction-btn ${direction === 'incoming' ? 'active' : ''}`}
              title="Find how destination depends on source"
            >
              Used by (B → A)
            </button>
          </div>

          <label className="type-toggle-label">
            <input
              type="checkbox"
              checked={includeTypes}
              onChange={(e) => setIncludeTypes(e.target.checked)}
            />
            <span>Include Types</span>
          </label>
        </div>
      </div>

      {/* Results Area */}
      <div className="path-results-container">
        {loading && (
          <div className="path-loading-state">
            <div className="spinner" />
            <span>Tracing dependency path...</span>
          </div>
        )}

        {error && (
          <div className="path-error-alert">
            <AlertCircle size={14} color="#ef4444" />
            <span>{error}</span>
          </div>
        )}

        {!loading && result && (
          <>
            {result.status === 'same_file' && (
              <div className="path-status-card info">
                <Info size={14} color="#2dd4bf" />
                <span>Source and destination are the same file (0 hops).</span>
              </div>
            )}

            {result.status === 'not_found' && (
              <div className="path-status-card warning">
                <AlertCircle size={14} color="#f59e0b" />
                <span>
                  No dependency path found between these files in analyzed relationships.
                </span>
              </div>
            )}

            {result.status === 'missing_endpoint' && (
              <div className="path-status-card warning">
                <AlertCircle size={14} color="#f59e0b" />
                <span>One or both files are not part of the analyzed graph.</span>
              </div>
            )}

            {result.status === 'found' && (
              <div className="path-found-container">
                <div className="path-summary-banner">
                  <CheckCircle2 size={14} color="#2dd4bf" />
                  <span className="path-summary-text">
                    <strong>{result.path.nodes[0].split('/').pop()}</strong> connects to{' '}
                    <strong>{result.path.nodes[result.path.nodes.length - 1].split('/').pop()}</strong>{' '}
                    through {Math.max(0, result.path.nodes.length - 2)} intermediate file
                    {result.path.nodes.length - 2 === 1 ? '' : 's'} ({result.path.hops} hop
                    {result.path.hops === 1 ? '' : 's'}).
                  </span>
                </div>

                {result.path.is_type_only && (
                  <div className="path-type-note">
                    <span className="type-badge small">Type-Only Path</span>
                    <span className="text-xs text-muted">
                      This path consists entirely of type-only relationships.
                    </span>
                  </div>
                )}

                {/* Ordered Path List */}
                <ol className="path-step-list">
                  {result.path.nodes.map((nodeId, idx) => {
                    const isLast = idx === result.path.nodes.length - 1;
                    const edge = !isLast ? result.path.edges[idx] : null;
                    const nodeObj = nodes.find((n) => n.id === nodeId);
                    const filename = nodeId.split('/').pop() || nodeId;

                    return (
                      <li key={nodeId} className="path-step-item">
                        <div className="path-step-node">
                          <span className="path-step-index">{idx + 1}</span>
                          <button
                            type="button"
                            className="path-node-btn clickable"
                            onClick={() => {
                              if (nodeObj) onSelectNode(nodeObj);
                            }}
                            title={`Inspect ${nodeId}`}
                          >
                            <FileCode size={13} className="node-icon" />
                            <span className="node-filename font-medium">{filename}</span>
                            <span className="node-path text-xs text-muted">{nodeId}</span>
                          </button>
                          {nodeObj && onExplore2D && (
                            <button
                              type="button"
                              className="explore-2d-btn"
                              onClick={() => onExplore2D(nodeObj)}
                              title={`Focus ${filename} in 2D Relationships`}
                              style={{
                                background: 'transparent',
                                border: 'none',
                                color: 'var(--text-muted)',
                                padding: '2px 4px',
                                cursor: 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                              }}
                            >
                              <Compass size={12} />
                            </button>
                          )}
                        </div>

                        {!isLast && edge && (
                          <div className="path-step-edge">
                            <div className="edge-connector-line">
                              <ArrowRight size={12} className="edge-arrow" />
                            </div>
                            <div className="edge-info-badge">
                              <span
                                className={`rel-kind-tag ${
                                  edge.relationship_kind === 'TypeOnly'
                                    ? 'type-only'
                                    : 'runtime'
                                }`}
                              >
                                {edge.relationship_kind}
                              </span>
                              {edge.evidence.length > 0 && (
                                <button
                                  type="button"
                                  className="evidence-toggle-btn"
                                  onClick={() =>
                                    setExpandedEdgeId(
                                      expandedEdgeId === edge.id ? null : edge.id
                                    )
                                  }
                                  title="View import evidence"
                                >
                                  {expandedEdgeId === edge.id ? 'Hide evidence' : 'Evidence'}
                                </button>
                              )}
                            </div>

                            {expandedEdgeId === edge.id && edge.evidence.length > 0 && (
                              <div className="edge-evidence-panel">
                                {edge.evidence.map((ev, eIdx) => (
                                  <div key={eIdx} className="evidence-item text-xs">
                                    <span className="mono specifier">{ev.import_specifier}</span>
                                    {ev.line && (
                                      <span className="line-info text-muted">
                                        line {ev.line}
                                        {ev.column ? `:${ev.column}` : ''}
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>

                <div className="path-actions-footer" style={{ display: 'flex', gap: '8px' }}>
                  {onSwitchTo3D && (
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={onSwitchTo3D}
                      title="View path highlight in 3D Overview"
                    >
                      <Layers size={12} style={{ marginRight: '4px' }} />
                      View in 3D
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={handleClear}
                    title="Clear current path exploration"
                  >
                    Clear Path
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

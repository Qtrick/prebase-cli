import React, { useEffect, useState, useRef } from 'react';
import { DependencyEdge, FileInspection, FileNode, GraphSnapshot } from '../types/graph';
import { api } from '../transport/api';
import { getFileTypeColor } from '../graphs/network/fileTypeColors';
import {
  X,
  ArrowRight,
  FileCode,
  Layers,
  ShieldCheck,
  AlertTriangle,
  ExternalLink,
  Clock,
  LocateFixed,
  Compass,
} from 'lucide-react';

interface InspectorProps {
  selectedNode: FileNode | null;
  selectedEdge: DependencyEdge | null;
  snapshot: GraphSnapshot | null;
  onSelectNode: (node: FileNode) => void;
  onClose: () => void;
  onViewFileHistory?: (filePath: string) => void;
  onRevealNode?: (nodeId: string) => void;
}

export const Inspector: React.FC<InspectorProps> = ({
  selectedNode,
  selectedEdge,
  snapshot,
  onSelectNode,
  onClose,
  onViewFileHistory,
  onRevealNode,
}) => {
  const [inspection, setInspection] = useState<FileInspection | null>(null);
  const [loading, setLoading] = useState(false);
  const [sourcePreview, setSourcePreview] = useState<string | null>(null);

  const requestTokenRef = useRef(0);

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

  if (!selectedNode && !selectedEdge) {
    if (!snapshot) return null;
    return (
      <aside className="inspector-panel">
        <div className="inspector-header">
          <h3>Repository Overview</h3>
        </div>
        <div className="inspector-content">
          <div className="stat-card">
            <span className="stat-label">Repository ID</span>
            <span className="stat-value mono">{snapshot.repository_id}</span>
          </div>
          <div className="stats-grid">
            <div className="stat-card">
              <span className="stat-label">Indexed Files</span>
              <span className="stat-value">{snapshot.nodes.length}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Relationships</span>
              <span className="stat-value">{snapshot.edges.length}</span>
            </div>
          </div>
          <div className="coverage-card">
            <div className="coverage-title">
              <ShieldCheck size={16} color="#2dd4bf" />
              <span>Analysis Coverage</span>
            </div>
            <p className="coverage-desc">
              Analyzed {snapshot.coverage.total_analyzed} of {snapshot.coverage.total_discovered} files.
              {snapshot.coverage.total_excluded > 0 && ` (${snapshot.coverage.total_excluded} excluded).`}
            </p>
          </div>
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
            <h4>Network Explorer</h4>
            <p>Click on any file node to inspect its internal dependencies and dependents.</p>
            <p>Click any dependency relationship line to inspect its import evidence.</p>
            <p className="mono hint">Shortcut: press "/" to quickly search files.</p>
          </div>
        </div>
      </aside>
    );
  }

  // Selected Edge View
  if (selectedEdge) {
    return (
      <aside className="inspector-panel">
        <div className="inspector-header">
          <div className="node-title-group">
            <Layers size={16} color="#2dd4bf" />
            <h3 className="file-name">Dependency Relationship</h3>
          </div>
          <button className="close-btn" onClick={onClose} title="Close inspector">
            <X size={16} />
          </button>
        </div>

        <div className="inspector-content">
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

  // Selected Node View
  return (
    <aside className="inspector-panel">
      <div className="inspector-header">
        <div className="node-title-group">
          <div
            className="color-dot"
            style={{ backgroundColor: getFileTypeColor(selectedNode?.relative_path) }}
          />
          <h3 className="file-name">{selectedNode?.filename}</h3>
        </div>
        <button className="close-btn" onClick={onClose} title="Close inspector">
          <X size={16} />
        </button>
      </div>

      <div className="inspector-content">
        <div className="file-path-bar mono">{selectedNode?.relative_path}</div>

        <div className="meta-tags">
          <span className="tag language-tag">{selectedNode?.language}</span>
          <span className="tag size-tag">
            {((selectedNode?.size_bytes || 0) / 1024).toFixed(1)} KB
          </span>
          <span className="tag status-tag">{selectedNode?.analysis_status}</span>
        </div>

        <div className="stats-grid" style={{ marginTop: '10px' }}>
          <div className="stat-card">
            <span className="stat-label">Dependencies</span>
            <span className="stat-value">{selectedNode?.direct_dependency_count ?? 0}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Dependents</span>
            <span className="stat-value">{selectedNode?.direct_dependent_count ?? 0}</span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="inspector-action-buttons">
          {selectedNode && onRevealNode && (
            <button
              className="reveal-btn"
              onClick={() => onRevealNode(selectedNode.id)}
              title="Locate and center this file in the 3D graph"
            >
              <LocateFixed size={14} />
              <span>Reveal in Graph</span>
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

          <button
            className="explore-2d-btn"
            disabled
            aria-disabled="true"
            title="Contextual 2D relationship view is scheduled for Stage 2"
          >
            <Compass size={14} />
            <span>Explore Relationships in 2D (Stage 2)</span>
          </button>
        </div>

        {loading ? (
          <div className="loading-state">Analyzing relationships...</div>
        ) : (
          <>
            {/* Dependencies */}
            <div className="relations-section">
              <div className="section-title">
                <Layers size={14} />
                <h4>Dependencies ({inspection?.dependencies.length || 0})</h4>
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
                <h4>Dependents ({inspection?.dependents.length || 0})</h4>
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
                <h4>Source Preview</h4>
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

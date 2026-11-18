import React, { useState, useMemo } from 'react';
import { CycleGroup, FileNode, GraphSnapshot } from '../types/graph';
import { getAreaIdForPath } from '../utils/repositoryAreas';
import {
  Repeat,
  X,
  FileCode,
  ArrowRight,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

interface CycleGroupInspectorProps {
  cycleGroup: CycleGroup;
  snapshot: GraphSnapshot | null;
  onSelectNode: (node: FileNode) => void;
  onClose: () => void;
  onClearFocus?: () => void;
  initialMemberFilter?: string;
  initialShowAllMembers?: boolean;
}

export const CycleGroupInspector: React.FC<CycleGroupInspectorProps> = ({
  cycleGroup,
  snapshot,
  onSelectNode,
  onClose,
  onClearFocus,
  initialMemberFilter = '',
  initialShowAllMembers = false,
}) => {
  const [memberFilter, setMemberFilter] = useState(initialMemberFilter);
  const [showAllMembers, setShowAllMembers] = useState(initialShowAllMembers);

  const nodes = snapshot?.nodes || [];

  const nodeMap = useMemo(() => {
    const map = new Map<string, FileNode>();
    for (const n of nodes) {
      map.set(n.id, n);
      map.set(n.relative_path, n);
    }
    return map;
  }, [nodes]);

  const classification = cycleGroup.classification || (cycleGroup.is_type_only ? 'TypeOnly' : 'RuntimeRelevant');

  const classificationLabel =
    classification === 'RuntimeRelevant'
      ? 'Runtime-Relevant Cycle'
      : classification === 'MixedStructural'
      ? 'Mixed Structural Cycle'
      : 'Type-Only Cycle';

  const classificationColor =
    classification === 'RuntimeRelevant'
      ? '#ef4444'
      : classification === 'MixedStructural'
      ? '#f59e0b'
      : '#38bdf8';

  const classificationDescription =
    classification === 'RuntimeRelevant'
      ? 'This strongly connected component contains one or more closed cycles of runtime dependencies. Modules import each other at runtime, which can lead to initialization deadlocks or undefined imports.'
      : classification === 'MixedStructural'
      ? 'This component is cyclically connected through a combination of runtime and type-only dependencies. Pure runtime imports do not form a cycle, so runtime deadlock is avoided, but tight architectural coupling remains.'
      : 'All dependencies forming this cycle are TypeScript type-only imports. These are erased during compilation and do not affect emitted JavaScript runtime execution.';

  // Determine areas involved in this cycle
  const areasInvolved = useMemo(() => {
    return Array.from(
      new Set(cycleGroup.files.map((f) => getAreaIdForPath(f)))
    ).sort();
  }, [cycleGroup.files]);

  const filteredFiles = useMemo(() => {
    if (!memberFilter) return cycleGroup.files;
    const q = memberFilter.toLowerCase();
    return cycleGroup.files.filter((f) => f.toLowerCase().includes(q));
  }, [cycleGroup.files, memberFilter]);

  const displayedFiles = showAllMembers ? filteredFiles : filteredFiles.slice(0, 15);

  return (
    <div className="cycle-group-inspector" aria-label={`Cycle Group ${cycleGroup.id}`}>
      <div className="cycle-inspector-header">
        <div className="cycle-title-row">
          <Repeat size={16} color={classificationColor} />
          <h3 className="font-semibold text-sm">Circular Dependency Group #{cycleGroup.id}</h3>
        </div>
        <div className="cycle-header-actions">
          {onClearFocus && (
            <button
              type="button"
              className="btn-text text-xs"
              onClick={onClearFocus}
              title="Clear group focus in graph"
            >
              Clear Focus
            </button>
          )}
          <button
            type="button"
            className="btn-icon"
            onClick={onClose}
            title="Close cycle inspector"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Classification Banner */}
      <div
        className="cycle-classification-banner"
        style={{ borderLeftColor: classificationColor }}
      >
        <div className="classification-header">
          <span
            className="classification-tag font-medium"
            style={{ color: classificationColor }}
          >
            {classificationLabel}
          </span>
          <span className="edge-count-badge text-xs text-muted">
            {cycleGroup.edge_count} internal edge{cycleGroup.edge_count === 1 ? '' : 's'}
          </span>
        </div>
        <p className="classification-explanation text-xs text-muted">
          {classificationDescription}
        </p>
      </div>

      {/* Metrics Row */}
      <div className="cycle-metrics-grid">
        <div className="cycle-metric-card">
          <span className="metric-val font-semibold">{cycleGroup.files.length}</span>
          <span className="metric-label text-xs text-muted">Participating Files</span>
        </div>
        <div className="cycle-metric-card">
          <span className="metric-val font-semibold">{cycleGroup.edge_count}</span>
          <span className="metric-label text-xs text-muted">Internal Edges</span>
        </div>
        <div className="cycle-metric-card">
          <span className="metric-val font-semibold">{areasInvolved.length}</span>
          <span className="metric-label text-xs text-muted">Areas Involved</span>
        </div>
      </div>

      {/* Areas Involved */}
      {areasInvolved.length > 0 && (
        <div className="cycle-section">
          <h4 className="section-subtitle text-xs font-semibold text-muted">
            Architectural Areas
          </h4>
          <div className="areas-tag-list">
            {areasInvolved.map((area) => (
              <span key={area} className="area-tag text-xs mono">
                {area}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Concrete Example Cycle */}
      {cycleGroup.example_cycle.length > 0 && (
        <div className="cycle-section">
          <h4 className="section-subtitle text-xs font-semibold text-muted">
            Verified Example Path ({cycleGroup.example_cycle.length - 1} hops)
          </h4>
          <div className="example-cycle-chain mono text-xs">
            {cycleGroup.example_cycle.map((filePath, idx) => {
              const nodeObj = nodeMap.get(filePath);
              const filename = filePath.split('/').pop() || filePath;
              const isLast = idx === cycleGroup.example_cycle.length - 1;

              return (
                <React.Fragment key={idx}>
                  <button
                    type="button"
                    className="cycle-step-node clickable"
                    onClick={() => {
                      if (nodeObj) onSelectNode(nodeObj);
                    }}
                    title={`Inspect ${filePath}`}
                  >
                    {filename}
                  </button>
                  {!isLast && <ArrowRight size={11} className="cycle-step-arrow" />}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}

      {/* All Member Files */}
      <div className="cycle-section">
        <div className="section-header-flex">
          <h4 className="section-subtitle text-xs font-semibold text-muted">
            Participating Files ({cycleGroup.files.length})
          </h4>
          {cycleGroup.files.length > 8 && (
            <input
              type="text"
              className="member-filter-input text-xs"
              placeholder="Filter files..."
              aria-label="Filter participating files"
              value={memberFilter}
              onChange={(e) => setMemberFilter(e.target.value)}
            />
          )}
        </div>

        <ul className="cycle-member-list">
          {displayedFiles.map((filePath) => {
            const nodeObj = nodeMap.get(filePath);
            const filename = filePath.split('/').pop() || filePath;

            return (
              <li key={filePath} className="cycle-member-item">
                <button
                  type="button"
                  className="member-btn clickable"
                  onClick={() => {
                    if (nodeObj) onSelectNode(nodeObj);
                  }}
                  title={`Inspect ${filePath}`}
                >
                  <FileCode size={13} className="text-muted" />
                  <span className="member-name font-medium text-xs">{filename}</span>
                  <span className="member-path text-xs text-muted">{filePath}</span>
                </button>
              </li>
            );
          })}
        </ul>

        {filteredFiles.length > 15 && (
          <button
            type="button"
            className="btn-text text-xs show-more-members-btn"
            onClick={() => setShowAllMembers(!showAllMembers)}
          >
            {showAllMembers ? (
              <>
                <ChevronUp size={12} /> Show less
              </>
            ) : (
              <>
                <ChevronDown size={12} /> Show all {filteredFiles.length} files
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
};

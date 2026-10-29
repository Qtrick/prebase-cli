import React, { useEffect, useState, useCallback } from 'react';
import { DependencyEdge, FileNode, GraphSnapshot, RepositoryInfo } from '../types/graph';
import { api } from '../transport/api';
import { NetworkCanvas } from '../graphs/network/NetworkCanvas';
import { SearchBox } from '../search/SearchBox';
import { Inspector } from '../inspector/Inspector';
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
} from 'lucide-react';
import './App.css';

export const App: React.FC = () => {
  const [repoInfo, setRepoInfo] = useState<RepositoryInfo | null>(null);
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [status, setStatus] = useState<string>('Scanning');
  const [error, setError] = useState<string | null>(null);

  const [selectedNode, setSelectedNode] = useState<FileNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<DependencyEdge | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'network' | 'temporal'>('network');

  // Load initial repository info and poll status until ready
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const checkStatus = async () => {
      try {
        const repo = await api.getRepository();
        setRepoInfo(repo);

        const st = await api.getStatus();
        setStatus(st.indexing_status);

        if (st.indexing_status === 'Ready') {
          const snap = await api.getNetwork();
          setSnapshot(snap);
        } else if (st.indexing_status === 'Failed') {
          setError('Repository analysis failed. Please check CLI terminal output.');
        } else {
          timer = setTimeout(checkStatus, 800);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Failed to connect to local server: ${msg}`);
      }
    };

    checkStatus();

    return () => clearTimeout(timer);
  }, []);

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

  return (
    <div className="app-shell">
      {/* 1. Left Sidebar */}
      <aside className="sidebar">
        <div className="brand-header">
          <div className="brand-logo">
            <div className="logo-orb" />
            <span className="brand-name">PreBase</span>
          </div>
          <span className="brand-version">v0.1</span>
        </div>

        <div className="repo-badge">
          <FolderGit2 size={16} className="repo-icon" />
          <div className="repo-meta">
            <span className="repo-title">{repoInfo?.repository_name || 'Loading...'}</span>
            <span className="repo-path mono">{repoInfo?.repository_root_display || ''}</span>
          </div>
        </div>

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
            <span className="pill-badge">Prompt 2</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="status-indicator">
            {status === 'Ready' ? (
              <>
                <CheckCircle2 size={15} color="#2dd4bf" />
                <span>Index Ready</span>
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
          <SearchBox
            files={snapshot?.nodes || []}
            onSelectNode={(node) => handleSelectNode(node)}
          />

          <div className="view-controls">
            <button
              className="ctrl-btn"
              onClick={() => {
                // Trigger fit view by dispatching custom event or focusing center
                if (snapshot?.nodes[0]) {
                  setFocusedNodeId(snapshot.nodes[0].id);
                }
              }}
              title="Fit View"
            >
              <Maximize2 size={15} />
              <span>Fit View</span>
            </button>
            <button
              className="ctrl-btn"
              onClick={() => {
                setSelectedNode(null);
                setSelectedEdge(null);
                setFocusedNodeId(null);
              }}
              title="Reset View"
            >
              <RotateCcw size={15} />
              <span>Reset</span>
            </button>
          </div>
        </header>

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
              />
            )}
          </div>
        ) : (
          <div className="temporal-placeholder">
            <Clock size={48} color="#38bdf8" />
            <h2>Temporal Graph</h2>
            <p>
              Git commit history analysis, lineage tracking, and structural snapshots are scheduled for <strong>Prompt 2</strong>.
            </p>
            <button className="primary-btn" onClick={() => setActiveTab('network')}>
              Return to Network Graph
            </button>
          </div>
        )}
      </main>

      {/* 3. Right Inspector */}
      <Inspector
        selectedNode={selectedNode}
        selectedEdge={selectedEdge}
        snapshot={snapshot}
        onSelectNode={handleSelectNode}
        onClose={() => {
          setSelectedNode(null);
          setSelectedEdge(null);
        }}
      />
    </div>
  );
};

import React, { useState, useEffect, useRef } from 'react';
import { FileNode } from '../types/graph';
import { getFileTypeColor } from '../graphs/network/fileTypeColors';
import { Search, X } from 'lucide-react';

interface SearchBoxProps {
  files: FileNode[];
  onSelectNode: (node: FileNode) => void;
}

export const SearchBox: React.FC<SearchBoxProps> = ({ files, onSelectNode }) => {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [results, setResults] = useState<FileNode[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Keyboard shortcut: '/' or 'Cmd+K' to focus search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === '/' && document.activeElement !== inputRef.current) || (e.key === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        inputRef.current?.focus();
        setIsOpen(true);
      } else if (e.key === 'Escape') {
        setIsOpen(false);
        inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Filter files on query change
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      setResults(files.slice(0, 8));
      return;
    }

    const matched = files
      .filter(
        (f) =>
          f.filename.toLowerCase().includes(q) ||
          f.relative_path.toLowerCase().includes(q)
      )
      .slice(0, 10);

    setResults(matched);
    setSelectedIndex(0);
  }, [query, files]);

  // Click outside to dismiss
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (node: FileNode) => {
    onSelectNode(node);
    setIsOpen(false);
    setQuery('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen || results.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[selectedIndex]) {
        handleSelect(results[selectedIndex]);
      }
    }
  };

  return (
    <div ref={containerRef} className="search-box-container">
      <div className="search-input-wrap">
        <Search size={15} className="search-icon" />
        <input
          ref={inputRef}
          type="text"
          className="search-input"
          placeholder="Search files... (Press / to focus)"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
        />
        {query && (
          <button
            className="clear-search-btn"
            onClick={() => {
              setQuery('');
              setIsOpen(false);
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {isOpen && results.length > 0 && (
        <ul className="search-dropdown">
          {results.map((node, index) => {
            const isSelected = index === selectedIndex;
            return (
              <li
                key={node.id}
                className={`search-item ${isSelected ? 'active' : ''}`}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => handleSelect(node)}
              >
                <div
                  className="search-color-dot"
                  style={{ backgroundColor: getFileTypeColor(node.relative_path) }}
                />
                <div className="search-item-info">
                  <span className="search-item-name">{node.filename}</span>
                  <span className="search-item-path mono">{node.relative_path}</span>
                </div>
                <span className="search-item-degree">
                  {(node.direct_dependency_count || 0) + (node.direct_dependent_count || 0)} links
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};


import React, { useState, useEffect, useRef, useMemo } from 'react';
import { FileNode } from '../types/graph';
import { getFileTypeColor } from '../graphs/network/fileTypeColors';
import { Search, X, LocateFixed } from 'lucide-react';

interface SearchBoxProps {
  files: FileNode[];
  onSelectNode: (node: FileNode, options?: { reveal?: boolean }) => void;
}

/**
 * Checks whether the current element or event target is an active editable field
 * (input, textarea, select, or contenteditable) to avoid stealing user typing.
 */
export function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName?.toLowerCase() ?? '';
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    (el as HTMLElement).isContentEditable === true
  );
}

/**
 * Deterministically ranks search matches by relevance:
 * 1. Exact filename match (score 100)
 * 2. Filename prefix match (score 75)
 * 3. Filename substring match (score 50)
 * 4. Path segment / substring match (score 25)
 * Tie-breakers: shorter path length, then alphabetical relative_path.
 */
export function rankSearchResults(files: readonly FileNode[], query: string, limit = 10): FileNode[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    // When empty, return top connected hub files as helpful starting points
    return [...files]
      .sort(
        (a, b) =>
          (b.direct_dependency_count + b.direct_dependent_count) -
          (a.direct_dependency_count + a.direct_dependent_count)
      )
      .slice(0, 8);
  }

  const scored: { file: FileNode; score: number }[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fn = file.filename.toLowerCase();
    const rel = file.relative_path.toLowerCase();
    const dotIdx = fn.lastIndexOf('.');
    const fnBase = dotIdx > 0 ? fn.slice(0, dotIdx) : fn;

    let score = 0;
    if (fn === q || fnBase === q) {
      score = 100;
    } else if (fn.startsWith(q) || fnBase.startsWith(q)) {
      score = 75;
    } else if (fn.includes(q)) {
      score = 50;
    } else if (rel.includes(q)) {
      score = 25;
    }

    if (score > 0) {
      scored.push({ file, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.file.relative_path.length !== b.file.relative_path.length) {
      return a.file.relative_path.length - b.file.relative_path.length;
    }
    return a.file.relative_path.localeCompare(b.file.relative_path);
  });

  return scored.slice(0, limit).map((s) => s.file);
}

export const SearchBox: React.FC<SearchBoxProps> = ({ files, onSelectNode }) => {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Keyboard shortcut: '/' or 'Cmd+K' to focus search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Never steal focus if the user is already typing in an editable field
      if (e.key === '/') {
        if (!isEditableElement(document.activeElement)) {
          e.preventDefault();
          inputRef.current?.focus();
          setIsOpen(true);
        }
      } else if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
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

  // Compute ranked search results
  const results = useMemo(() => {
    return rankSearchResults(files, query, 10);
  }, [files, query]);

  // Reset selected index on query change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

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

  const handleSelect = (node: FileNode, options?: { reveal?: boolean }) => {
    onSelectNode(node, options);
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
        // Normal selection from search must not unnecessarily reposition or rotate the orb
        handleSelect(results[selectedIndex], { reveal: false });
      }
    }
  };

  return (
    <div ref={containerRef} className="search-box-container">
      <div className="search-input-wrap">
        <Search size={15} className="search-icon" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          className="search-input"
          placeholder="Search files..."
          value={query}
          role="combobox"
          aria-expanded={isOpen && (results.length > 0 || query.trim().length > 0)}
          aria-autocomplete="list"
          aria-controls="search-dropdown-list"
          aria-activedescendant={
            isOpen && results[selectedIndex] ? `search-item-${results[selectedIndex].id}` : undefined
          }
          aria-label="Search files"
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
        />
        {!query && <span className="search-kbd-hint">/</span>}
        {query && (
          <button
            className="clear-search-btn"
            aria-label="Clear search"
            onClick={() => {
              setQuery('');
              setIsOpen(false);
            }}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {isOpen && (
        <ul id="search-dropdown-list" className="search-dropdown" role="listbox" aria-label="Search suggestions">
          {results.length === 0 && query.trim().length > 0 ? (
            <li className="search-empty-state" role="status">No files matching "{query}"</li>
          ) : (
            results.map((node, index) => {
              const isSelected = index === selectedIndex;
              return (
                <li
                  key={node.id}
                  id={`search-item-${node.id}`}
                  role="option"
                  aria-selected={isSelected}
                  className={`search-item ${isSelected ? 'active' : ''}`}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => handleSelect(node, { reveal: false })}
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
                  <button
                    type="button"
                    className="search-reveal-action"
                    title={`Focus ${node.filename} in 3D`}
                    aria-label={`Focus ${node.filename} in 3D`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelect(node, { reveal: true });
                    }}
                  >
                    <LocateFixed size={13} />
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
};

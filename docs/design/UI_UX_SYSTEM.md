# PreBase UI/UX Design System Specification

## 1. Principles & Design Philosophy
PreBase is an analytical developer visualization tool. Its aesthetic is:
**Minimal, precise, dimensional, calm, responsive, and information-rich.**

Visual complexity is concentrated within the interactive graphs (3D Network Orb, 2D Relationship Explorer, Temporal Ancestry DAG), while the surrounding application chrome remains quiet, tactile, and supportive.

### Core Tenets
1. **The Graph Is The Centerpiece**: Workspace panels, headers, and toolbars exist to frame and interpret graph data without consuming valuable visualization space.
2. **Restrained Color with Semantic Purpose**: Surfaces are neutral deep slate/graphite in dark mode and clean alabaster/slate in light mode. Vibrant color is reserved for file types, node status, relationship directionality, and active selection.
3. **Information Density with Breathability**: High-density developer metadata is organized through clear typographic hierarchy, consistent 4px/8px grid spacing, and progressive disclosure rather than monolithic blocks of text.
4. **Zero-Lag Tactility**: Every button press, drag gesture, and tab switch responds synchronously, decoupling high-frequency canvas rendering from React state.

---

## 2. Design Tokens & Palette

### 2.1 Surfaces & Neutrals
| Token | Dark Mode (Night) | Light Mode (Day) | Purpose |
|---|---|---|---|
| `--bg-primary` | `#080b11` | `#f8fafc` | Deepest canvas background |
| `--bg-secondary` | `#0f1422` | `#ffffff` | Sidebar, Inspector, Dropdowns |
| `--bg-surface` | `#161e31` | `#f1f5f9` | Cards, input fields, badges |
| `--bg-surface-elevated` | `#1e293b` | `#e2e8f0` | Modals, floating HUDs, tooltips |
| `--bg-hover` | `#232f48` | `#e2e8f0` | Hover states on interactive items |
| `--border-subtle` | `rgba(255, 255, 255, 0.08)` | `rgba(0, 0, 0, 0.08)` | Dividers, card borders |
| `--border-active` | `rgba(45, 212, 191, 0.45)` | `rgba(13, 148, 136, 0.5)` | Focus borders, active states |

### 2.2 Typography & Text
| Token | Dark Mode | Light Mode | Purpose |
|---|---|---|---|
| `--text-primary` | `#f8fafc` | `#0f172a` | High-contrast headers, active labels |
| `--text-secondary` | `#94a3b8` | `#475569` | Body text, metadata, secondary titles |
| `--text-muted` | `#64748b` | `#94a3b8` | Placeholders, hotkey hints, paths |
| `--font-sans` | `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` | Interface text |
| `--font-mono` | `ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace` | Paths, hashes, line numbers |

### 2.3 Semantic Brand & Accents
| Token | Value | Role |
|---|---|---|
| `--accent-teal` | `#2dd4bf` (Dark) / `#0d9488` (Light) | PreBase primary teal accent, selection halo |
| `--accent-sky` | `#38bdf8` (Dark) / `#0284c7` (Light) | Information, dependencies, hover states |
| `--accent-amber` | `#f59e0b` (Dark) / `#d97706` (Light) | Warnings, git dirty state, entry nodes |
| `--accent-rose` | `#f43f5e` (Dark) / `#e11d48` (Light) | Errors, deletions, broken connections |
| `--accent-indigo` | `#818cf8` (Dark) / `#6366f1` (Light) | Git branches, temporal ancestry |

---

## 3. Layout Architecture & Usable Graph Space
- **Sidebar**: Standard 240px width. Features unified brand identity, repository context, git branch indicator, tab navigation, and live synchronization health. Collapsible or responsive on smaller viewports.
- **Workspace Canvas**: Maximum available viewport. Inset by 64px at top for the floating glassmorphic header, leaving full screen real-estate for the graph.
- **Inspector Panel**: 340px width. Features collapsible toggle to maximize canvas width when analyzing wide topologies. Smooth width transition with zero canvas distortion.

---

## 4. Typography Scale & Hierarchy
- **Brand Title**: 16px / 700 / letter-spacing -0.02em
- **Section Headers**: 11px / 700 / uppercase / letter-spacing 0.06em
- **Node Primary**: 13px / 600 / sans-serif
- **Code / Path / Hash**: 11px / 500 / monospace
- **Badge / Micro Tag**: 10px / 600 / uppercase


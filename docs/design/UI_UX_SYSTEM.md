# PreBase UI/UX Design System Specification

## 1. Principles & Design Philosophy
PreBase is an analytical developer visualization tool. Its aesthetic is:
**Minimal, precise, dimensional, calm, responsive, and information-rich.**

Visual complexity is concentrated within the interactive graphs (3D Network Orb, 2D Relationship Explorer, Temporal Ancestry DAG), while the surrounding application chrome remains quiet, tactile, and supportive.

### Core Tenets
1. **The Graph Is The Centerpiece**: Workspace panels, headers, and toolbars exist to frame and interpret graph data without consuming valuable visualization space.
2. **Intentional Color & Personality**: Uses an Obsidian Navy base (`#080b12`) with Electric Indigo brand accents (`#6366f1` / `#818cf8`) and semantic color accents (amber entrypoints, sky hubs, emerald status) rather than monochromatic dullness or generic dashboard templates.
3. **Information Density with Breathability**: High-density developer metadata is organized through clear typographic hierarchy, consistent 4px/8px grid spacing, tabular metric numbers, and progressive disclosure rather than monolithic blocks of text.
4. **Zero-Lag Tactility & Unrestricted 3D Navigation**: Every button press, drag gesture, and tab switch responds synchronously. Continuous 360-degree quaternion rotation operates smoothly across poles with zero pitch lock or orientation flipping.
5. **Non-Passive Native Wheel Zoom**: Wheel events are intercepted directly on the canvas with `{ passive: false }`, preventing trackpad pinch and mouse wheel from accidentally zooming the entire browser page.

---

## 2. Design Tokens & Palette

### 2.1 Surfaces & Neutrals
| Token | Dark Mode (Obsidian Navy) | Light Mode (Crisp Slate) | Purpose |
|---|---|---|---|
| `--bg-primary` | `#080b12` | `#f8fafc` | Deepest canvas background |
| `--bg-secondary` | `#0d121f` | `#ffffff` | Sidebar, Inspector, Dropdowns |
| `--bg-surface` | `#141b2d` | `#f1f5f9` | Cards, input fields, badges |
| `--bg-surface-elevated` | `#1b243b` | `#e2e8f0` | Modals, floating HUDs, tooltips |
| `--bg-hover` | `#232f4a` | `#e2e8f0` | Hover states on interactive items |
| `--border-subtle` | `rgba(255, 255, 255, 0.08)` | `rgba(0, 0, 0, 0.08)` | Dividers, card borders |
| `--border-active` | `rgba(99, 102, 241, 0.45)` | `rgba(79, 70, 229, 0.5)` | Focus borders, active states |

### 2.2 Typography & Text
| Token | Dark Mode | Light Mode | Purpose |
|---|---|---|---|
| `--text-primary` | `#f8fafc` | `#0f172a` | High-contrast headers, active labels |
| `--text-secondary` | `#94a3b8` | `#475569` | Body text, metadata, secondary titles |
| `--text-muted` | `#64748b` | `#94a3b8` | Placeholders, hotkey hints, paths |
| `--font-sans` | `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` | Interface text |
| `--font-mono` | `ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace` | Paths, hashes, line numbers |

### 2.3 Semantic Brand & Accents
| Token | Dark Mode | Light Mode | Role |
|---|---|---|---|
| `--accent-brand` | `#6366f1` | `#4f46e5` | Electric Indigo brand accent, active navigation glow |
| `--accent-brand-bright` | `#818cf8` | `#6366f1` | Bright indigo hover and focus highlights |
| `--accent-teal` | `#2dd4bf` | `#0d9488` | Selection halo, 3D orbit target focus |
| `--accent-sky` | `#38bdf8` | `#0284c7` | Information, direct dependencies, area hub badge |
| `--accent-amber` | `#f59e0b` | `#d97706` | Warnings, git dirty state, entry point candidates |
| `--accent-rose` | `#f43f5e` | `#e11d48` | Errors, cycle alerts, broken connections |
| `--accent-emerald` | `#10b981` | `#059669` | Index ready, additions, clean state |

---

## 3. Layout Architecture & Workspace Space

- **Sidebar (224px Compact Width)**:
  - **Brand Header**: Minimal PreBase brand logo with version badge and theme toggle (`Dark`/`Light`).
  - **Unified Repository Identity Card (`.repo-identity-card`)**: Integrates repository folder icon, repository name, relative directory path, and a nested branch pill (`.repo-branch-pill`) displaying active branch and commit hash cleanly.
  - **Navigation List**: Clean vertical navigation items (`Network`, `History`) with Electric Indigo active indicator and subtle glow.
  - **Live Synchronization Health**: Compact footer status pill displaying real-time indexing status and sync health.
- **Workspace Canvas**:
  - Maximum available viewport area.
  - Floating top toolbar with view switcher (`3D Overview` / `2D Relationships`), instant search, and filters.
  - Floating glassmorphic HUD toolbar (`.view-controls`) providing quick access to Zoom In (`#zoomIn`), Zoom Out (`#zoomOut`), Fit View (`#fitView`), Reset Camera (`#resetCam`), and Center-Lock toggle (`#centerLock`).
- **Inspector Panel (340px Width)**:
  - Collapsible toggle (`Ctrl+B` / `Cmd+B` / button) to instantly expand canvas width to full screen.
  - **Overview Metric Strip**: 4-column horizontal stat strip displaying `FILES`, `ANALYZED`, `CONNECTIONS`, and `AREAS` in tabular numbers with micro labels.
  - **Entry Recommendations ("Start here")**: Compact rows featuring semantic badges (`Crate Root` in amber, `Core Dependency` in indigo, `Area Hub` in sky).
  - **Architectural Areas**: High-density interactive cards displaying file counts, internal connections, and outgoing relationships.

---

## 4. Typography Scale & Hierarchy
- **Brand Title**: 15px / 700 / letter-spacing -0.02em
- **Section Headers**: 11px / 700 / uppercase / letter-spacing 0.06em
- **Node Primary**: 13px / 600 / sans-serif
- **Code / Path / Hash**: 11px / 500 / monospace
- **Badge / Micro Tag**: 10px / 600 / uppercase
- **Metric Numbers**: 16px / 700 / tabular-nums

---

## 5. Interaction Invariants

### 5.1 Unrestricted 3D Continuous Rotation
- Uses screen-relative quaternion orientation (`NetworkCamera.orientation: Quaternion`).
- Continuous 360-degree rotation across the vertical poles and inverted orientations without pitch locks, singularities, or flips.
- Smooth rotational inertia on pointer drag release, with automatic velocity cancellation on stationary holds.

### 5.2 Native Non-Passive Graph Zoom
- Direct `{ passive: false }` wheel event listener attached directly to `<canvas>`.
- Synchronously invokes `e.preventDefault()`, intercepting mouse wheel and trackpad pinch (`ctrlKey: true`) to zoom the graph within `[0.15, 4.0]` while strictly locking browser visual viewport scale to `1.0`.

### 5.3 Keyboard Accessibility
- Arrow keys rotate in 3D and navigate nodes in 2D.
- `+`/`-`/`0` zoom in/out/reset.
- `F` fits view; `R` resets camera; `L` toggles center-lock.
- `V` toggles between 3D Overview and 2D Relationships.
- `Escape` dismisses modals and clears selection.
- All global shortcuts ignore active editable elements (`input`, `textarea`, `[contenteditable]`) and IME composition (`keyCode 229`).

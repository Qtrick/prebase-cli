# PreBase CLI — Multi-Language Architecture Specification

## 1. Executive Summary & Architectural Goals

The PreBase CLI multi-language architecture transforms PreBase from a JavaScript/TypeScript-specific dependency viewer into a repository-wide polyglot codebase intelligence engine. 

Developers can run `prebase` in any repository, and PreBase will:
1. Detect all programming, markup, and configuration languages present.
2. Select appropriate, language-aware parsers and dependency extractors without falling back to JavaScript.
3. Apply language-specific resolution semantics (handling relative paths, directory structures, package roots, and manifests).
4. Construct a canonical dependency graph that preserves evidence, distinguishes files from packages/modules, and reports status truthfully.
5. Provide live filesystem updates through a unified watcher that monitors both source files and project manifests.
6. Display language identities, colors, capability levels, and relationships in the browser Network and Temporal graphs.

---

## 2. Capability Levels & Honest Reporting

PreBase explicitly distinguishes between four capability levels:

- **Level 0 — Recognized**: PreBase recognizes the file format and displays the canonical language identity and styling. No syntax parsing or dependency extraction is performed.
- **Level 1 — Parsed**: PreBase parses the concrete syntax tree using Tree-sitter and extracts import, export, or include specifiers. References may remain unresolved or external.
- **Level 2 — Resolved Dependencies**: PreBase resolves internal references to real source files, module definitions, or local packages according to language-specific module rules.
- **Level 3 — Project-Aware**: PreBase parses lightweight project manifests (e.g., `Cargo.toml`, `go.mod`, `tsconfig.json`, `pyproject.toml`, `.csproj`) to ground module roots, package prefixes, and alias paths accurately.

The node analysis status lifecycle distinguishes:
- `Recognized` (Level 0)
- `Parsed` (Level 1)
- `Analyzed` (Level 2 or 3 fully resolved)
- `PartiallyAnalyzed` (Some dependencies resolved, some unresolved or unsupported)
- `Unsupported` (Language or construct deliberately marked unsupported)
- `Failed` (Syntax error or file read failure)
- `Excluded` (Ignored by `.gitignore`, secret filter, or size threshold)

Files are never marked `Analyzed` simply because they exist in the repository or because parsing succeeded.

---

## 3. Technology & Dependency Strategy Evaluation

### 3.1 Evaluation of `tree-sitter-language-pack`
During Phase A research, `tree-sitter-language-pack` was evaluated as a candidate for bundling many grammars. The audit revealed:
- `tree-sitter-language-pack` defaults to `dynamic-loading` and `download` features using `ureq` and `libloading`.
- At runtime, it attempts to download precompiled native shared libraries (`.dylib`, `.so`, `.dll`) from external endpoints and load them via `dlopen`.
- **Decision: Rejected.** Runtime downloads directly violate PreBase's core constraints:
  1. Offline execution: PreBase must work in air-gapped or offline developer environments.
  2. Security: Downloading and loading arbitrary native shared libraries into the CLI process violates trust boundaries and introduces code-execution risks.
  3. Determinism: Static compilation guarantees ABI consistency and eliminates runtime dependency failures.

### 3.2 Evaluation of Individual Static Tree-sitter Grammar Crates
Official, individual Tree-sitter grammar crates (e.g., `tree-sitter-python`, `tree-sitter-rust`, `tree-sitter-go`, `tree-sitter-java`, `tree-sitter-c`, `tree-sitter-cpp`, `tree-sitter-c-sharp`, `tree-sitter-ruby`, `tree-sitter-php`, `tree-sitter-bash`, `tree-sitter-html`, `tree-sitter-css`, `tree-sitter-json`) compile C grammars directly into the PreBase binary via `cc`.
- **Decision: Selected.**
  - 100% offline, zero network requests.
  - ABI compatibility with `tree-sitter = "0.22"` and `cc = "^1.0"`.
  - Minimal binary overhead: C grammar parsers are small tables (~100KB to 1MB per language).
  - Fast compilation: all core language grammars compile in under 3 seconds.

---

## 4. Central Language Registry (`prebase-core::languages`)

### 4.1 Single Source of Truth
Scattered `matches!` statements across `scanner.rs`, `ast.rs`, `resolver.rs`, and `watcher.rs` are replaced by a centralized `LanguageRegistry`.

The registry is owned by `prebase-core` and queried by:
- `RepositoryScanner`: determines whether a file is recognized, supported, or excluded.
- `SourceParser`: selects the exact Tree-sitter grammar without JavaScript fallbacks.
- `DependencyResolver`: dispatches to the correct language resolution adapter.
- `RepoWatcher`: determines which source files and manifest files invalidate graph state.
- `AppState` / API: serves language metadata to the frontend.
- Frontend: maps canonical `language_id`s to colors, names, and filter options.

### 4.2 Language Descriptor Model
```rust
pub struct LanguageDescriptor {
    pub id: &'static str,
    pub display_name: &'static str,
    pub extensions: &'static [&'static str],
    pub special_filenames: &'static [&'static str],
    pub capability_level: LanguageCapabilityLevel,
    pub file_kind: FileKind,
    pub color_light: &'static str,
    pub color_dark: &'static str,
    pub manifest_files: &'static [&'static str],
}
```

---

## 5. Parser Adapter & Extraction Architecture

### 5.1 Pipeline Flow
```text
File Discovery (RepositoryScanner + LanguageRegistry)
             ↓
Language Detection (Extension, special filename, context)
             ↓
Grammar Dispatch (SourceParser: lazy-initialized grammar)
             ↓
Syntax Traversal & Reference Extraction (ExtractedReference)
             ↓
Language-Aware Resolver Dispatch (ImportResolver)
             ↓
Canonical Graph (Nodes, Deduplicated Edges, Evidence, Issues)
             ↓
State Publication & SSE Broadcast to Browser Network Graph
```

### 5.2 Structured Reference Model
Language extractors yield structured `ExtractedReference` records:
```rust
pub struct ExtractedReference {
    pub source_path: String,
    pub specifier: String,
    pub line: usize,
    pub column: usize,
    pub relationship_kind: RelationshipKind,
    pub is_type_only: bool,
    pub resolution_hint: Option<String>,
}
```

---

## 6. Language-Specific Resolution Semantics

### 6.1 JavaScript & TypeScript
- Static `import`, dynamic `import()`, `export ... from`, `require()`.
- Relative `./` and `../` with extension inference (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, etc.) and directory `index.*` fallback.
- TypeScript `tsconfig.json` paths and `baseUrl`.

### 6.2 Python
- Syntax: `import pkg.mod`, `from pkg.mod import submod`, `from . import local`, `from ..parent import helper`.
- Module-to-file mapping: `pkg/mod.py` or `pkg/mod/__init__.py`.
- Relative imports: leading dots calculate parent directories relative to source file package depth.
- Absolute imports: checked against project root and standard source roots (`src/`, `lib/`).
- External packages: unresolved top-level modules marked as `ExternalPackage` rather than false internal files.

### 6.3 Rust
- Syntax: `mod foo;`, `#[path = "custom.rs"] mod bar;`, `use crate::foo::bar;`, `use super::utils;`.
- Module-to-file mapping:
  - `foo.rs` or `foo/mod.rs`.
  - Nested submodules: `parent/child.rs` or `parent/child/mod.rs`.
- `Cargo.toml`: recognizes package crate roots (`src/main.rs`, `src/lib.rs`).
- Module declarations (`mod service;`) represent true file-level dependencies.
- Symbol `use` statements refer to symbols or modules within resolved module trees.

### 6.4 Go
- Syntax: `import "example.com/project/pkg/util"`, `import "./local"`.
- Module-to-directory mapping: `go.mod` provides module path prefix `example.com/project`.
- Imports matching module path resolve to repository directory `pkg/util`.
- Local directory contains one or more `.go` files; relationship connects to the package entrypoint or package files deterministically.
- Standard library and third-party modules marked as `ExternalPackage`.

### 6.5 Java
- Syntax: `import com.example.service.UserService;`, `import com.example.utils.*;`.
- Package-to-directory mapping: source roots (`src/main/java`, `src/test/java`, `src/`).
- `com.example.service.UserService` maps to `src/main/java/com/example/service/UserService.java`.
- Wildcard imports (`.*`) map to package directory or remain package-level dependencies without guessing arbitrary single files.

### 6.6 C & C++
- Syntax: `#include "local.h"`, `#include <system_or_lib.h>`.
- Quoted includes: searched relative to current file directory, then project include directories (`include/`, `inc/`, `src/`).
- Angle bracket includes: searched in project include paths; standard library headers (`<vector>`, `<stdio.h>`) classified as `ExternalPackage`.
- Preprocessor conditionals and macro expansions preserved safely.

### 6.7 C#
- Syntax: `using System;`, `using MyProject.Services;`, `using static MyProject.Utils;`.
- Project references: `.csproj` references mapped to project directories.
- Namespace mappings: maps to directories/files when matching project layout; system and NuGet references classified as `ExternalPackage`.

### 6.8 Ruby
- Syntax: `require_relative "helpers"`, `require "json"`, `load "./config.rb"`.
- `require_relative`: resolved relative to current file directory with optional `.rb` extension.
- Standard `require`: resolved against local `lib/` or marked external.

### 6.9 PHP
- Syntax: `require_once __DIR__ . '/config.php'`, `include './helpers.php'`, `use App\Services\User;`.
- Path expressions: static string literals and `__DIR__` prefixes resolved safely.
- Namespace PSR-4: mapped against `src/` or `app/` conventions.

---

## 7. Canonical Graph Model Evolution

### 7.1 Relationship Kinds
To model polyglot dependencies without losing semantics, `RelationshipKind` is expanded to:
```rust
pub enum RelationshipKind {
    Import,
    Export,
    DynamicImport,
    TypeOnly,
    Include,            // C/C++ #include
    ModuleDeclaration,  // Rust mod foo;
    Require,            // Ruby require/require_relative, PHP require/include
    PackageImport,      // Go package import, Java package wildcard
    ProjectReference,   // C# .csproj reference
}
```

### 7.2 Entity Nodes
File nodes preserve their stable relative-path IDs (e.g., `src/service/client.rs`). Where a language links to a package or module rather than a single file (such as a Go package directory), the node represents the package target or primary module entry without fabricating arbitrary file edges.

### 7.3 Multi-Edge Evidence Preservation
When two nodes share multiple relationships (e.g. an import and a re-export, or multiple imports across lines), all `DependencyEvidence` items are preserved on the edge so the inspector can display every occurrence with exact line/column locations.

---

## 8. Live Updates & Watcher Integration

The filesystem watcher invalidation logic is updated to query `LanguageRegistry`:
1. Source file changes: Any file with a recognized extension in the registry triggers incremental re-analysis.
2. Manifest file changes: Changes to `Cargo.toml`, `go.mod`, `tsconfig.json`, `pyproject.toml`, or `pom.xml` trigger re-evaluation of project context and dependent resolution.
3. Convergence Invariant: After any sequence of file edits, the published graph state converges identically to a full fresh scan of the directory.

---

## 9. Performance & Resource Constraints

1. **Lazy Parser Loading**: Parsers are instantiated only when a file of that language is encountered in the scan.
2. **Grammar Size**: Only lightweight, C-compiled grammars are statically linked.
3. **Bounded Traversal**: AST traversal depth is bounded; large generated files (>2MB) are safely excluded.
4. **Memory Footprint**: Peak memory is capped by streaming scan results and reusing parser allocations.


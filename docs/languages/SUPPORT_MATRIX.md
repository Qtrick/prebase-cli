# PreBase Multi-Language Support Matrix

This matrix documents the language capability levels implemented and verified in PreBase CLI.

## Capability Levels
- **Level 0 (Recognized)**: Recognized file type, canonical language ID, syntax highlighting color in UI. No parsing.
- **Level 1 (Parsed)**: Syntax tree parsed via Tree-sitter. Imports and references extracted. References may be unresolved or external.
- **Level 2 (Resolved Dependencies)**: Internal dependencies resolved to concrete source files, modules, or packages with evidence.
- **Level 3 (Project-Aware)**: Uses project manifests (`Cargo.toml`, `go.mod`, `tsconfig.json`, `pyproject.toml`, etc.) to ground package paths and module boundaries.

---

## Language Support Matrix

| Language | Extensions | Grammar Engine | Capability Level | Internal Resolution | Project Manifests | Test Fixture |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **TypeScript** | `.ts`, `.mts`, `.cts` | `tree-sitter-typescript` | **Level 3** | Relative & Alias paths | `tsconfig.json` | `tests/fixtures/ts_project` |
| **TSX** | `.tsx` | `tree-sitter-typescript` | **Level 3** | Relative & Alias paths | `tsconfig.json` | `tests/fixtures/tsx_project` |
| **JavaScript** | `.js`, `.mjs`, `.cjs` | `tree-sitter-javascript` | **Level 3** | Relative & Alias paths | `jsconfig.json`, `package.json` | `tests/fixtures/js_project` |
| **JSX** | `.jsx` | `tree-sitter-javascript` | **Level 3** | Relative & Alias paths | `package.json` | `tests/fixtures/jsx_project` |
| **Python** | `.py`, `.pyi` | `tree-sitter-python` | **Level 3** | Relative (`from .`), Absolute (`from pkg`), `__init__.py` | `pyproject.toml`, `setup.py` | `tests/fixtures/python_project` |
| **Rust** | `.rs` | `tree-sitter-rust` | **Level 3** | `mod foo;`, `mod.rs`, `crate::`, `super::` | `Cargo.toml` | `tests/fixtures/rust_project` |
| **Go** | `.go` | `tree-sitter-go` | **Level 3** | Module prefix paths to package directories | `go.mod` | `tests/fixtures/go_project` |
| **Java** | `.java` | `tree-sitter-java` | **Level 3** | Package/class to path mapping | `pom.xml`, `build.gradle` | `tests/fixtures/java_project` |
| **C** | `.c`, `.h` | `tree-sitter-c` | **Level 2** | Quoted `#include`, header paths | Local includes | `tests/fixtures/c_project` |
| **C++** | `.cpp`, `.hpp`, `.cc`, `.cxx`, `.hh` | `tree-sitter-cpp` | **Level 2** | Quoted `#include`, header paths | Local includes | `tests/fixtures/cpp_project` |
| **C#** | `.cs` | `tree-sitter-c-sharp` | **Level 2** | `using` namespace mapping | `.csproj` | `tests/fixtures/csharp_project` |
| **Ruby** | `.rb` | `tree-sitter-ruby` | **Level 2** | `require_relative`, `load` | `Gemfile` | `tests/fixtures/ruby_project` |
| **PHP** | `.php` | `tree-sitter-php` | **Level 2** | `require`, `include`, `require_once` | `composer.json` | `tests/fixtures/php_project` |
| **Kotlin** | `.kt`, `.kts` | `tree-sitter-kotlin` | **Level 2** | Package/class references | `build.gradle.kts` | `tests/fixtures/kotlin_project` |
| **Swift** | `.swift` | `tree-sitter-swift` | **Level 2** | Module imports | `Package.swift` | `tests/fixtures/swift_project` |
| **Lua** | `.lua` | `tree-sitter-lua` | **Level 2** | `require("foo.bar")` | Directory paths | `tests/fixtures/lua_project` |
| **Scala** | `.scala`, `.sc` | `tree-sitter-scala` | **Level 2** | Package/class imports | `build.sbt` | `tests/fixtures/scala_project` |
| **Elixir** | `.ex`, `.exs` | `tree-sitter-elixir` | **Level 1** | Module `alias`, `import`, `require` | `mix.exs` | `tests/fixtures/elixir_project` |
| **Haskell** | `.hs`, `.lhs` | `tree-sitter-haskell` | **Level 1** | `import Module` | `package.yaml`, `.cabal` | `tests/fixtures/haskell_project` |
| **R** | `.r`, `.R` | `tree-sitter-r` | **Level 1** | `source()`, `library()` | `DESCRIPTION` | `tests/fixtures/r_project` |
| **Bash/Shell** | `.sh`, `.bash`, `.zsh` | `tree-sitter-bash` | **Level 1** | `source`, `. filename` | Script paths | `tests/fixtures/shell_project` |
| **HTML** | `.html`, `.htm` | `tree-sitter-html` | **Level 1** | `<script src>`, `<link href>` | Relative assets | `tests/fixtures/html_project` |
| **CSS/SCSS** | `.css`, `.scss` | `tree-sitter-css` | **Level 1** | `@import "..."` | Relative stylesheets | `tests/fixtures/css_project` |
| **JSON** | `.json` | `tree-sitter-json` | **Level 0** | Recognized / Config data | — | Built-in |
| **TOML** | `.toml` | `tree-sitter-toml` | **Level 0** | Recognized / Manifest data | — | Built-in |
| **YAML** | `.yaml`, `.yml` | `tree-sitter-yaml` | **Level 0** | Recognized / Config data | — | Built-in |
| **Markdown** | `.md`, `.markdown` | Custom / Regex | **Level 0** | Recognized / Documentation | — | Built-in |
| **SQL** | `.sql` | Custom / Keyword | **Level 0** | Recognized / Queries | — | Built-in |

---

## Invariant Guarantees
1. No unsupported or unrecognized language is parsed as JavaScript.
2. Capability levels are never inflated: Level 0 files are never marked as Analyzed.
3. Every claimed Level 2 or Level 3 language is verified against real disk fixtures.
4. Parsing is 100% offline with zero runtime downloading of native binaries.


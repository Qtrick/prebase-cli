use std::collections::HashSet;
use std::fs;
use std::path::Path;

use prebase_core::model::ResolutionStatus;

use crate::tsconfig::TsConfig;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedTarget {
    Internal(String),
    External(String),
    Unresolved(String),
    Unsupported(String),
}

impl ResolvedTarget {
    pub fn to_resolution_status(&self) -> ResolutionStatus {
        match self {
            Self::Internal(_) => ResolutionStatus::ResolvedInternal,
            Self::External(_) => ResolutionStatus::ExternalPackage,
            Self::Unresolved(_) => ResolutionStatus::Unresolved,
            Self::Unsupported(_) => ResolutionStatus::Unsupported,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ProjectContext {
    pub go_module_name: Option<String>,
    pub go_modules: Vec<(String, String)>,
    pub cargo_package_name: Option<String>,
    pub cargo_packages: Vec<(String, String)>,
    pub tsconfig: Option<TsConfig>,
}

impl ProjectContext {
    pub fn load_from_dir(root: &Path) -> Self {
        let tsconfig = TsConfig::load_from_dir(root);

        // Load Go module name from go.mod if present
        let mut go_module_name = None;
        let mut go_modules = Vec::new();

        let go_mod_path = root.join("go.mod");
        if go_mod_path.exists() {
            if let Ok(content) = fs::read_to_string(&go_mod_path) {
                for line in content.lines() {
                    let trimmed = line.trim();
                    let line_no_comment = trimmed.split("//").next().unwrap_or(trimmed).trim();
                    if let Some(stripped) = line_no_comment.strip_prefix("module ") {
                        let mod_name = stripped.trim().trim_matches('"').to_string();
                        if !mod_name.is_empty() {
                            go_module_name = Some(mod_name.clone());
                            go_modules.push((String::new(), mod_name));
                            break;
                        }
                    }
                }
            }
        }

        // Load Cargo package name from Cargo.toml if present
        let mut cargo_package_name = None;
        let mut cargo_packages = Vec::new();

        let cargo_toml_path = root.join("Cargo.toml");
        if cargo_toml_path.exists() {
            if let Ok(content) = fs::read_to_string(&cargo_toml_path) {
                let mut in_package = false;
                for line in content.lines() {
                    let trimmed = line.trim();
                    let line_no_comment = trimmed.split('#').next().unwrap_or(trimmed).trim();
                    if line_no_comment == "[package]" {
                        in_package = true;
                    } else if line_no_comment.starts_with('[') {
                        in_package = false;
                    } else if in_package
                        && (line_no_comment.starts_with("name ")
                            || line_no_comment.starts_with("name="))
                    {
                        if let Some(eq_idx) = line_no_comment.find('=') {
                            let name = line_no_comment[eq_idx + 1..]
                                .trim()
                                .trim_matches('"')
                                .trim_matches('\'');
                            if !name.is_empty() {
                                cargo_package_name = Some(name.to_string());
                                cargo_packages.push((String::new(), name.to_string()));
                                break;
                            }
                        }
                    }
                }
            }
        }

        // Discover go.mod and Cargo.toml in first-level subdirectories (monorepo submodules)
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                if let Ok(ft) = entry.file_type() {
                    if ft.is_dir() {
                        let dir_name = entry.file_name().to_string_lossy().to_string();
                        if dir_name.starts_with('.')
                            || dir_name == "node_modules"
                            || dir_name == "target"
                        {
                            continue;
                        }

                        // Check sub go.mod
                        let sub_mod = entry.path().join("go.mod");
                        if sub_mod.exists() {
                            if let Ok(content) = fs::read_to_string(&sub_mod) {
                                for line in content.lines() {
                                    let trimmed = line.trim();
                                    let line_no_comment =
                                        trimmed.split("//").next().unwrap_or(trimmed).trim();
                                    if let Some(stripped) = line_no_comment.strip_prefix("module ")
                                    {
                                        let mod_name =
                                            stripped.trim().trim_matches('"').to_string();
                                        if !mod_name.is_empty() {
                                            go_modules.push((dir_name.clone(), mod_name));
                                            break;
                                        }
                                    }
                                }
                            }
                        }

                        // Check sub Cargo.toml
                        let sub_cargo = entry.path().join("Cargo.toml");
                        if sub_cargo.exists() {
                            if let Ok(content) = fs::read_to_string(&sub_cargo) {
                                let mut in_package = false;
                                for line in content.lines() {
                                    let trimmed = line.trim();
                                    let line_no_comment =
                                        trimmed.split('#').next().unwrap_or(trimmed).trim();
                                    if line_no_comment == "[package]" {
                                        in_package = true;
                                    } else if line_no_comment.starts_with('[') {
                                        in_package = false;
                                    } else if in_package
                                        && (line_no_comment.starts_with("name ")
                                            || line_no_comment.starts_with("name="))
                                    {
                                        if let Some(eq_idx) = line_no_comment.find('=') {
                                            let name = line_no_comment[eq_idx + 1..]
                                                .trim()
                                                .trim_matches('"')
                                                .trim_matches('\'');
                                            if !name.is_empty() {
                                                cargo_packages
                                                    .push((dir_name.clone(), name.to_string()));
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        Self {
            go_module_name,
            go_modules,
            cargo_package_name,
            cargo_packages,
            tsconfig,
        }
    }
}

pub struct ImportResolver {
    known_files: HashSet<String>,
    context: ProjectContext,
}

const JS_TS_EXTENSIONS: &[&str] = &[
    "", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
];

impl ImportResolver {
    pub fn new(known_files: HashSet<String>, tsconfig: Option<TsConfig>) -> Self {
        Self {
            known_files,
            context: ProjectContext {
                tsconfig,
                ..Default::default()
            },
        }
    }

    pub fn with_context(known_files: HashSet<String>, context: ProjectContext) -> Self {
        Self {
            known_files,
            context,
        }
    }

    pub fn resolve(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        let lang = prebase_core::languages::detect_language_or_other(from_file);
        self.resolve_for_language(from_file, lang.id, specifier)
    }

    pub fn resolve_for_language(
        &self,
        from_file: &str,
        language: &str,
        specifier: &str,
    ) -> ResolvedTarget {
        let clean_spec = specifier.split('?').next().unwrap_or(specifier).trim();
        if clean_spec.is_empty() {
            return ResolvedTarget::Unsupported("Empty import specifier".to_string());
        }

        match language {
            "typescript" | "tsx" | "javascript" | "jsx" => {
                self.resolve_javascript(from_file, clean_spec)
            }
            "python" => self.resolve_python(from_file, clean_spec),
            "rust" => self.resolve_rust(from_file, clean_spec),
            "go" => self.resolve_go(from_file, clean_spec),
            "java" => self.resolve_java(from_file, clean_spec),
            "c" | "cpp" => self.resolve_c_cpp(from_file, clean_spec),
            "csharp" => self.resolve_csharp(from_file, clean_spec),
            "ruby" => self.resolve_ruby(from_file, clean_spec),
            "php" => self.resolve_php(from_file, clean_spec),
            "kotlin" => self.resolve_kotlin(from_file, clean_spec),
            "swift" => self.resolve_swift(from_file, clean_spec),
            "lua" => self.resolve_lua(from_file, clean_spec),
            "scala" => self.resolve_scala(from_file, clean_spec),
            "elixir" => self.resolve_elixir(from_file, clean_spec),
            "haskell" => self.resolve_haskell(from_file, clean_spec),
            "r" => self.resolve_r(from_file, clean_spec),
            "shell" | "html" | "css" | "scss" => self.resolve_relative_file(from_file, clean_spec),
            _ => self.resolve_generic(from_file, clean_spec),
        }
    }

    // ==========================================
    // JavaScript / TypeScript Resolver
    // ==========================================
    fn resolve_javascript(&self, from_file: &str, clean_spec: &str) -> ResolvedTarget {
        // 1. Relative imports
        if clean_spec.starts_with("./") || clean_spec.starts_with("../") {
            let from_dir = Path::new(from_file)
                .parent()
                .unwrap_or_else(|| Path::new(""));
            let joined = from_dir.join(clean_spec);
            let normalized = Self::normalize_path(&joined);

            if !normalized.starts_with("..") {
                if let Some(target) = self.try_resolve_js_file(&normalized) {
                    return ResolvedTarget::Internal(target);
                }
            }
            return ResolvedTarget::Unresolved(format!(
                "Cannot resolve relative import '{clean_spec}' from '{from_file}'"
            ));
        }

        // 2. TypeScript path alias resolution
        if let Some(cfg) = &self.context.tsconfig {
            for (pattern, targets) in &cfg.paths {
                if let Some(prefix) = pattern.strip_suffix('*') {
                    if let Some(remainder) = clean_spec.strip_prefix(prefix) {
                        for target in targets {
                            let target_prefix = target.strip_suffix('*').unwrap_or(target);
                            let mapped = format!("{target_prefix}{remainder}");
                            let normalized = Self::normalize_path(Path::new(&mapped));
                            if !normalized.starts_with("..") {
                                if let Some(hit) = self.try_resolve_js_file(&normalized) {
                                    return ResolvedTarget::Internal(hit);
                                }
                            }
                        }
                    }
                } else if pattern == clean_spec {
                    for target in targets {
                        let normalized = Self::normalize_path(Path::new(target));
                        if !normalized.starts_with("..") {
                            if let Some(hit) = self.try_resolve_js_file(&normalized) {
                                return ResolvedTarget::Internal(hit);
                            }
                        }
                    }
                }
            }

            if let Some(base_url) = &cfg.base_url {
                let mapped = Path::new(base_url).join(clean_spec);
                let normalized = Self::normalize_path(&mapped);
                if !normalized.starts_with("..") {
                    if let Some(hit) = self.try_resolve_js_file(&normalized) {
                        return ResolvedTarget::Internal(hit);
                    }
                }
            }
        }

        // 3. Common convention alias fallback (@/...)
        if let Some(remainder) = clean_spec.strip_prefix("@/") {
            for prefix in &["src/", ""] {
                let candidate = format!("{prefix}{remainder}");
                let normalized = Self::normalize_path(Path::new(&candidate));
                if !normalized.starts_with("..") {
                    if let Some(hit) = self.try_resolve_js_file(&normalized) {
                        return ResolvedTarget::Internal(hit);
                    }
                }
            }
        }

        // 4. Bare specifiers (packages)
        if !clean_spec.starts_with('.') && !clean_spec.starts_with('/') {
            return ResolvedTarget::External(clean_spec.to_string());
        }

        ResolvedTarget::Unresolved(format!("Unable to resolve import '{clean_spec}'"))
    }

    fn try_resolve_js_file(&self, base: &str) -> Option<String> {
        if base.starts_with("..") {
            return None;
        }
        let trimmed = base.trim_start_matches("./");

        for ext in JS_TS_EXTENSIONS {
            let candidate = if ext.is_empty() {
                trimmed.to_string()
            } else {
                format!("{trimmed}{ext}")
            };
            if self.known_files.contains(&candidate) {
                return Some(candidate);
            }
        }

        let index_prefix = if trimmed.is_empty() {
            String::new()
        } else {
            format!("{trimmed}/")
        };

        for ext in &[".ts", ".tsx", ".js", ".jsx", ".mts", ".cjs", ".mjs"] {
            let index_candidate = format!("{index_prefix}index{ext}");
            if self.known_files.contains(&index_candidate) {
                return Some(index_candidate);
            }
        }

        None
    }

    // ==========================================
    // Python Resolver
    // ==========================================
    fn resolve_python(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        // Relative imports: starts with '.'
        if specifier.starts_with('.') {
            let dots = specifier.chars().take_while(|&c| c == '.').count();
            let remainder = &specifier[dots..];
            let sub_path = remainder.replace('.', "/");

            let from_path = Path::new(from_file);
            let mut current_dir = from_path.parent();

            // Each dot after the first steps up one parent directory
            for _ in 1..dots {
                if let Some(p) = current_dir {
                    if p.as_os_str().is_empty() {
                        current_dir = None;
                        break;
                    }
                    current_dir = p.parent();
                }
            }

            let base_dir = match current_dir {
                Some(p) => p,
                None => {
                    return ResolvedTarget::Unresolved(format!(
                        "Relative Python import '{specifier}' traverses outside repository root from '{from_file}'"
                    ));
                }
            };

            let target_path = if sub_path.is_empty() {
                base_dir.to_path_buf()
            } else {
                base_dir.join(sub_path)
            };

            let norm = Self::normalize_path(&target_path);
            if !norm.starts_with("..") {
                if let Some(hit) = self.try_resolve_python_target(&norm) {
                    return ResolvedTarget::Internal(hit);
                }
            }

            return ResolvedTarget::Unresolved(format!(
                "Cannot resolve relative Python import '{specifier}' from '{from_file}'"
            ));
        }

        // Absolute imports: e.g. "my_pkg.service"
        let mod_path = specifier.replace('.', "/");

        let mut prefixes = vec!["".to_string(), "src/".to_string(), "lib/".to_string()];
        if let Some(slash_idx) = from_file.find('/') {
            let top_dir = &from_file[..slash_idx + 1];
            prefixes.push(top_dir.to_string());
            prefixes.push(format!("{top_dir}src/"));
            prefixes.push(format!("{top_dir}lib/"));
        }

        for root_prefix in &prefixes {
            let candidate = format!("{root_prefix}{mod_path}");
            let norm = Self::normalize_path(Path::new(&candidate));
            if !norm.starts_with("..") {
                if let Some(hit) = self.try_resolve_python_target(&norm) {
                    return ResolvedTarget::Internal(hit);
                }

                // If "from pkg.mod import func", pkg/mod might be the file
                if let Some(last_slash) = norm.rfind('/') {
                    let parent_candidate = &norm[..last_slash];
                    if let Some(hit) = self.try_resolve_python_target(parent_candidate) {
                        return ResolvedTarget::Internal(hit);
                    }
                }
            }
        }

        // Standard library and common third-party classification
        let top_level = specifier.split('.').next().unwrap_or(specifier);
        if Self::is_python_stdlib_or_common_pkg(top_level) {
            return ResolvedTarget::External(top_level.to_string());
        }

        ResolvedTarget::External(top_level.to_string())
    }

    fn try_resolve_python_target(&self, base: &str) -> Option<String> {
        if base.starts_with("..") {
            return None;
        }
        let trimmed = base.trim_start_matches("./").trim_end_matches('/');

        // 1. Direct file: base.py or base.pyi
        if !trimmed.is_empty() {
            for ext in &[".py", ".pyi"] {
                let candidate = format!("{trimmed}{ext}");
                if self.known_files.contains(&candidate) {
                    return Some(candidate);
                }
            }
        }

        // 2. Package module: base/__init__.py
        for ext in &[".py", ".pyi"] {
            let candidate = if trimmed.is_empty() {
                format!("__init__{ext}")
            } else {
                format!("{trimmed}/__init__{ext}")
            };
            if self.known_files.contains(&candidate) {
                return Some(candidate);
            }
        }

        None
    }

    fn is_python_stdlib_or_common_pkg(name: &str) -> bool {
        matches!(
            name,
            "os" | "sys"
                | "typing"
                | "collections"
                | "json"
                | "math"
                | "datetime"
                | "re"
                | "pathlib"
                | "logging"
                | "unittest"
                | "abc"
                | "io"
                | "itertools"
                | "functools"
                | "time"
                | "subprocess"
                | "asyncio"
                | "http"
                | "urllib"
                | "shutil"
                | "tempfile"
                | "hashlib"
                | "random"
                | "socket"
                | "contextlib"
                | "inspect"
                | "threading"
                | "multiprocessing"
                | "pytest"
                | "requests"
                | "numpy"
                | "pandas"
                | "flask"
                | "fastapi"
                | "pydantic"
                | "django"
                | "sqlalchemy"
        )
    }

    // ==========================================
    // Rust Resolver
    // ==========================================
    fn resolve_rust(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        let from_path = Path::new(from_file);
        let from_dir = from_path.parent().unwrap_or_else(|| Path::new(""));

        // 1. Module declarations: mod foo;
        if !specifier.contains("::") && !specifier.starts_with('.') {
            // Check relative to current file's directory:
            // e.g. from src/lib.rs -> src/foo.rs or src/foo/mod.rs
            let candidate_file = from_dir.join(format!("{specifier}.rs"));
            let norm_file = Self::normalize_path(&candidate_file);
            if !norm_file.starts_with("..") && self.known_files.contains(&norm_file) {
                return ResolvedTarget::Internal(norm_file);
            }

            let candidate_mod = from_dir.join(specifier).join("mod.rs");
            let norm_mod = Self::normalize_path(&candidate_mod);
            if !norm_mod.starts_with("..") && self.known_files.contains(&norm_mod) {
                return ResolvedTarget::Internal(norm_mod);
            }

            // If from_file is a submodule (e.g. src/service.rs), mod bar -> src/service/bar.rs or src/service/bar/mod.rs
            let stem = from_path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            if stem != "mod" && stem != "lib" && stem != "main" {
                let nested_file = from_dir.join(stem).join(format!("{specifier}.rs"));
                let norm_nested = Self::normalize_path(&nested_file);
                if !norm_nested.starts_with("..") && self.known_files.contains(&norm_nested) {
                    return ResolvedTarget::Internal(norm_nested);
                }

                let nested_mod = from_dir.join(stem).join(specifier).join("mod.rs");
                let norm_nested_mod = Self::normalize_path(&nested_mod);
                if !norm_nested_mod.starts_with("..") && self.known_files.contains(&norm_nested_mod)
                {
                    return ResolvedTarget::Internal(norm_nested_mod);
                }
            }

            // Check known local workspace packages if this is an external crate import (e.g. use my_crate;)
            for (pkg_dir, pkg_name) in &self.context.cargo_packages {
                let pkg_underscore = pkg_name.replace('-', "_");
                if specifier == pkg_name || specifier == pkg_underscore {
                    let crate_dir = if pkg_dir.is_empty() {
                        "src".to_string()
                    } else {
                        format!("{pkg_dir}/src")
                    };
                    let lib_file = format!("{crate_dir}/lib.rs");
                    if self.known_files.contains(&lib_file) {
                        return ResolvedTarget::Internal(lib_file);
                    }
                }
            }

            return ResolvedTarget::Unresolved(format!(
                "Cannot resolve Rust module declaration '{specifier}' from '{from_file}'"
            ));
        }

        // 2. use crate::foo::bar
        if let Some(remainder) = specifier.strip_prefix("crate::") {
            let segments: Vec<&str> = remainder.split("::").collect();
            // Determine crate root directory (typically directory with src/ or parent of src)
            let crate_dir = if from_file.starts_with("src/") {
                "src".to_string()
            } else if let Some(idx) = from_file.find("/src/") {
                from_file[..idx + 4].to_string()
            } else if let Some(idx) = from_file.find("/tests/") {
                format!("{}/src", &from_file[..idx])
            } else if let Some(slash_idx) = from_file.find('/') {
                format!("{}/src", &from_file[..slash_idx])
            } else {
                "src".to_string()
            };

            for len in (1..=segments.len()).rev() {
                let sub_path = segments[..len].join("/");
                let candidate_file = format!("{crate_dir}/{sub_path}.rs");
                if self.known_files.contains(&candidate_file) {
                    return ResolvedTarget::Internal(candidate_file);
                }

                let candidate_mod = format!("{crate_dir}/{sub_path}/mod.rs");
                if self.known_files.contains(&candidate_mod) {
                    return ResolvedTarget::Internal(candidate_mod);
                }
            }

            return ResolvedTarget::Unresolved(format!(
                "Cannot resolve crate path '{specifier}' from '{from_file}'"
            ));
        }

        // 3. use super::...
        if let Some(remainder) = specifier.strip_prefix("super::") {
            if let Some(parent) = from_dir.parent() {
                let mod_name = remainder.split("::").next().unwrap_or(remainder);
                let candidate_file = parent.join(format!("{mod_name}.rs"));
                let norm_file = Self::normalize_path(&candidate_file);
                if !norm_file.starts_with("..") && self.known_files.contains(&norm_file) {
                    return ResolvedTarget::Internal(norm_file);
                }

                let candidate_mod = parent.join(mod_name).join("mod.rs");
                let norm_mod = Self::normalize_path(&candidate_mod);
                if !norm_mod.starts_with("..") && self.known_files.contains(&norm_mod) {
                    return ResolvedTarget::Internal(norm_mod);
                }
            }
            return ResolvedTarget::Unresolved(format!(
                "Cannot resolve super path '{specifier}' from '{from_file}'"
            ));
        }

        // 4. Check known local workspace packages (e.g. use my_crate::foo)
        for (pkg_dir, pkg_name) in &self.context.cargo_packages {
            let prefix = format!("{pkg_name}::");
            if let Some(remainder) = specifier.strip_prefix(&prefix) {
                let segments: Vec<&str> = remainder.split("::").collect();
                let crate_dir = if pkg_dir.is_empty() {
                    "src".to_string()
                } else {
                    format!("{pkg_dir}/src")
                };

                for len in (1..=segments.len()).rev() {
                    let sub_path = segments[..len].join("/");
                    let candidate_file = format!("{crate_dir}/{sub_path}.rs");
                    if self.known_files.contains(&candidate_file) {
                        return ResolvedTarget::Internal(candidate_file);
                    }

                    let candidate_mod = format!("{crate_dir}/{sub_path}/mod.rs");
                    if self.known_files.contains(&candidate_mod) {
                        return ResolvedTarget::Internal(candidate_mod);
                    }
                }

                let lib_file = format!("{crate_dir}/lib.rs");
                if self.known_files.contains(&lib_file) {
                    return ResolvedTarget::Internal(lib_file);
                }
            } else if specifier == pkg_name {
                let crate_dir = if pkg_dir.is_empty() {
                    "src".to_string()
                } else {
                    format!("{pkg_dir}/src")
                };
                let lib_file = format!("{crate_dir}/lib.rs");
                if self.known_files.contains(&lib_file) {
                    return ResolvedTarget::Internal(lib_file);
                }
            }
        }

        // 5. External crates (std, core, alloc, or third-party)
        let top_crate = specifier.split("::").next().unwrap_or(specifier);
        ResolvedTarget::External(top_crate.to_string())
    }

    // ==========================================
    // Go Resolver
    // ==========================================
    fn resolve_go(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        // Relative imports (rare in modern Go, but valid in sub-packages)
        if specifier.starts_with("./") || specifier.starts_with("../") {
            let from_dir = Path::new(from_file)
                .parent()
                .unwrap_or_else(|| Path::new(""));
            let joined = from_dir.join(specifier);
            let norm = Self::normalize_path(&joined);

            if !norm.starts_with("..") {
                if let Some(target) = self.find_go_package_entry(&norm) {
                    return ResolvedTarget::Internal(target);
                }
            }
            return ResolvedTarget::Unresolved(format!(
                "Cannot resolve relative Go import '{specifier}' from '{from_file}'"
            ));
        }

        // Project-aware module mapping: check applicable go modules
        for (dir_prefix, mod_name) in &self.context.go_modules {
            if dir_prefix.is_empty()
                || from_file.starts_with(&format!("{dir_prefix}/"))
                || from_file == dir_prefix
            {
                if let Some(rel_pkg) = specifier.strip_prefix(mod_name) {
                    let clean_rel = rel_pkg.trim_start_matches('/');
                    let target_dir = if dir_prefix.is_empty() {
                        clean_rel.to_string()
                    } else if clean_rel.is_empty() {
                        dir_prefix.clone()
                    } else {
                        format!("{dir_prefix}/{clean_rel}")
                    };
                    if let Some(target) = self.find_go_package_entry(&target_dir) {
                        return ResolvedTarget::Internal(target);
                    } else {
                        return ResolvedTarget::Unresolved(format!(
                            "Cannot resolve Go module package '{specifier}' in module '{mod_name}'"
                        ));
                    }
                }
            }
        }

        // Standard library packages and third-party modules
        if !specifier.contains('.') {
            // Typically stdlib: "fmt", "os", "net/http", "sync"
            return ResolvedTarget::External(specifier.to_string());
        }

        ResolvedTarget::External(specifier.to_string())
    }

    fn find_go_package_entry(&self, dir_prefix: &str) -> Option<String> {
        let prefix = if dir_prefix.is_empty() {
            String::new()
        } else {
            format!("{dir_prefix}/")
        };

        // Pick the first deterministic .go file in that package directory
        let mut candidates: Vec<&String> = self
            .known_files
            .iter()
            .filter(|f| f.starts_with(&prefix) && f.ends_with(".go") && !f.ends_with("_test.go"))
            .collect();

        if candidates.is_empty() {
            // Fallback to test files if only test files exist
            candidates = self
                .known_files
                .iter()
                .filter(|f| f.starts_with(&prefix) && f.ends_with(".go"))
                .collect();
        }

        if !candidates.is_empty() {
            candidates.sort();
            return Some(candidates[0].clone());
        }

        None
    }

    // ==========================================
    // Java Resolver
    // ==========================================
    fn resolve_java(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        let clean = specifier.trim_end_matches(".*");
        let class_path = clean.replace('.', "/");

        // Determine project prefix if from_file is in a subdirectory (e.g. java_app/src/main/java/...)
        let mut prefixes = vec!["".to_string()];
        if let Some(idx) = from_file.find("src/main/java/") {
            prefixes.push(from_file[..idx].to_string());
        } else if let Some(idx) = from_file.find("src/") {
            prefixes.push(from_file[..idx].to_string());
        } else if let Some(slash) = from_file.find('/') {
            prefixes.push(format!("{}/", &from_file[..slash]));
        }

        for proj in &prefixes {
            for root_rel in &["src/main/java/", "src/test/java/", "src/", ""] {
                let root = format!("{proj}{root_rel}");
                let candidate = format!("{root}{class_path}.java");
                if self.known_files.contains(&candidate) {
                    return ResolvedTarget::Internal(candidate);
                }

                // Check static member / inner class outer file
                if let Some(last_slash) = class_path.rfind('/') {
                    let parent_class = &class_path[..last_slash];
                    let parent_candidate = format!("{root}{parent_class}.java");
                    if self.known_files.contains(&parent_candidate) {
                        return ResolvedTarget::Internal(parent_candidate);
                    }
                }

                if specifier.ends_with(".*") {
                    let dir_prefix = format!("{root}{class_path}/");
                    let mut candidates: Vec<&String> = self
                        .known_files
                        .iter()
                        .filter(|f| f.starts_with(&dir_prefix) && f.ends_with(".java"))
                        .collect();
                    if !candidates.is_empty() {
                        candidates.sort();
                        return ResolvedTarget::Internal(candidates[0].clone());
                    }
                }
            }
        }

        // External packages: java.*, javax.*, org.springframework.*, etc.
        let top_pkg = specifier.split('.').next().unwrap_or(specifier);
        ResolvedTarget::External(top_pkg.to_string())
    }

    // ==========================================
    // C and C++ Resolver
    // ==========================================
    fn resolve_c_cpp(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        let from_dir = Path::new(from_file)
            .parent()
            .unwrap_or_else(|| Path::new(""));

        // 1. Check relative to current file
        let candidate_rel = from_dir.join(specifier);
        let norm_rel = Self::normalize_path(&candidate_rel);
        if !norm_rel.starts_with("..") && self.known_files.contains(&norm_rel) {
            return ResolvedTarget::Internal(norm_rel);
        }

        // 2. Check project include paths
        let mut prefixes = vec!["".to_string()];
        if let Some(slash) = from_file.find('/') {
            prefixes.push(format!("{}/", &from_file[..slash]));
        }

        for proj in &prefixes {
            for inc_prefix in &["include/", "inc/", "src/", ""] {
                let candidate = format!("{proj}{inc_prefix}{specifier}");
                let norm = Self::normalize_path(Path::new(&candidate));
                if !norm.starts_with("..") && self.known_files.contains(&norm) {
                    return ResolvedTarget::Internal(norm);
                }
            }
        }

        if specifier.starts_with("./") || specifier.starts_with("../") {
            return ResolvedTarget::Unresolved(format!(
                "Cannot resolve local C/C++ header '{specifier}' from '{from_file}'"
            ));
        }

        // Standard or system headers (<vector>, <stdio.h>, etc.)
        ResolvedTarget::External(specifier.to_string())
    }

    // ==========================================
    // C# Resolver
    // ==========================================
    fn resolve_csharp(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        let ns_path = specifier.replace('.', "/");

        let mut prefixes = vec!["".to_string()];
        if let Some(slash) = from_file.find('/') {
            prefixes.push(format!("{}/", &from_file[..slash]));
        }

        for proj in &prefixes {
            for root_rel in &["", "src/"] {
                // 1. Check direct .cs file match
                let file_candidate = format!("{proj}{root_rel}{ns_path}.cs");
                if self.known_files.contains(&file_candidate) {
                    return ResolvedTarget::Internal(file_candidate);
                }

                // 2. Check directory prefix match
                let dir_prefix = format!("{proj}{root_rel}{ns_path}/");
                let mut candidates: Vec<&String> = self
                    .known_files
                    .iter()
                    .filter(|f| f.starts_with(&dir_prefix) && f.ends_with(".cs"))
                    .collect();
                if !candidates.is_empty() {
                    candidates.sort();
                    return ResolvedTarget::Internal(candidates[0].clone());
                }

                // 3. Check parent file (e.g. nested type inside class file)
                if let Some(last_slash) = ns_path.rfind('/') {
                    let parent_file = format!("{proj}{root_rel}{}.cs", &ns_path[..last_slash]);
                    if self.known_files.contains(&parent_file) {
                        return ResolvedTarget::Internal(parent_file);
                    }
                }
            }
        }

        let top_ns = specifier.split('.').next().unwrap_or(specifier);
        ResolvedTarget::External(top_ns.to_string())
    }

    // ==========================================
    // Ruby Resolver
    // ==========================================
    fn resolve_ruby(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        let from_dir = Path::new(from_file)
            .parent()
            .unwrap_or_else(|| Path::new(""));

        // Check relative
        let candidate_rel = from_dir.join(specifier);
        let norm_rel = Self::normalize_path(&candidate_rel);
        if !norm_rel.starts_with("..") {
            for ext in &["", ".rb"] {
                let hit = format!("{norm_rel}{ext}");
                if self.known_files.contains(&hit) {
                    return ResolvedTarget::Internal(hit);
                }
            }
        }

        let mut prefixes = vec!["".to_string()];
        if let Some(slash) = from_file.find('/') {
            prefixes.push(format!("{}/", &from_file[..slash]));
        }

        // Check lib/ and root
        for proj in &prefixes {
            for root in &["lib/", ""] {
                for ext in &["", ".rb"] {
                    let hit = format!("{proj}{root}{specifier}{ext}");
                    if self.known_files.contains(&hit) {
                        return ResolvedTarget::Internal(hit);
                    }
                }
            }
        }

        if specifier.starts_with("./") || specifier.starts_with("../") {
            return ResolvedTarget::Unresolved(format!(
                "Cannot resolve relative Ruby require '{specifier}' from '{from_file}'"
            ));
        }

        ResolvedTarget::External(specifier.to_string())
    }

    // ==========================================
    // PHP Resolver
    // ==========================================
    fn resolve_php(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        let from_dir = Path::new(from_file)
            .parent()
            .unwrap_or_else(|| Path::new(""));

        let candidate_rel = from_dir.join(specifier);
        let norm_rel = Self::normalize_path(&candidate_rel);
        if !norm_rel.starts_with("..") && self.known_files.contains(&norm_rel) {
            return ResolvedTarget::Internal(norm_rel);
        }

        let mut prefixes = vec!["".to_string()];
        if let Some(slash) = from_file.find('/') {
            prefixes.push(format!("{}/", &from_file[..slash]));
        }

        // Namespace use e.g. App\Services\UserService
        let ns_path = specifier.replace('\\', "/");
        for proj in &prefixes {
            for root in &["", "src/", "app/"] {
                let candidate = format!("{proj}{root}{ns_path}.php");
                if self.known_files.contains(&candidate) {
                    return ResolvedTarget::Internal(candidate);
                }
            }
        }

        if specifier.starts_with("./")
            || specifier.starts_with("../")
            || specifier.ends_with(".php")
        {
            return ResolvedTarget::Unresolved(format!(
                "Cannot resolve PHP require/include '{specifier}' from '{from_file}'"
            ));
        }

        ResolvedTarget::External(specifier.to_string())
    }

    // ==========================================
    // Kotlin & Scala Resolvers
    // ==========================================
    fn resolve_kotlin(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        let clean = specifier.trim_end_matches(".*");
        let class_path = clean.replace('.', "/");

        let mut prefixes = vec!["".to_string()];
        if let Some(idx) = from_file.find("src/") {
            prefixes.push(from_file[..idx].to_string());
        } else if let Some(slash) = from_file.find('/') {
            prefixes.push(format!("{}/", &from_file[..slash]));
        }

        for proj in &prefixes {
            for root in &["src/main/kotlin/", "src/", ""] {
                for ext in &[".kt", ".kts"] {
                    let candidate = format!("{proj}{root}{class_path}{ext}");
                    if self.known_files.contains(&candidate) {
                        return ResolvedTarget::Internal(candidate);
                    }
                }
            }
        }

        let top = specifier.split('.').next().unwrap_or(specifier);
        ResolvedTarget::External(top.to_string())
    }

    fn resolve_scala(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        let clean = specifier.trim_end_matches(".*").trim_end_matches("._");
        let class_path = clean.replace('.', "/");

        let mut prefixes = vec!["".to_string()];
        if let Some(idx) = from_file.find("src/") {
            prefixes.push(from_file[..idx].to_string());
        } else if let Some(slash) = from_file.find('/') {
            prefixes.push(format!("{}/", &from_file[..slash]));
        }

        for proj in &prefixes {
            for root in &["src/main/scala/", "src/", ""] {
                let candidate = format!("{proj}{root}{class_path}.scala");
                if self.known_files.contains(&candidate) {
                    return ResolvedTarget::Internal(candidate);
                }
            }
        }

        let top = specifier.split('.').next().unwrap_or(specifier);
        ResolvedTarget::External(top.to_string())
    }

    // ==========================================
    // Swift Resolver
    // ==========================================
    fn resolve_swift(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        let mut prefixes = vec!["".to_string()];
        if let Some(slash) = from_file.find('/') {
            prefixes.push(format!("{}/", &from_file[..slash]));
        }

        for proj in &prefixes {
            for root in &["Sources/", ""] {
                let file_candidate = format!("{proj}{root}{specifier}.swift");
                if self.known_files.contains(&file_candidate) {
                    return ResolvedTarget::Internal(file_candidate);
                }

                let dir_prefix = format!("{proj}{root}{specifier}/");
                let mut candidates: Vec<&String> = self
                    .known_files
                    .iter()
                    .filter(|f| f.starts_with(&dir_prefix) && f.ends_with(".swift"))
                    .collect();
                if !candidates.is_empty() {
                    candidates.sort();
                    return ResolvedTarget::Internal(candidates[0].clone());
                }
            }
        }

        ResolvedTarget::External(specifier.to_string())
    }

    // ==========================================
    // Lua Resolver
    // ==========================================
    fn resolve_lua(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        let from_dir = Path::new(from_file)
            .parent()
            .unwrap_or_else(|| Path::new(""));

        let mod_path = specifier.replace('.', "/");

        // 1. Relative
        let candidate_rel = from_dir.join(&mod_path);
        let norm_rel = Self::normalize_path(&candidate_rel);
        if !norm_rel.starts_with("..") {
            for ext in &[".lua", "/init.lua"] {
                let hit = format!("{norm_rel}{ext}");
                if self.known_files.contains(&hit) {
                    return ResolvedTarget::Internal(hit);
                }
            }
        }

        let mut prefixes = vec!["".to_string()];
        if let Some(slash) = from_file.find('/') {
            prefixes.push(format!("{}/", &from_file[..slash]));
        }

        // 2. Project root or src/
        for proj in &prefixes {
            for root in &["", "src/", "lua/"] {
                for ext in &[".lua", "/init.lua"] {
                    let hit = format!("{proj}{root}{mod_path}{ext}");
                    if self.known_files.contains(&hit) {
                        return ResolvedTarget::Internal(hit);
                    }
                }
            }
        }

        ResolvedTarget::External(specifier.to_string())
    }

    // ==========================================
    // Elixir Resolver
    // ==========================================
    fn resolve_elixir(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        if specifier.starts_with("./") || specifier.starts_with("../") {
            return self.resolve_relative_file(from_file, specifier);
        }

        let parts: Vec<String> = specifier
            .split('.')
            .map(|p| {
                let mut snake = String::new();
                for (i, ch) in p.chars().enumerate() {
                    if ch.is_uppercase() && i > 0 {
                        snake.push('_');
                    }
                    snake.push(ch.to_ascii_lowercase());
                }
                snake
            })
            .collect();

        let mod_path = parts.join("/");
        let mut prefixes = vec!["".to_string(), "lib/".to_string()];
        if let Some(slash_idx) = from_file.find('/') {
            let top = &from_file[..slash_idx + 1];
            prefixes.push(top.to_string());
            prefixes.push(format!("{top}lib/"));
        }

        for proj in &prefixes {
            for ext in &[".ex", ".exs"] {
                let candidate = format!("{proj}{mod_path}{ext}");
                if self.known_files.contains(&candidate) {
                    return ResolvedTarget::Internal(candidate);
                }
            }
        }

        ResolvedTarget::External(specifier.to_string())
    }

    // ==========================================
    // Haskell Resolver
    // ==========================================
    fn resolve_haskell(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        if specifier.starts_with("./") || specifier.starts_with("../") {
            return self.resolve_relative_file(from_file, specifier);
        }

        let mod_path = specifier.replace('.', "/");
        let mut prefixes = vec!["".to_string(), "src/".to_string(), "app/".to_string()];
        if let Some(slash_idx) = from_file.find('/') {
            let top = &from_file[..slash_idx + 1];
            prefixes.push(top.to_string());
            prefixes.push(format!("{top}src/"));
            prefixes.push(format!("{top}app/"));
        }

        for proj in &prefixes {
            for ext in &[".hs", ".lhs"] {
                let candidate = format!("{proj}{mod_path}{ext}");
                if self.known_files.contains(&candidate) {
                    return ResolvedTarget::Internal(candidate);
                }
            }
        }

        let top_mod = specifier.split('.').next().unwrap_or(specifier);
        ResolvedTarget::External(top_mod.to_string())
    }

    // ==========================================
    // R Resolver
    // ==========================================
    fn resolve_r(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        if specifier.ends_with(".R")
            || specifier.ends_with(".r")
            || specifier.starts_with('.')
            || specifier.contains('/')
        {
            self.resolve_relative_file(from_file, specifier)
        } else {
            ResolvedTarget::External(specifier.to_string())
        }
    }

    // ==========================================
    // Generic Relative File Resolver (HTML, CSS, Shell, R)
    // ==========================================
    fn resolve_relative_file(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        let from_dir = Path::new(from_file)
            .parent()
            .unwrap_or_else(|| Path::new(""));
        let joined = from_dir.join(specifier);
        let normalized = Self::normalize_path(&joined);

        if !normalized.starts_with("..") {
            if self.known_files.contains(&normalized) {
                return ResolvedTarget::Internal(normalized);
            }

            // Check style/script extensions
            for ext in &["", ".css", ".scss", ".sass", ".js", ".ts"] {
                let candidate = format!("{normalized}{ext}");
                if self.known_files.contains(&candidate) {
                    return ResolvedTarget::Internal(candidate);
                }
            }
        }

        // Check stripped leading ./ or / relative to root
        let trimmed = specifier.trim_start_matches("./").trim_start_matches('/');
        if !trimmed.is_empty() && !trimmed.starts_with("..") && self.known_files.contains(trimmed) {
            return ResolvedTarget::Internal(trimmed.to_string());
        }

        ResolvedTarget::Unresolved(format!(
            "Cannot resolve file reference '{specifier}' from '{from_file}'"
        ))
    }

    fn resolve_generic(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        if specifier.starts_with("./") || specifier.starts_with("../") {
            self.resolve_relative_file(from_file, specifier)
        } else {
            ResolvedTarget::External(specifier.to_string())
        }
    }

    pub fn normalize_path(path: &Path) -> String {
        let mut components = Vec::new();
        for comp in path.components() {
            match comp {
                std::path::Component::Normal(c) => components.push(c.to_string_lossy().to_string()),
                std::path::Component::ParentDir => {
                    if let Some(last) = components.last() {
                        if last != ".." {
                            components.pop();
                            continue;
                        }
                    }
                    components.push("..".to_string());
                }
                std::path::Component::CurDir => {}
                _ => {}
            }
        }
        components.join("/")
    }
}

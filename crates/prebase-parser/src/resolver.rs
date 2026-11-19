use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use prebase_core::model::ResolutionStatus;

use crate::tsconfig::TsConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnresolvedReasonKind {
    MissingInternalTarget,
    MissingWorkspaceTarget,
    MissingAliasTarget,
    InvalidSpecifier,
    General,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedTarget {
    Internal(String),
    External(String),
    Unresolved(UnresolvedReasonKind, String),
    Unsupported(String),
}

impl ResolvedTarget {
    pub fn to_resolution_status(&self) -> ResolutionStatus {
        match self {
            Self::Internal(_) => ResolutionStatus::ResolvedInternal,
            Self::External(_) => ResolutionStatus::ExternalPackage,
            Self::Unresolved(_, _) => ResolutionStatus::Unresolved,
            Self::Unsupported(_) => ResolutionStatus::Unsupported,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RustCrateInfo {
    pub name: String,
    pub normalized_name: String,
    pub crate_dir: String,
    pub src_dir: String,
    pub lib_entry: Option<String>,
    pub main_entry: Option<String>,
}

pub struct ImportResolver {
    known_files: HashSet<String>,
    configs: Vec<TsConfig>,
    workspace_packages: HashMap<String, String>,
    rust_crates: HashMap<String, RustCrateInfo>,
}

impl ImportResolver {
    pub fn new(known_files: HashSet<String>, tsconfig: Option<TsConfig>) -> Self {
        let configs = match tsconfig {
            Some(cfg) => vec![cfg],
            None => Vec::new(),
        };
        Self {
            known_files,
            configs,
            workspace_packages: HashMap::new(),
            rust_crates: HashMap::new(),
        }
    }

    pub fn with_configs(known_files: HashSet<String>, configs: Vec<TsConfig>) -> Self {
        Self {
            known_files,
            configs,
            workspace_packages: HashMap::new(),
            rust_crates: HashMap::new(),
        }
    }

    pub fn with_configs_and_packages(
        known_files: HashSet<String>,
        configs: Vec<TsConfig>,
        workspace_packages: HashMap<String, String>,
    ) -> Self {
        Self {
            known_files,
            configs,
            workspace_packages,
            rust_crates: HashMap::new(),
        }
    }

    pub fn with_all(
        known_files: HashSet<String>,
        configs: Vec<TsConfig>,
        workspace_packages: HashMap<String, String>,
        rust_crates: HashMap<String, RustCrateInfo>,
    ) -> Self {
        Self {
            known_files,
            configs,
            workspace_packages,
            rust_crates,
        }
    }

    fn get_config_for_file(&self, from_file: &str) -> Option<&TsConfig> {
        if self.configs.is_empty() {
            return None;
        }

        // Find nearest config by walking directory hierarchy upwards
        let mut curr = Path::new(from_file).parent();
        while let Some(dir) = curr {
            let dir_str = dir.to_string_lossy().replace('\\', "/");
            if let Some(cfg) = self.configs.iter().find(|c| c.config_dir == dir_str) {
                return Some(cfg);
            }
            curr = dir.parent();
        }

        // Fallback to root config (config_dir == "")
        self.configs.iter().find(|c| c.config_dir.is_empty())
    }

    fn join_base_and_target(config_dir: &str, base_url: Option<&str>, target: &str) -> PathBuf {
        let mut p = PathBuf::new();
        if !config_dir.is_empty() {
            p.push(config_dir);
        }
        if let Some(base) = base_url {
            let trimmed = base.trim_start_matches("./");
            if !trimmed.is_empty() && trimmed != "." {
                p.push(trimmed);
            }
        }
        let trimmed_target = target.trim_start_matches("./");
        if !trimmed_target.is_empty() && trimmed_target != "." {
            p.push(trimmed_target);
        }
        p
    }

    pub fn resolve(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        if from_file.ends_with(".rs") {
            return self.resolve_rust(from_file, specifier);
        }
        if from_file.ends_with(".py") || from_file.ends_with(".pyi") {
            return self.resolve_python(from_file, specifier);
        }

        let clean_spec = specifier.split('?').next().unwrap_or(specifier).trim();
        if clean_spec.is_empty() {
            return ResolvedTarget::Unsupported("Empty import specifier".to_string());
        }

        // 1. Relative imports
        if clean_spec == "."
            || clean_spec == ".."
            || clean_spec.starts_with("./")
            || clean_spec.starts_with("../")
        {
            let from_dir = Path::new(from_file)
                .parent()
                .unwrap_or_else(|| Path::new(""));
            let joined = from_dir.join(clean_spec);
            if let Some(normalized) = Self::normalize_path(&joined) {
                if let Some(target) = self.try_resolve_file(&normalized) {
                    return ResolvedTarget::Internal(target);
                }
            }
            return ResolvedTarget::Unresolved(
                UnresolvedReasonKind::MissingInternalTarget,
                format!("Cannot resolve relative import '{clean_spec}' from '{from_file}'"),
            );
        }

        // 2. TypeScript path alias and baseUrl resolution
        if let Some(cfg) = self.get_config_for_file(from_file) {
            // Find the best-matching pattern in cfg.paths
            // Patterns are sorted descending by pattern_specificity:
            // exact match first, longest prefix+suffix wildcard next.
            let mut best_match: Option<(&str, &Vec<String>, Option<&str>)> = None;

            for (pattern, targets) in &cfg.paths {
                if let Some(pos) = pattern.find('*') {
                    let prefix = &pattern[..pos];
                    let suffix = &pattern[pos + 1..];
                    if clean_spec.starts_with(prefix)
                        && clean_spec.ends_with(suffix)
                        && clean_spec.len() >= prefix.len() + suffix.len()
                    {
                        let mid = &clean_spec[prefix.len()..clean_spec.len() - suffix.len()];
                        best_match = Some((pattern.as_str(), targets, Some(mid)));
                        break;
                    }
                } else if pattern == clean_spec {
                    best_match = Some((pattern.as_str(), targets, None));
                    break;
                }
            }

            if let Some((_pattern, targets, maybe_wildcard)) = best_match {
                // Non-fallthrough rule:
                // Once the best-matching pattern is selected, resolution attempts ONLY
                // the substitution targets for that pattern. If none resolve, it does NOT
                // continue to other mappings in paths!
                for target in targets {
                    let mapped = if let Some(mid) = maybe_wildcard {
                        if target.contains('*') {
                            target.replace('*', mid)
                        } else {
                            target.clone()
                        }
                    } else {
                        target.clone()
                    };

                    let anchor = cfg.paths_anchor.as_deref().unwrap_or(&cfg.config_dir);
                    let base_anchor = cfg.base_url_anchor.as_deref().unwrap_or(anchor);
                    let candidate_path =
                        Self::join_base_and_target(base_anchor, cfg.base_url.as_deref(), &mapped);
                    if let Some(normalized) = Self::normalize_path(&candidate_path) {
                        if let Some(hit) = self.try_resolve_file(&normalized) {
                            return ResolvedTarget::Internal(hit);
                        }
                    }
                }
                // Do NOT fall through to other patterns in paths or baseUrl if an explicit alias pattern matched
                return ResolvedTarget::Unresolved(
                    UnresolvedReasonKind::MissingAliasTarget,
                    format!(
                        "Cannot resolve target for path alias in '{clean_spec}' from '{from_file}'"
                    ),
                );
            }

            // Fallback: baseUrl alone for non-relative non-alias imports
            if let Some(base_url) = &cfg.base_url {
                let base_anchor = cfg.base_url_anchor.as_deref().unwrap_or(&cfg.config_dir);
                let candidate_path =
                    Self::join_base_and_target(base_anchor, Some(base_url), clean_spec);
                if let Some(normalized) = Self::normalize_path(&candidate_path) {
                    if let Some(hit) = self.try_resolve_file(&normalized) {
                        return ResolvedTarget::Internal(hit);
                    }
                }
            }
        }

        // 3. Absolute path and Windows drive path rejection
        if clean_spec.starts_with('/') || clean_spec.starts_with('\\') {
            return ResolvedTarget::Unresolved(
                UnresolvedReasonKind::InvalidSpecifier,
                format!("Invalid absolute import '{clean_spec}'"),
            );
        }
        if clean_spec.len() >= 2
            && clean_spec.as_bytes()[0].is_ascii_alphabetic()
            && clean_spec.as_bytes()[1] == b':'
        {
            return ResolvedTarget::Unresolved(
                UnresolvedReasonKind::InvalidSpecifier,
                format!("Invalid Windows drive import '{clean_spec}'"),
            );
        }

        // 4. Workspace package imports resolution (e.g. "@myorg/core" or "@myorg/core/utils")
        if let Some(target) = self.workspace_packages.get(clean_spec) {
            if self.known_files.contains(target) {
                return ResolvedTarget::Internal(target.clone());
            } else {
                // Attempt to resolve grounded source entrypoint (e.g. src/index.ts) if dist is absent
                let mut fallback_source = None;
                let pkg_dir = Path::new(target).parent().and_then(|p| {
                    if p.ends_with("dist") || p.ends_with("lib") {
                        p.parent()
                    } else {
                        Some(p)
                    }
                });
                if let Some(dir) = pkg_dir {
                    for candidate in &[
                        "src/index.ts",
                        "src/index.tsx",
                        "src/index.js",
                        "index.ts",
                        "index.js",
                    ] {
                        let candidate_path = dir.join(candidate);
                        if let Some(norm) = Self::normalize_path(&candidate_path) {
                            if self.known_files.contains(&norm) {
                                fallback_source = Some(norm);
                                break;
                            }
                        }
                    }
                }
                if let Some(src) = fallback_source {
                    return ResolvedTarget::Internal(src);
                }

                return ResolvedTarget::Unresolved(
                    UnresolvedReasonKind::MissingWorkspaceTarget,
                    format!(
                        "Workspace package '{clean_spec}' target '{target}' does not exist in indexed files"
                    ),
                );
            }
        }
        for (pkg_name, entry_path) in &self.workspace_packages {
            let prefix = format!("{pkg_name}/");
            if let Some(sub) = clean_spec.strip_prefix(&prefix) {
                let mut pkg_dir = Path::new(entry_path).parent();
                if let Some(d) = pkg_dir {
                    if d.ends_with("src") || d.ends_with("dist") || d.ends_with("lib") {
                        pkg_dir = d.parent();
                    }
                }
                let base = pkg_dir.unwrap_or_else(|| Path::new("")).join(sub);
                if let Some(norm) = Self::normalize_path(&base) {
                    if let Some(hit) = self.try_resolve_file(&norm) {
                        return ResolvedTarget::Internal(hit);
                    }
                }
            }
        }

        // 5. Bare external package specifiers (e.g. "react", "@radix-ui/react-dialog", "lodash/get")
        // Note: unconfigured "@/..." alias imports are NOT treated as npm packages!
        if !clean_spec.starts_with('.')
            && !clean_spec.starts_with('/')
            && !clean_spec.starts_with("@/")
        {
            return ResolvedTarget::External(clean_spec.to_string());
        }

        ResolvedTarget::Unresolved(
            UnresolvedReasonKind::General,
            format!("Unable to resolve import '{clean_spec}'"),
        )
    }

    fn has_script_extension(path: &str) -> bool {
        let script_exts = [
            ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".d.ts", ".d.mts",
            ".d.cts",
        ];
        script_exts.iter().any(|ext| path.ends_with(ext))
    }

    fn try_resolve_file(&self, base: &str) -> Option<String> {
        let trimmed = base.trim_start_matches("./");

        // 1. Exact match for requested file
        if self.known_files.contains(trimmed) {
            return Some(trimmed.to_string());
        }

        // 2. TypeScript extension substitution (for ESM/NodeNext/Bundler runtime output imports)
        // e.g. import from "./util.js" when source file on disk is "util.ts" or "util.tsx"
        if let Some(stem) = trimmed.strip_suffix(".js") {
            for subst_ext in &[".ts", ".tsx", ".d.ts"] {
                let candidate = format!("{stem}{subst_ext}");
                if self.known_files.contains(&candidate) {
                    return Some(candidate);
                }
            }
        } else if let Some(stem) = trimmed.strip_suffix(".jsx") {
            for subst_ext in &[".tsx", ".ts"] {
                let candidate = format!("{stem}{subst_ext}");
                if self.known_files.contains(&candidate) {
                    return Some(candidate);
                }
            }
        } else if let Some(stem) = trimmed.strip_suffix(".mjs") {
            for subst_ext in &[".mts", ".d.mts"] {
                let candidate = format!("{stem}{subst_ext}");
                if self.known_files.contains(&candidate) {
                    return Some(candidate);
                }
            }
        } else if let Some(stem) = trimmed.strip_suffix(".cjs") {
            for subst_ext in &[".cts", ".d.cts"] {
                let candidate = format!("{stem}{subst_ext}");
                if self.known_files.contains(&candidate) {
                    return Some(candidate);
                }
            }
        }

        // 3. Extensionless candidate matching: only append extensions if the file does NOT already have a script extension!
        // This strictly prevents double-extension appending (e.g. "./util.js" resolving to "util.js.ts").
        if !Self::has_script_extension(trimmed) {
            for ext in &[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"] {
                let candidate = format!("{trimmed}{ext}");
                if self.known_files.contains(&candidate) {
                    return Some(candidate);
                }
            }
        }

        // 4. Directory index resolution
        let index_prefix = if trimmed.is_empty() {
            String::new()
        } else {
            format!("{trimmed}/")
        };

        for ext in &[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"] {
            let index_candidate = format!("{index_prefix}index{ext}");
            if self.known_files.contains(&index_candidate) {
                return Some(index_candidate);
            }
        }

        None
    }

    pub fn resolve_rust(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        let clean_spec = specifier.trim();
        if clean_spec.is_empty() {
            return ResolvedTarget::Unsupported("Empty Rust import specifier".to_string());
        }

        // 1. External module declaration: "mod foo", "mod:foo", or "mod foo#[path=...]"
        let mod_decl_opt = if let Some(decl) = clean_spec.strip_prefix("mod ") {
            Some(decl)
        } else {
            clean_spec.strip_prefix("mod:")
        };

        if let Some(mod_decl) = mod_decl_opt {
            let (mod_name, path_override) = if let Some(idx) = mod_decl.find("#[path=") {
                let name = &mod_decl[..idx];
                let path_val = mod_decl[idx + 7..].trim_end_matches(']');
                (name.trim(), Some(path_val.trim()))
            } else {
                (mod_decl.trim(), None)
            };

            let from_dir = Path::new(from_file)
                .parent()
                .unwrap_or_else(|| Path::new(""));

            if let Some(override_path) = path_override {
                let candidate = from_dir.join(override_path);
                if let Some(norm) = Self::normalize_path(&candidate) {
                    if self.known_files.contains(&norm) {
                        return ResolvedTarget::Internal(norm);
                    }
                }
                return ResolvedTarget::Unresolved(
                    UnresolvedReasonKind::MissingInternalTarget,
                    format!(
                        "Cannot resolve module '{mod_name}' at explicit path '{override_path}' from '{from_file}'"
                    ),
                );
            }

            // Normal Rust module lookup:
            // If from_file is lib.rs, main.rs, or mod.rs:
            // Submodule is in from_dir/mod_name.rs or from_dir/mod_name/mod.rs
            let from_filename = Path::new(from_file)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            let is_module_root = from_filename == "lib.rs"
                || from_filename == "main.rs"
                || from_filename == "mod.rs";

            let target_stem = if is_module_root {
                from_dir.join(mod_name)
            } else {
                let stem = from_filename.strip_suffix(".rs").unwrap_or(from_filename);
                from_dir.join(stem).join(mod_name)
            };

            let candidate1 = format!("{}.rs", target_stem.to_string_lossy().replace('\\', "/"));
            if self.known_files.contains(&candidate1) {
                return ResolvedTarget::Internal(candidate1);
            }
            let candidate2 = format!(
                "{}/mod.rs",
                target_stem.to_string_lossy().replace('\\', "/")
            );
            if self.known_files.contains(&candidate2) {
                return ResolvedTarget::Internal(candidate2);
            }

            return ResolvedTarget::Unresolved(
                UnresolvedReasonKind::MissingInternalTarget,
                format!("Cannot resolve module declaration '{mod_name}' from '{from_file}'"),
            );
        }

        // 2. Relative or local crate references: crate::, super::, self::
        if let Some(crate_sub) = clean_spec.strip_prefix("crate::") {
            let crate_info = self.find_enclosing_crate(from_file);
            let src_dir = crate_info
                .as_ref()
                .map(|c| c.src_dir.as_str())
                .unwrap_or_else(|| {
                    Path::new(from_file)
                        .parent()
                        .and_then(|p| p.to_str())
                        .unwrap_or("")
                });

            if let Some(target) = self.resolve_rust_module_path(src_dir, crate_sub) {
                return ResolvedTarget::Internal(target);
            }

            if let Some(ci) = &crate_info {
                if let Some(entry) = ci.lib_entry.as_ref().or(ci.main_entry.as_ref()) {
                    if self.known_files.contains(entry) {
                        return ResolvedTarget::Internal(entry.clone());
                    }
                }
            }

            return ResolvedTarget::Unresolved(
                UnresolvedReasonKind::MissingInternalTarget,
                format!("Cannot resolve 'crate::{crate_sub}' from '{from_file}'"),
            );
        }

        if let Some(super_sub) = clean_spec.strip_prefix("super::") {
            let from_dir = Path::new(from_file)
                .parent()
                .unwrap_or_else(|| Path::new(""));
            let from_filename = Path::new(from_file)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            // If from_file is a file inside a module directory (e.g. src/foo/bar.rs),
            // super can refer to sibling submodules inside src/foo as well as parent items in src/
            let from_dir_str = from_dir.to_string_lossy().replace('\\', "/");
            if from_filename != "mod.rs" && !from_dir_str.is_empty() {
                if let Some(target) = self.resolve_rust_module_path(&from_dir_str, super_sub) {
                    return ResolvedTarget::Internal(target);
                }
            }

            let parent_dir = from_dir.parent().unwrap_or_else(|| Path::new(""));
            let parent_dir_str = parent_dir.to_string_lossy().replace('\\', "/");

            if let Some(target) = self.resolve_rust_module_path(&parent_dir_str, super_sub) {
                return ResolvedTarget::Internal(target);
            }
            return ResolvedTarget::Unresolved(
                UnresolvedReasonKind::MissingInternalTarget,
                format!("Cannot resolve 'super::{super_sub}' from '{from_file}'"),
            );
        }

        if let Some(self_sub) = clean_spec.strip_prefix("self::") {
            let from_filename = Path::new(from_file)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            let from_dir = Path::new(from_file)
                .parent()
                .unwrap_or_else(|| Path::new(""));

            let is_module_root = from_filename == "lib.rs"
                || from_filename == "main.rs"
                || from_filename == "mod.rs";

            // If not a module root (e.g. src/foo.rs), self's submodules live in src/foo/<sub_module>
            if !is_module_root {
                let stem = from_filename.strip_suffix(".rs").unwrap_or(from_filename);
                let sub_dir = from_dir.join(stem).to_string_lossy().replace('\\', "/");
                if let Some(target) = self.resolve_rust_module_path(&sub_dir, self_sub) {
                    return ResolvedTarget::Internal(target);
                }
            }

            let from_dir_str = from_dir.to_string_lossy().replace('\\', "/");
            if let Some(target) = self.resolve_rust_module_path(&from_dir_str, self_sub) {
                return ResolvedTarget::Internal(target);
            }
            return ResolvedTarget::Unresolved(
                UnresolvedReasonKind::MissingInternalTarget,
                format!("Cannot resolve 'self::{self_sub}' from '{from_file}'"),
            );
        }

        // 3. Workspace member crate imports
        let first_seg = clean_spec.split("::").next().unwrap_or(clean_spec);
        if let Some(target_crate) = self.rust_crates.get(first_seg) {
            let remainder = clean_spec
                .strip_prefix(first_seg)
                .unwrap_or("")
                .trim_start_matches("::");
            if !remainder.is_empty() {
                if let Some(sub_target) =
                    self.resolve_rust_module_path(&target_crate.src_dir, remainder)
                {
                    return ResolvedTarget::Internal(sub_target);
                }
            }
            if let Some(entry) = target_crate
                .lib_entry
                .as_ref()
                .or(target_crate.main_entry.as_ref())
            {
                if self.known_files.contains(entry) {
                    return ResolvedTarget::Internal(entry.clone());
                }
            }
            return ResolvedTarget::Unresolved(
                UnresolvedReasonKind::MissingWorkspaceTarget,
                format!("Workspace crate '{first_seg}' entry file not found for '{clean_spec}'"),
            );
        }

        // 4. Standard library imports
        if first_seg == "std" || first_seg == "core" || first_seg == "alloc" {
            return ResolvedTarget::External(first_seg.to_string());
        }

        // 5. External third-party crates
        ResolvedTarget::External(first_seg.to_string())
    }

    fn find_enclosing_crate(&self, from_file: &str) -> Option<&RustCrateInfo> {
        let from_path = Path::new(from_file);
        let mut best: Option<&RustCrateInfo> = None;
        let mut best_len = 0;

        for crate_info in self.rust_crates.values() {
            if crate_info.crate_dir.is_empty() {
                if best.is_none() {
                    best = Some(crate_info);
                }
            } else if from_path.starts_with(&crate_info.crate_dir)
                && crate_info.crate_dir.len() > best_len
            {
                best_len = crate_info.crate_dir.len();
                best = Some(crate_info);
            }
        }
        best
    }

    fn resolve_rust_module_path(&self, base_dir: &str, path_spec: &str) -> Option<String> {
        let segments: Vec<&str> = path_spec.split("::").collect();
        for len in (1..=segments.len()).rev() {
            let sub_path = segments[..len].join("/");
            let candidate1 = if base_dir.is_empty() {
                format!("{sub_path}.rs")
            } else {
                format!("{base_dir}/{sub_path}.rs")
            };
            if self.known_files.contains(&candidate1) {
                return Some(candidate1);
            }

            let candidate2 = if base_dir.is_empty() {
                format!("{sub_path}/mod.rs")
            } else {
                format!("{base_dir}/{sub_path}/mod.rs")
            };
            if self.known_files.contains(&candidate2) {
                return Some(candidate2);
            }
        }
        None
    }

    pub fn resolve_python(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        let clean_spec = specifier.trim();
        if clean_spec.is_empty() {
            return ResolvedTarget::Unsupported("Empty Python import specifier".to_string());
        }

        let (mod_part, symbol_part) = if let Some(idx) = clean_spec.find(':') {
            (&clean_spec[..idx], Some(&clean_spec[idx + 1..]))
        } else {
            (clean_spec, None)
        };

        let from_dir = Path::new(from_file)
            .parent()
            .unwrap_or_else(|| Path::new(""));

        // 1. Relative imports: .foo, ..bar, .
        if mod_part.starts_with('.') {
            let dot_count = mod_part.chars().take_while(|c| *c == '.').count();
            let remainder = &mod_part[dot_count..];

            let mut target_dir = from_dir.to_path_buf();
            for _ in 1..dot_count {
                if let Some(p) = target_dir.parent() {
                    target_dir = p.to_path_buf();
                } else {
                    return ResolvedTarget::Unresolved(
                        UnresolvedReasonKind::MissingInternalTarget,
                        format!(
                            "Relative import '{clean_spec}' escapes repository root from '{from_file}'"
                        ),
                    );
                }
            }

            let base_str = target_dir.to_string_lossy().replace('\\', "/");

            if remainder.is_empty() {
                if let Some(sym) = symbol_part {
                    if let Some(target) = self.resolve_python_module_file(&base_str, sym) {
                        return ResolvedTarget::Internal(target);
                    }
                }
                let init_cand = if base_str.is_empty() {
                    "__init__.py".to_string()
                } else {
                    format!("{base_str}/__init__.py")
                };
                if self.known_files.contains(&init_cand) {
                    return ResolvedTarget::Internal(init_cand);
                }
                return ResolvedTarget::Unresolved(
                    UnresolvedReasonKind::MissingInternalTarget,
                    format!("Cannot resolve relative import '{clean_spec}' from '{from_file}'"),
                );
            }

            let rel_module_path = remainder.replace('.', "/");
            let target_sub = if base_str.is_empty() {
                rel_module_path
            } else {
                format!("{base_str}/{rel_module_path}")
            };

            if let Some(target) = self.resolve_python_module_file(&target_sub, "") {
                return ResolvedTarget::Internal(target);
            }
            if let Some(sym) = symbol_part {
                if let Some(target) = self.resolve_python_module_file(&target_sub, sym) {
                    return ResolvedTarget::Internal(target);
                }
            }

            return ResolvedTarget::Unresolved(
                UnresolvedReasonKind::MissingInternalTarget,
                format!("Cannot resolve relative import '{clean_spec}' from '{from_file}'"),
            );
        }

        // 2. Absolute / project-level imports
        let mod_path = mod_part.replace('.', "/");
        let mut candidate_roots = vec!["".to_string(), "src".to_string()];
        let from_dir_str = from_dir.to_string_lossy().replace('\\', "/");
        if !from_dir_str.is_empty() && !candidate_roots.contains(&from_dir_str) {
            candidate_roots.push(from_dir_str);
        }

        for root in &candidate_roots {
            let base = if root.is_empty() {
                mod_path.clone()
            } else {
                format!("{root}/{mod_path}")
            };

            if let Some(sym) = symbol_part {
                if let Some(target) = self.resolve_python_module_file(&base, sym) {
                    return ResolvedTarget::Internal(target);
                }
            }
            if let Some(target) = self.resolve_python_module_file(&base, "") {
                return ResolvedTarget::Internal(target);
            }
        }

        // 3. Python standard library check
        let top_level = mod_part.split('.').next().unwrap_or(mod_part);
        if Self::is_python_stdlib(top_level) {
            return ResolvedTarget::External(top_level.to_string());
        }

        // 4. External third-party package
        ResolvedTarget::External(top_level.to_string())
    }

    fn resolve_python_module_file(&self, base_path: &str, symbol: &str) -> Option<String> {
        let clean_base = base_path.trim_matches('/');

        // If a symbol is specified (e.g. `from .models import User` or `from . import models`),
        // check whether symbol itself is a module file or package submodule directory first!
        if !symbol.is_empty() {
            let cand_sym_file = format!("{clean_base}/{symbol}.py");
            if self.known_files.contains(&cand_sym_file) {
                return Some(cand_sym_file);
            }
            let cand_sym_pkg = format!("{clean_base}/{symbol}/__init__.py");
            if self.known_files.contains(&cand_sym_pkg) {
                return Some(cand_sym_pkg);
            }
        }

        let cand1 = format!("{clean_base}.py");
        if self.known_files.contains(&cand1) {
            return Some(cand1);
        }

        let cand2 = format!("{clean_base}/__init__.py");
        if self.known_files.contains(&cand2) {
            return Some(cand2);
        }

        None
    }

    pub fn is_python_stdlib(name: &str) -> bool {
        matches!(
            name,
            "abc"
                | "argparse"
                | "array"
                | "asyncio"
                | "base64"
                | "builtins"
                | "collections"
                | "contextlib"
                | "copy"
                | "csv"
                | "dataclasses"
                | "datetime"
                | "decimal"
                | "difflib"
                | "dis"
                | "enum"
                | "errno"
                | "fcntl"
                | "fnmatch"
                | "fractions"
                | "functools"
                | "gc"
                | "glob"
                | "gzip"
                | "hashlib"
                | "heapq"
                | "hmac"
                | "html"
                | "http"
                | "importlib"
                | "inspect"
                | "io"
                | "itertools"
                | "json"
                | "logging"
                | "lzma"
                | "math"
                | "mimetypes"
                | "multiprocessing"
                | "numbers"
                | "operator"
                | "os"
                | "pathlib"
                | "pickle"
                | "platform"
                | "pprint"
                | "queue"
                | "random"
                | "re"
                | "secrets"
                | "select"
                | "shlex"
                | "shutil"
                | "signal"
                | "socket"
                | "sqlite3"
                | "ssl"
                | "stat"
                | "string"
                | "struct"
                | "subprocess"
                | "sys"
                | "tarfile"
                | "tempfile"
                | "textwrap"
                | "threading"
                | "time"
                | "timeit"
                | "token"
                | "tokenize"
                | "traceback"
                | "types"
                | "typing"
                | "unicodedata"
                | "unittest"
                | "urllib"
                | "uuid"
                | "warnings"
                | "weakref"
                | "xml"
                | "zipfile"
                | "zlib"
        )
    }

    pub fn normalize_path(path: &Path) -> Option<String> {
        let mut components = Vec::new();
        for comp in path.components() {
            match comp {
                std::path::Component::Normal(c) => components.push(c.to_string_lossy().to_string()),
                std::path::Component::ParentDir => {
                    components.pop()?;
                }
                std::path::Component::CurDir => {}
                std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                    // Absolute path or drive prefix escapes repository-relative boundary
                    return None;
                }
            }
        }
        Some(components.join("/"))
    }
}

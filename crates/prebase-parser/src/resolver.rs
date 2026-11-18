use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

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

pub struct ImportResolver {
    known_files: HashSet<String>,
    configs: Vec<TsConfig>,
    workspace_packages: HashMap<String, String>,
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
        }
    }

    pub fn with_configs(known_files: HashSet<String>, configs: Vec<TsConfig>) -> Self {
        Self {
            known_files,
            configs,
            workspace_packages: HashMap::new(),
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
            return ResolvedTarget::Unresolved(format!(
                "Cannot resolve relative import '{clean_spec}' from '{from_file}'"
            ));
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
                return ResolvedTarget::Unresolved(format!(
                    "Cannot resolve target for path alias in '{clean_spec}' from '{from_file}'"
                ));
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
            return ResolvedTarget::Unresolved(format!("Invalid absolute import '{clean_spec}'"));
        }
        if clean_spec.len() >= 2
            && clean_spec.as_bytes()[0].is_ascii_alphabetic()
            && clean_spec.as_bytes()[1] == b':'
        {
            return ResolvedTarget::Unresolved(format!(
                "Invalid Windows drive import '{clean_spec}'"
            ));
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

                return ResolvedTarget::Unresolved(format!(
                    "Workspace package '{clean_spec}' target '{target}' does not exist in indexed files"
                ));
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

        ResolvedTarget::Unresolved(format!("Unable to resolve import '{clean_spec}'"))
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

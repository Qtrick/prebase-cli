use std::collections::HashSet;
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
}

const EXTENSIONS: &[&str] = &[
    "", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
];

impl ImportResolver {
    pub fn new(known_files: HashSet<String>, tsconfig: Option<TsConfig>) -> Self {
        let configs = match tsconfig {
            Some(cfg) => vec![cfg],
            None => Vec::new(),
        };
        Self {
            known_files,
            configs,
        }
    }

    pub fn with_configs(known_files: HashSet<String>, configs: Vec<TsConfig>) -> Self {
        Self {
            known_files,
            configs,
        }
    }

    fn get_config_for_file(&self, from_file: &str) -> Option<&TsConfig> {
        if self.configs.is_empty() {
            return None;
        }
        if self.configs.len() == 1 {
            return Some(&self.configs[0]);
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
            for (pattern, targets) in &cfg.paths {
                if let Some(prefix) = pattern.strip_suffix('*') {
                    if let Some(remainder) = clean_spec.strip_prefix(prefix) {
                        for target in targets {
                            let target_prefix = target.strip_suffix('*').unwrap_or(target);
                            let mapped = format!("{target_prefix}{remainder}");
                            let candidate_path = Self::join_base_and_target(
                                &cfg.config_dir,
                                cfg.base_url.as_deref(),
                                &mapped,
                            );
                            if let Some(normalized) = Self::normalize_path(&candidate_path) {
                                if let Some(hit) = self.try_resolve_file(&normalized) {
                                    return ResolvedTarget::Internal(hit);
                                }
                            }
                        }
                    }
                } else if pattern == clean_spec {
                    for target in targets {
                        let candidate_path = Self::join_base_and_target(
                            &cfg.config_dir,
                            cfg.base_url.as_deref(),
                            target,
                        );
                        if let Some(normalized) = Self::normalize_path(&candidate_path) {
                            if let Some(hit) = self.try_resolve_file(&normalized) {
                                return ResolvedTarget::Internal(hit);
                            }
                        }
                    }
                }
            }

            // Fallback: baseUrl alone for non-relative non-alias imports
            if let Some(base_url) = &cfg.base_url {
                let candidate_path =
                    Self::join_base_and_target(&cfg.config_dir, Some(base_url), clean_spec);
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

        // 4. Bare external package specifiers (e.g. "react", "@radix-ui/react-dialog", "lodash/get")
        // Note: unconfigured "@/..." alias imports are NOT treated as npm packages!
        if !clean_spec.starts_with('.')
            && !clean_spec.starts_with('/')
            && !clean_spec.starts_with("@/")
        {
            return ResolvedTarget::External(clean_spec.to_string());
        }

        ResolvedTarget::Unresolved(format!("Unable to resolve import '{clean_spec}'"))
    }

    fn try_resolve_file(&self, base: &str) -> Option<String> {
        let trimmed = base.trim_start_matches("./");

        // 1. Direct match with standard extensions appended
        for ext in EXTENSIONS {
            let candidate = if ext.is_empty() {
                trimmed.to_string()
            } else {
                format!("{trimmed}{ext}")
            };
            if self.known_files.contains(&candidate) {
                return Some(candidate);
            }
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

        // 3. Directory index resolution
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

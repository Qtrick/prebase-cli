use std::collections::HashSet;
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

pub struct ImportResolver {
    known_files: HashSet<String>,
    tsconfig: Option<TsConfig>,
}

const EXTENSIONS: &[&str] = &[
    "", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
];

impl ImportResolver {
    pub fn new(known_files: HashSet<String>, tsconfig: Option<TsConfig>) -> Self {
        Self {
            known_files,
            tsconfig,
        }
    }

    pub fn resolve(&self, from_file: &str, specifier: &str) -> ResolvedTarget {
        let clean_spec = specifier.split('?').next().unwrap_or(specifier).trim();
        if clean_spec.is_empty() {
            return ResolvedTarget::Unsupported("Empty import specifier".to_string());
        }

        // 1. Relative imports
        if clean_spec.starts_with("./") || clean_spec.starts_with("../") {
            let from_dir = Path::new(from_file)
                .parent()
                .unwrap_or_else(|| Path::new(""));
            let joined = from_dir.join(clean_spec);
            let normalized = Self::normalize_path(&joined);

            if let Some(target) = self.try_resolve_file(&normalized) {
                return ResolvedTarget::Internal(target);
            }
            return ResolvedTarget::Unresolved(format!(
                "Cannot resolve relative import '{clean_spec}' from '{from_file}'"
            ));
        }

        // 2. TypeScript path alias resolution (e.g. @/* -> src/*)
        if let Some(cfg) = &self.tsconfig {
            for (pattern, targets) in &cfg.paths {
                if let Some(prefix) = pattern.strip_suffix('*') {
                    if let Some(remainder) = clean_spec.strip_prefix(prefix) {
                        for target in targets {
                            let target_prefix = target.strip_suffix('*').unwrap_or(target);
                            let mapped = format!("{target_prefix}{remainder}");
                            let normalized = Self::normalize_path(Path::new(&mapped));
                            if let Some(hit) = self.try_resolve_file(&normalized) {
                                return ResolvedTarget::Internal(hit);
                            }
                        }
                    }
                } else if pattern == clean_spec {
                    for target in targets {
                        let normalized = Self::normalize_path(Path::new(target));
                        if let Some(hit) = self.try_resolve_file(&normalized) {
                            return ResolvedTarget::Internal(hit);
                        }
                    }
                }
            }

            // baseUrl resolution
            if let Some(base_url) = &cfg.base_url {
                let mapped = Path::new(base_url).join(clean_spec);
                let normalized = Self::normalize_path(&mapped);
                if let Some(hit) = self.try_resolve_file(&normalized) {
                    return ResolvedTarget::Internal(hit);
                }
            }
        }

        // 3. Common convention alias fallback (e.g. "@/..." -> "src/...")
        if let Some(remainder) = clean_spec.strip_prefix("@/") {
            for prefix in &["src/", ""] {
                let candidate = format!("{prefix}{remainder}");
                let normalized = Self::normalize_path(Path::new(&candidate));
                if let Some(hit) = self.try_resolve_file(&normalized) {
                    return ResolvedTarget::Internal(hit);
                }
            }
        }

        // 4. If it's a bare specifier (package) like "react", "lodash/get", "@radix-ui/react-dialog"
        if !clean_spec.starts_with('.') && !clean_spec.starts_with('/') {
            return ResolvedTarget::External(clean_spec.to_string());
        }

        ResolvedTarget::Unresolved(format!("Unable to resolve import '{clean_spec}'"))
    }

    fn try_resolve_file(&self, base: &str) -> Option<String> {
        let trimmed = base.trim_start_matches("./");

        // Direct match with extension
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

        // Directory index resolution
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

    pub fn normalize_path(path: &Path) -> String {
        let mut components = Vec::new();
        for comp in path.components() {
            match comp {
                std::path::Component::Normal(c) => components.push(c.to_string_lossy().to_string()),
                std::path::Component::ParentDir => {
                    components.pop();
                }
                std::path::Component::CurDir => {}
                _ => {}
            }
        }
        components.join("/")
    }
}

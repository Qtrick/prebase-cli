use serde::Deserialize;
use std::path::Path;
use tracing::warn;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct CompilerOptions {
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
    pub paths: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum ExtendsField {
    Single(String),
    Multiple(Vec<String>),
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawTsConfig {
    pub extends: Option<ExtendsField>,
    #[serde(rename = "compilerOptions")]
    pub compiler_options: Option<CompilerOptions>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TsConfig {
    pub config_dir: String,
    pub base_url: Option<String>,
    pub base_url_anchor: Option<String>,
    pub paths: Vec<(String, Vec<String>)>,
    pub paths_anchor: Option<String>,
}

impl TsConfig {
    pub fn new(
        base_url: Option<String>,
        paths_map: std::collections::HashMap<String, Vec<String>>,
    ) -> Self {
        let mut paths: Vec<(String, Vec<String>)> = paths_map.into_iter().collect();
        paths.sort_by(|a, b| {
            let spec_a = pattern_specificity(&a.0);
            let spec_b = pattern_specificity(&b.0);
            spec_b.cmp(&spec_a)
        });
        Self {
            config_dir: String::new(),
            base_url,
            base_url_anchor: None,
            paths,
            paths_anchor: None,
        }
    }

    pub fn load_from_dir(dir: &Path) -> Option<Self> {
        let mut visited = std::collections::HashSet::new();
        Self::load_with_inheritance(dir, "tsconfig.json", &mut visited, 0)
    }

    pub fn load_from_file_in_repo(repo_root: &Path, rel_config_path: &str) -> Option<Self> {
        let mut visited = std::collections::HashSet::new();
        Self::load_with_inheritance(repo_root, rel_config_path, &mut visited, 0)
    }

    fn load_with_inheritance(
        repo_root: &Path,
        rel_config_path: &str,
        visited: &mut std::collections::HashSet<String>,
        depth: usize,
    ) -> Option<Self> {
        if depth > 8 {
            warn!("tsconfig extends recursion depth limit reached at {rel_config_path}");
            return None;
        }

        let normalized_path =
            crate::resolver::ImportResolver::normalize_path(Path::new(rel_config_path))?;
        if !visited.insert(normalized_path.clone()) {
            warn!("tsconfig extends circular dependency detected at {normalized_path}");
            return None;
        }

        let res = Self::load_with_inheritance_inner(repo_root, &normalized_path, visited, depth);
        visited.remove(&normalized_path);
        res
    }

    fn load_with_inheritance_inner(
        repo_root: &Path,
        normalized_path: &str,
        visited: &mut std::collections::HashSet<String>,
        depth: usize,
    ) -> Option<Self> {
        let content =
            match prebase_core::safe_read_file_to_string(repo_root, normalized_path, 1024 * 1024) {
                Ok(c) => c,
                Err(e) => {
                    if !matches!(e, prebase_core::SafeReadError::NotFound(_)) {
                        warn!("Failed or rejected reading tsconfig at {normalized_path}: {e}");
                    }
                    return None;
                }
            };

        let parent_dir = Path::new(normalized_path)
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .to_string_lossy()
            .replace('\\', "/");

        let clean = clean_jsonc(&content);
        let raw: RawTsConfig = match serde_json::from_str(&clean) {
            Ok(c) => c,
            Err(e) => {
                warn!("Failed to parse tsconfig at {normalized_path}: {e}");
                return None;
            }
        };

        let extends_list: Vec<String> = match raw.extends {
            Some(ExtendsField::Single(s)) => vec![s],
            Some(ExtendsField::Multiple(list)) => list,
            None => Vec::new(),
        };

        let mut base_config: Option<Self> = None;
        for extends_ref in &extends_list {
            if extends_ref.starts_with('.') {
                let p = Path::new(&parent_dir).join(extends_ref);
                let candidate = crate::resolver::ImportResolver::normalize_path(&p);
                let loaded = if let Some(target) = candidate {
                    let resolved = if prebase_core::is_safe_relative_path(&target)
                        && repo_root.join(&target).is_file()
                    {
                        Some(target)
                    } else {
                        let with_json = format!("{target}.json");
                        if prebase_core::is_safe_relative_path(&with_json)
                            && repo_root.join(&with_json).is_file()
                        {
                            Some(with_json)
                        } else {
                            None
                        }
                    };
                    resolved.and_then(|t| {
                        Self::load_with_inheritance(repo_root, &t, visited, depth + 1)
                    })
                } else {
                    None
                };

                let next_base = match loaded {
                    Some(cfg) => cfg,
                    None => {
                        warn!("Failed to resolve local tsconfig extends reference '{extends_ref}' at {normalized_path}");
                        return None;
                    }
                };

                let has_next_base_url = next_base.base_url.is_some();
                let has_next_paths = next_base.paths_anchor.is_some();
                base_config = Some(match base_config {
                    Some(prev) => Self {
                        config_dir: next_base.config_dir,
                        base_url: next_base.base_url.or(prev.base_url),
                        base_url_anchor: if has_next_base_url {
                            next_base.base_url_anchor
                        } else {
                            prev.base_url_anchor
                        },
                        paths: if has_next_paths {
                            next_base.paths
                        } else {
                            prev.paths
                        },
                        paths_anchor: if has_next_paths {
                            next_base.paths_anchor
                        } else {
                            prev.paths_anchor
                        },
                    },
                    None => next_base,
                });
            }
        }

        let opts = raw.compiler_options.unwrap_or_default();
        let mut child_paths = Vec::new();
        let has_child_paths_field = opts.paths.is_some();
        if let Some(paths_map) = opts.paths {
            for (pattern, val) in paths_map {
                if let Some(arr) = val.as_array() {
                    let targets: Vec<String> = arr
                        .iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect();
                    child_paths.push((pattern, targets));
                }
            }
        }

        let (final_paths, paths_anchor) = if has_child_paths_field {
            let mut paths = child_paths;
            paths.sort_by(|a, b| {
                let spec_a = pattern_specificity(&a.0);
                let spec_b = pattern_specificity(&b.0);
                spec_b.cmp(&spec_a)
            });
            (paths, Some(parent_dir.clone()))
        } else if let Some(ref mut base) = base_config {
            let anchor = base
                .paths_anchor
                .clone()
                .or_else(|| Some(base.config_dir.clone()));
            (std::mem::take(&mut base.paths), anchor)
        } else {
            (Vec::new(), None)
        };

        let (final_base_url, base_url_anchor) = if opts.base_url.is_some() {
            (opts.base_url, Some(parent_dir.clone()))
        } else if let Some(ref base) = base_config {
            let anchor = base
                .base_url_anchor
                .clone()
                .or_else(|| Some(base.config_dir.clone()));
            (base.base_url.clone(), anchor)
        } else {
            (None, None)
        };

        Some(Self {
            config_dir: parent_dir,
            base_url: final_base_url,
            base_url_anchor,
            paths: final_paths,
            paths_anchor,
        })
    }

    pub fn parse_jsonc(content: &str, config_dir: &str) -> Option<Self> {
        // Strip JS/JSON comments and trailing commas before braces/brackets
        let clean = clean_jsonc(content);

        match serde_json::from_str::<RawTsConfig>(&clean) {
            Ok(cfg) => {
                let opts = cfg.compiler_options.unwrap_or_default();
                let mut paths = Vec::new();
                if let Some(paths_map) = opts.paths {
                    for (pattern, val) in paths_map {
                        if let Some(arr) = val.as_array() {
                            let targets: Vec<String> = arr
                                .iter()
                                .filter_map(|v| v.as_str().map(String::from))
                                .collect();
                            paths.push((pattern, targets));
                        }
                    }
                    // Sort descending by pattern specificity:
                    paths.sort_by(|a, b| {
                        let spec_a = pattern_specificity(&a.0);
                        let spec_b = pattern_specificity(&b.0);
                        spec_b.cmp(&spec_a)
                    });
                }
                Some(Self {
                    config_dir: config_dir.to_string(),
                    base_url: opts.base_url,
                    base_url_anchor: Some(config_dir.to_string()),
                    paths,
                    paths_anchor: Some(config_dir.to_string()),
                })
            }
            Err(e) => {
                warn!("Failed to parse tsconfig.json: {e}");
                None
            }
        }
    }
}

pub fn pattern_specificity(pattern: &str) -> (usize, usize) {
    if let Some(pos) = pattern.find('*') {
        let prefix = &pattern[..pos];
        let suffix = &pattern[pos + 1..];
        (prefix.len(), suffix.len())
    } else {
        // Exact match without wildcard has highest precedence
        (usize::MAX, usize::MAX)
    }
}

pub fn clean_jsonc(input: &str) -> String {
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);

    // Pass 1: Strip line comments (//) and block comments (/* */)
    let mut without_comments = String::with_capacity(input.len());
    let mut in_string = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        if in_line_comment {
            if c == '\n' {
                in_line_comment = false;
                without_comments.push(c);
            }
        } else if in_block_comment {
            if c == '*' && chars.peek() == Some(&'/') {
                chars.next();
                in_block_comment = false;
                without_comments.push(' ');
            }
        } else if in_string {
            without_comments.push(c);
            if c == '\\' {
                if let Some(next_c) = chars.next() {
                    without_comments.push(next_c);
                }
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            without_comments.push(c);
        } else if c == '/' && chars.peek() == Some(&'/') {
            chars.next();
            in_line_comment = true;
        } else if c == '/' && chars.peek() == Some(&'*') {
            chars.next();
            in_block_comment = true;
        } else {
            without_comments.push(c);
        }
    }

    // Pass 2: Strip trailing commas before closing braces } or ] outside strings
    let mut output = String::with_capacity(without_comments.len());
    let mut in_str = false;
    let chars_vec: Vec<char> = without_comments.chars().collect();
    let mut i = 0;
    while i < chars_vec.len() {
        let c = chars_vec[i];
        if in_str {
            output.push(c);
            if c == '\\' && i + 1 < chars_vec.len() {
                i += 1;
                output.push(chars_vec[i]);
            } else if c == '"' {
                in_str = false;
            }
        } else if c == '"' {
            in_str = true;
            output.push(c);
        } else if c == ',' {
            // Peek forward past whitespace to see if the next non-whitespace char is '}' or ']'
            let mut j = i + 1;
            while j < chars_vec.len() && chars_vec[j].is_whitespace() {
                j += 1;
            }
            if j < chars_vec.len() && (chars_vec[j] == '}' || chars_vec[j] == ']') {
                // Trailing comma: skip pushing the comma!
            } else {
                output.push(c);
            }
        } else {
            output.push(c);
        }
        i += 1;
    }

    output
}

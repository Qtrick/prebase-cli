use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;
use tracing::warn;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct CompilerOptions {
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
    pub paths: Option<HashMap<String, Vec<String>>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawTsConfig {
    #[serde(rename = "compilerOptions")]
    pub compiler_options: Option<CompilerOptions>,
}

#[derive(Debug, Clone, Default)]
pub struct TsConfig {
    pub base_url: Option<String>,
    pub paths: HashMap<String, Vec<String>>,
}

impl TsConfig {
    pub fn load_from_dir(dir: &Path) -> Option<Self> {
        let path = dir.join("tsconfig.json");
        if !path.exists() {
            return None;
        }

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                warn!("Failed to read tsconfig.json: {e}");
                return None;
            }
        };

        // Strip simple JS/JSON comments if present
        let clean = strip_json_comments(&content);

        match serde_json::from_str::<RawTsConfig>(&clean) {
            Ok(cfg) => {
                let opts = cfg.compiler_options.unwrap_or_default();
                Some(Self {
                    base_url: opts.base_url,
                    paths: opts.paths.unwrap_or_default(),
                })
            }
            Err(e) => {
                warn!("Failed to parse tsconfig.json: {e}");
                None
            }
        }
    }
}

fn strip_json_comments(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut in_string = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        if in_line_comment {
            if c == '\n' {
                in_line_comment = false;
                output.push(c);
            }
        } else if in_block_comment {
            if c == '*' && chars.peek() == Some(&'/') {
                chars.next();
                in_block_comment = false;
            }
        } else if in_string {
            output.push(c);
            if c == '\\' {
                if let Some(next_c) = chars.next() {
                    output.push(next_c);
                }
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            output.push(c);
        } else if c == '/' && chars.peek() == Some(&'/') {
            chars.next();
            in_line_comment = true;
        } else if c == '/' && chars.peek() == Some(&'*') {
            chars.next();
            in_block_comment = true;
        } else {
            output.push(c);
        }
    }

    output
}

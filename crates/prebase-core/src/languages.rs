use crate::model::FileKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CapabilityLevel {
    Recognized = 0,
    Parsed = 1,
    Resolved = 2,
    ProjectAware = 3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LanguageDescriptor {
    pub id: &'static str,
    pub display_name: &'static str,
    pub extensions: &'static [&'static str],
    pub special_filenames: &'static [&'static str],
    pub capability_level: CapabilityLevel,
    pub file_kind: FileKind,
    pub color: &'static str,
    pub manifest_files: &'static [&'static str],
}

pub static OTHER_DESCRIPTOR: LanguageDescriptor = LanguageDescriptor {
    id: "other",
    display_name: "Other",
    extensions: &[],
    special_filenames: &[],
    capability_level: CapabilityLevel::Recognized,
    file_kind: FileKind::Other,
    color: "#71717a",
    manifest_files: &[],
};

pub static LANGUAGES: &[LanguageDescriptor] = &[
    LanguageDescriptor {
        id: "typescript",
        display_name: "TypeScript",
        extensions: &[".ts", ".mts", ".cts"],
        special_filenames: &[],
        capability_level: CapabilityLevel::ProjectAware,
        file_kind: FileKind::Source,
        color: "#3178c6",
        manifest_files: &["tsconfig.json"],
    },
    LanguageDescriptor {
        id: "tsx",
        display_name: "TSX",
        extensions: &[".tsx"],
        special_filenames: &[],
        capability_level: CapabilityLevel::ProjectAware,
        file_kind: FileKind::Source,
        color: "#22d3ee",
        manifest_files: &["tsconfig.json"],
    },
    LanguageDescriptor {
        id: "javascript",
        display_name: "JavaScript",
        extensions: &[".js", ".mjs", ".cjs"],
        special_filenames: &[],
        capability_level: CapabilityLevel::ProjectAware,
        file_kind: FileKind::Source,
        color: "#f1e05a",
        manifest_files: &["package.json", "jsconfig.json"],
    },
    LanguageDescriptor {
        id: "jsx",
        display_name: "JSX",
        extensions: &[".jsx"],
        special_filenames: &[],
        capability_level: CapabilityLevel::ProjectAware,
        file_kind: FileKind::Source,
        color: "#38bdf8",
        manifest_files: &["package.json"],
    },
    LanguageDescriptor {
        id: "python",
        display_name: "Python",
        extensions: &[".py", ".pyi"],
        special_filenames: &[],
        capability_level: CapabilityLevel::ProjectAware,
        file_kind: FileKind::Source,
        color: "#3572A5",
        manifest_files: &[
            "pyproject.toml",
            "setup.py",
            "setup.cfg",
            "requirements.txt",
        ],
    },
    LanguageDescriptor {
        id: "rust",
        display_name: "Rust",
        extensions: &[".rs"],
        special_filenames: &[],
        capability_level: CapabilityLevel::ProjectAware,
        file_kind: FileKind::Source,
        color: "#dea584",
        manifest_files: &["Cargo.toml", "Cargo.lock"],
    },
    LanguageDescriptor {
        id: "go",
        display_name: "Go",
        extensions: &[".go"],
        special_filenames: &[],
        capability_level: CapabilityLevel::ProjectAware,
        file_kind: FileKind::Source,
        color: "#00ADD8",
        manifest_files: &["go.mod", "go.work"],
    },
    LanguageDescriptor {
        id: "java",
        display_name: "Java",
        extensions: &[".java"],
        special_filenames: &[],
        capability_level: CapabilityLevel::ProjectAware,
        file_kind: FileKind::Source,
        color: "#b07219",
        manifest_files: &["pom.xml", "build.gradle", "settings.gradle"],
    },
    LanguageDescriptor {
        id: "c",
        display_name: "C",
        extensions: &[".c", ".h"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Resolved,
        file_kind: FileKind::Source,
        color: "#555555",
        manifest_files: &["CMakeLists.txt", "Makefile", "compile_commands.json"],
    },
    LanguageDescriptor {
        id: "cpp",
        display_name: "C++",
        extensions: &[".cpp", ".hpp", ".cc", ".cxx", ".hh", ".hxx"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Resolved,
        file_kind: FileKind::Source,
        color: "#f34b7d",
        manifest_files: &["CMakeLists.txt", "Makefile", "compile_commands.json"],
    },
    LanguageDescriptor {
        id: "csharp",
        display_name: "C#",
        extensions: &[".cs"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Resolved,
        file_kind: FileKind::Source,
        color: "#178600",
        manifest_files: &[".csproj", ".sln", "Directory.Build.props"],
    },
    LanguageDescriptor {
        id: "ruby",
        display_name: "Ruby",
        extensions: &[".rb", ".rake"],
        special_filenames: &["Rakefile", "Gemfile"],
        capability_level: CapabilityLevel::Resolved,
        file_kind: FileKind::Source,
        color: "#701516",
        manifest_files: &["Gemfile", "Gemfile.lock"],
    },
    LanguageDescriptor {
        id: "php",
        display_name: "PHP",
        extensions: &[".php", ".phtml"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Resolved,
        file_kind: FileKind::Source,
        color: "#4F5D95",
        manifest_files: &["composer.json", "composer.lock"],
    },
    LanguageDescriptor {
        id: "kotlin",
        display_name: "Kotlin",
        extensions: &[".kt", ".kts"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Resolved,
        file_kind: FileKind::Source,
        color: "#A97BFF",
        manifest_files: &["build.gradle.kts", "settings.gradle.kts"],
    },
    LanguageDescriptor {
        id: "swift",
        display_name: "Swift",
        extensions: &[".swift"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Resolved,
        file_kind: FileKind::Source,
        color: "#F05138",
        manifest_files: &["Package.swift"],
    },
    LanguageDescriptor {
        id: "lua",
        display_name: "Lua",
        extensions: &[".lua"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Resolved,
        file_kind: FileKind::Source,
        color: "#000080",
        manifest_files: &[],
    },
    LanguageDescriptor {
        id: "scala",
        display_name: "Scala",
        extensions: &[".scala", ".sc"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Resolved,
        file_kind: FileKind::Source,
        color: "#c22d40",
        manifest_files: &["build.sbt"],
    },
    LanguageDescriptor {
        id: "elixir",
        display_name: "Elixir",
        extensions: &[".ex", ".exs"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Parsed,
        file_kind: FileKind::Source,
        color: "#6e4a7e",
        manifest_files: &["mix.exs", "mix.lock"],
    },
    LanguageDescriptor {
        id: "haskell",
        display_name: "Haskell",
        extensions: &[".hs", ".lhs"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Parsed,
        file_kind: FileKind::Source,
        color: "#5e5086",
        manifest_files: &["package.yaml", "stack.yaml"],
    },
    LanguageDescriptor {
        id: "r",
        display_name: "R",
        extensions: &[".r", ".R"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Parsed,
        file_kind: FileKind::Source,
        color: "#198CE7",
        manifest_files: &["DESCRIPTION"],
    },
    LanguageDescriptor {
        id: "shell",
        display_name: "Shell",
        extensions: &[".sh", ".bash", ".zsh"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Parsed,
        file_kind: FileKind::Source,
        color: "#89e051",
        manifest_files: &[],
    },
    LanguageDescriptor {
        id: "html",
        display_name: "HTML",
        extensions: &[".html", ".htm"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Parsed,
        file_kind: FileKind::Source,
        color: "#e34c26",
        manifest_files: &[],
    },
    LanguageDescriptor {
        id: "css",
        display_name: "CSS",
        extensions: &[".css"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Parsed,
        file_kind: FileKind::Source,
        color: "#a371f7",
        manifest_files: &[],
    },
    LanguageDescriptor {
        id: "scss",
        display_name: "SCSS",
        extensions: &[".scss", ".sass"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Parsed,
        file_kind: FileKind::Source,
        color: "#c6538c",
        manifest_files: &[],
    },
    LanguageDescriptor {
        id: "json",
        display_name: "JSON",
        extensions: &[".json"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Recognized,
        file_kind: FileKind::Config,
        color: "#8b8b8b",
        manifest_files: &[],
    },
    LanguageDescriptor {
        id: "toml",
        display_name: "TOML",
        extensions: &[".toml"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Recognized,
        file_kind: FileKind::Config,
        color: "#9c4221",
        manifest_files: &[],
    },
    LanguageDescriptor {
        id: "yaml",
        display_name: "YAML",
        extensions: &[".yaml", ".yml"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Recognized,
        file_kind: FileKind::Config,
        color: "#cb171e",
        manifest_files: &[],
    },
    LanguageDescriptor {
        id: "markdown",
        display_name: "Markdown",
        extensions: &[".md", ".markdown", ".mdx"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Recognized,
        file_kind: FileKind::Doc,
        color: "#519aba",
        manifest_files: &[],
    },
    LanguageDescriptor {
        id: "sql",
        display_name: "SQL",
        extensions: &[".sql"],
        special_filenames: &[],
        capability_level: CapabilityLevel::Recognized,
        file_kind: FileKind::Source,
        color: "#e38c00",
        manifest_files: &[],
    },
];

pub fn all_languages() -> &'static [LanguageDescriptor] {
    LANGUAGES
}

pub fn language_by_id(id: &str) -> Option<&'static LanguageDescriptor> {
    LANGUAGES.iter().find(|l| l.id == id)
}

pub fn detect_language(filename_or_path: &str) -> Option<&'static LanguageDescriptor> {
    let filename = filename_or_path
        .split('/')
        .next_back()
        .unwrap_or(filename_or_path)
        .split('\\')
        .next_back()
        .unwrap_or(filename_or_path);

    // 1. Check special exact filenames (e.g. Rakefile, Gemfile)
    for lang in LANGUAGES {
        if lang
            .special_filenames
            .iter()
            .any(|&sf| sf.eq_ignore_ascii_case(filename))
        {
            return Some(lang);
        }
    }

    // 2. Extract lowercased extension
    let lower_filename = filename.to_lowercase();
    let ext = if let Some(idx) = lower_filename.rfind('.') {
        &lower_filename[idx..]
    } else {
        ""
    };

    if ext.is_empty() {
        return None;
    }

    // 3. Match extensions
    LANGUAGES.iter().find(|lang| {
        lang.extensions
            .iter()
            .any(|&le| le.eq_ignore_ascii_case(ext))
    })
}

pub fn detect_language_or_other(filename_or_path: &str) -> &'static LanguageDescriptor {
    detect_language(filename_or_path).unwrap_or(&OTHER_DESCRIPTOR)
}

pub fn is_supported_source_file(filename_or_path: &str) -> bool {
    if let Some(desc) = detect_language(filename_or_path) {
        desc.capability_level > CapabilityLevel::Recognized
    } else {
        false
    }
}

pub fn is_manifest_file(filename_or_path: &str) -> bool {
    let filename = filename_or_path
        .split('/')
        .next_back()
        .unwrap_or(filename_or_path)
        .split('\\')
        .next_back()
        .unwrap_or(filename_or_path);

    for lang in LANGUAGES {
        for &manifest in lang.manifest_files {
            if manifest.starts_with('.') {
                // Suffix matching like .csproj
                if filename.ends_with(manifest) {
                    return true;
                }
            } else if manifest.eq_ignore_ascii_case(filename) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_language_detection_core_extensions() {
        assert_eq!(detect_language("src/index.ts").unwrap().id, "typescript");
        assert_eq!(detect_language("src/App.tsx").unwrap().id, "tsx");
        assert_eq!(detect_language("server/main.py").unwrap().id, "python");
        assert_eq!(detect_language("crates/lib.rs").unwrap().id, "rust");
        assert_eq!(detect_language("cmd/main.go").unwrap().id, "go");
        assert_eq!(detect_language("App.java").unwrap().id, "java");
        assert_eq!(detect_language("main.c").unwrap().id, "c");
        assert_eq!(detect_language("header.h").unwrap().id, "c");
        assert_eq!(detect_language("engine.cpp").unwrap().id, "cpp");
        assert_eq!(detect_language("Program.cs").unwrap().id, "csharp");
        assert_eq!(detect_language("script.rb").unwrap().id, "ruby");
        assert_eq!(detect_language("index.php").unwrap().id, "php");
    }

    #[test]
    fn test_uppercase_and_special_files() {
        assert_eq!(detect_language("SCRIPT.PY").unwrap().id, "python");
        assert_eq!(detect_language("Rakefile").unwrap().id, "ruby");
        assert_eq!(detect_language("Gemfile").unwrap().id, "ruby");
        assert_eq!(detect_language("analysis.R").unwrap().id, "r");
    }

    #[test]
    fn test_manifest_file_detection() {
        assert!(is_manifest_file("Cargo.toml"));
        assert!(is_manifest_file("go.mod"));
        assert!(is_manifest_file("pom.xml"));
        assert!(is_manifest_file("pyproject.toml"));
        assert!(is_manifest_file("package.json"));
        assert!(is_manifest_file("App.csproj"));
        assert!(!is_manifest_file("regular_file.txt"));
    }

    #[test]
    fn test_capability_levels() {
        assert!(is_supported_source_file("main.py"));
        assert!(is_supported_source_file("lib.rs"));
        assert!(is_supported_source_file("index.ts"));
        // JSON and Markdown are Level 0 (Recognized, but not code dependency analyzed)
        assert!(!is_supported_source_file("data.json"));
        assert!(!is_supported_source_file("README.md"));
        assert_eq!(detect_language("data.json").unwrap().id, "json");
        assert_eq!(detect_language("README.md").unwrap().id, "markdown");
    }
}

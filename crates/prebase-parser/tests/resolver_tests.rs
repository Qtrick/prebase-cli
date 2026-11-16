use prebase_parser::{ImportResolver, ResolvedTarget, TsConfig};
use std::collections::{HashMap, HashSet};

/// Defect R1: Escaping Parent Directory Traversal
///
/// If a file `src/main.ts` contains `import { value } from "../../util"`,
/// even if `repo/util.ts` exists, the resolver MUST NOT connect `src/main.ts` to `util.ts`.
/// It must return `Unresolved`.
///
/// Also verifies:
/// - Legitimate parent navigation within repo: `src/sub/main.ts` importing `../util` or `../../util`
///   when it stays within the repo resolves to internal files.
/// - Legitimate navigation exceeding depth returns `Unresolved`.
/// - Absolute paths like `/etc/passwd` or `C:\file` or `C:/file` are rejected as `Unresolved`
///   rather than being misclassified as external npm packages or internal files.
#[test]
fn test_defect_r1_escaping_parent_directory_traversal() {
    let mut known_files = HashSet::new();
    known_files.insert("util.ts".to_string());
    known_files.insert("src/main.ts".to_string());
    known_files.insert("src/util.ts".to_string());
    known_files.insert("src/sub/main.ts".to_string());

    let resolver = ImportResolver::new(known_files, None);

    // 1. Escaping parent directory traversal:
    // `src/main.ts` is 1 level deep. `../../util` traverses 2 levels up, escaping repository root.
    // Even though `util.ts` exists in the repo root, this MUST NOT resolve to `util.ts`!
    let escaped_result = resolver.resolve("src/main.ts", "../../util");
    assert!(
        matches!(escaped_result, ResolvedTarget::Unresolved(_)),
        "Escaping traversal '../../util' from 'src/main.ts' must be Unresolved, got {escaped_result:?}"
    );

    // Also root-level file attempting parent traversal
    let root_escaped = resolver.resolve("main.ts", "../util");
    assert!(
        matches!(root_escaped, ResolvedTarget::Unresolved(_)),
        "Escaping traversal '../util' from 'main.ts' must be Unresolved, got {root_escaped:?}"
    );

    // 2. Legitimate parent navigation within repo:
    // `src/sub/main.ts` is 2 levels deep.
    // `../util` navigates up 1 level -> `src/util.ts` (stays within repo)
    let legit_parent_1 = resolver.resolve("src/sub/main.ts", "../util");
    assert_eq!(
        legit_parent_1,
        ResolvedTarget::Internal("src/util.ts".to_string()),
        "Legitimate traversal '../util' from 'src/sub/main.ts' should resolve to 'src/util.ts'"
    );

    // `../../util` navigates up 2 levels -> `util.ts` in repo root (stays within repo)
    let legit_parent_2 = resolver.resolve("src/sub/main.ts", "../../util");
    assert_eq!(
        legit_parent_2,
        ResolvedTarget::Internal("util.ts".to_string()),
        "Legitimate traversal '../../util' from 'src/sub/main.ts' should resolve to 'util.ts'"
    );

    // `../../../util` navigates up 3 levels (escapes repo root)
    let legit_parent_3_escaped = resolver.resolve("src/sub/main.ts", "../../../util");
    assert!(
        matches!(legit_parent_3_escaped, ResolvedTarget::Unresolved(_)),
        "Escaping traversal '../../../util' from 'src/sub/main.ts' must be Unresolved, got {legit_parent_3_escaped:?}"
    );

    // 3. Absolute paths must be rejected as Unresolved, never External or Internal
    let abs_unix = resolver.resolve("src/main.ts", "/etc/passwd");
    assert!(
        matches!(abs_unix, ResolvedTarget::Unresolved(_)),
        "Unix absolute path '/etc/passwd' must be Unresolved, got {abs_unix:?}"
    );

    let abs_win_backslash = resolver.resolve("src/main.ts", "C:\\file");
    assert!(
        matches!(abs_win_backslash, ResolvedTarget::Unresolved(_)),
        "Windows absolute path 'C:\\file' must be Unresolved, got {abs_win_backslash:?}"
    );

    let abs_win_forward = resolver.resolve("src/main.ts", "C:/file");
    assert!(
        matches!(abs_win_forward, ResolvedTarget::Unresolved(_)),
        "Windows absolute path 'C:/file' must be Unresolved, got {abs_win_forward:?}"
    );

    let abs_win_drive_d = resolver.resolve("src/main.ts", "D:/project/util");
    assert!(
        matches!(abs_win_drive_d, ResolvedTarget::Unresolved(_)),
        "Windows drive path 'D:/project/util' must be Unresolved, got {abs_win_drive_d:?}"
    );
}

/// Defect R2: Deterministic Overlapping Alias Precedence
///
/// When tsconfig paths configuration contains overlapping patterns like:
/// - `@/*` -> `["src/*"]`
/// - `@/components/*` -> `["special/components/*"]`
///
/// An import of `@/components/Button` must deterministically match the more specific
/// wildcard `@/components/*` (longest prefix before `*`) and resolve to `special/components/Button.ts`,
/// NOT `src/components/Button.ts`.
///
/// Also verifies:
/// - Exact match (e.g. `@/components/Button` -> `exact/Button.ts`) has higher precedence than any wildcard.
/// - Fallback array order is preserved.
#[test]
fn test_defect_r2_deterministic_overlapping_alias_precedence() {
    let mut known_files = HashSet::new();
    known_files.insert("src/components/Button.ts".to_string());
    known_files.insert("special/components/Button.ts".to_string());
    known_files.insert("exact/Button.ts".to_string());
    known_files.insert("vendor/helper.ts".to_string());
    known_files.insert("fallback/helper.ts".to_string());

    // Test A: Longest prefix wildcard precedence over shorter wildcard.
    // Construct paths with both patterns. Regardless of insertion order,
    // `@/components/*` (prefix length 13) MUST beat `@/*` (prefix length 2).
    for reverse_order in [false, true] {
        let mut paths = HashMap::new();
        if !reverse_order {
            paths.insert("@/*".to_string(), vec!["src/*".to_string()]);
            paths.insert(
                "@/components/*".to_string(),
                vec!["special/components/*".to_string()],
            );
        } else {
            paths.insert(
                "@/components/*".to_string(),
                vec!["special/components/*".to_string()],
            );
            paths.insert("@/*".to_string(), vec!["src/*".to_string()]);
        }

        let tsconfig = TsConfig {
            base_url: None,
            paths,
        };
        let tsconfig = TsConfig::new(None, paths);

        let resolver = ImportResolver::new(known_files.clone(), Some(tsconfig.clone()));
        let resolved = resolver.resolve("src/index.ts", "@/components/Button");

        assert_eq!(
            resolved,
            ResolvedTarget::Internal("special/components/Button.ts".to_string()),
            "More specific wildcard '@/components/*' must have precedence over '@/*', got {resolved:?} (reverse_order={reverse_order})"
        );
    }

    // Test B: Exact match pattern has higher precedence than any wildcard pattern.
    {
        let mut paths = HashMap::new();
        paths.insert("@/*".to_string(), vec!["src/*".to_string()]);
        paths.insert(
            "@/components/*".to_string(),
            vec!["special/components/*".to_string()],
        );
        paths.insert(
            "@/components/Button".to_string(),
            vec!["exact/Button.ts".to_string()],
        );

        let tsconfig = TsConfig {
            base_url: None,
            paths,
        };
        let tsconfig = TsConfig::new(None, paths);

        let resolver = ImportResolver::new(known_files.clone(), Some(tsconfig.clone()));
        let resolved = resolver.resolve("src/index.ts", "@/components/Button");

        assert_eq!(
            resolved,
            ResolvedTarget::Internal("exact/Button.ts".to_string()),
            "Exact match '@/components/Button' must beat wildcards, got {resolved:?}"
        );
    }

    // Test C: Fallback array order is preserved.
    {
        let mut paths = HashMap::new();
        paths.insert(
            "@/lib/*".to_string(),
            vec!["vendor/*".to_string(), "fallback/*".to_string()],
        );

        let tsconfig = TsConfig {
            base_url: None,
            paths,
        };
        let tsconfig = TsConfig::new(None, paths);

        let resolver = ImportResolver::new(known_files.clone(), Some(tsconfig.clone()));

        // When both vendor/helper.ts and fallback/helper.ts exist:
        let resolved_both = resolver.resolve("src/index.ts", "@/lib/helper");
        assert_eq!(
            resolved_both,
            ResolvedTarget::Internal("vendor/helper.ts".to_string()),
            "First target in array must be prioritized when both exist"
        );

        // When vendor/helper.ts does NOT exist:
        let mut known_only_fallback = HashSet::new();
        known_only_fallback.insert("fallback/helper.ts".to_string());

        let resolver_fallback = ImportResolver::new(known_only_fallback, Some(tsconfig));
        let resolved_fallback = resolver_fallback.resolve("src/index.ts", "@/lib/helper");
        assert_eq!(
            resolved_fallback,
            ResolvedTarget::Internal("fallback/helper.ts".to_string()),
            "Second target in fallback array must resolve when first target does not exist"
        );
    }
}

/// Defect R3: baseUrl Interaction with paths
///
/// In TypeScript tsconfig.json, target paths in `paths` are resolved relative to `baseUrl`.
/// When `baseUrl` is `"./src"` or `"src"`, and `paths` is `{ "@/*": ["*"] }`:
/// Importing `@/utils` must resolve relative to `baseUrl`, resolving to `src/utils.ts`.
#[test]
fn test_defect_r3_base_url_interaction_with_paths() {
    let mut known_files = HashSet::new();
    known_files.insert("src/utils.ts".to_string());
    known_files.insert("packages/core-pkg/index.ts".to_string());

    // Case 1: baseUrl: "./src", paths: { "app/*": ["*"] }
    {
        let mut paths = HashMap::new();
        paths.insert("app/*".to_string(), vec!["*".to_string()]);

        let tsconfig = TsConfig {
            base_url: Some("./src".to_string()),
            paths,
        };
        let tsconfig = TsConfig::new(Some("./src".to_string()), paths);

        let resolver = ImportResolver::new(known_files.clone(), Some(tsconfig.clone()));
        let resolved = resolver.resolve("src/main.ts", "app/utils");

        assert_eq!(
            resolved,
            ResolvedTarget::Internal("src/utils.ts".to_string()),
            "Target path '*' under baseUrl './src' must resolve to 'src/utils.ts', got {resolved:?}"
        );
    }

    // Case 2: baseUrl: "src", paths: { "app/*": ["*"] } (without leading ./)
    {
        let mut paths = HashMap::new();
        paths.insert("app/*".to_string(), vec!["*".to_string()]);

        let tsconfig = TsConfig {
            base_url: Some("src".to_string()),
            paths,
        };
        let tsconfig = TsConfig::new(Some("src".to_string()), paths);

        let resolver = ImportResolver::new(known_files.clone(), Some(tsconfig.clone()));
        let resolved = resolver.resolve("src/main.ts", "app/utils");

        assert_eq!(
            resolved,
            ResolvedTarget::Internal("src/utils.ts".to_string()),
            "Target path '*' under baseUrl 'src' must resolve to 'src/utils.ts', got {resolved:?}"
        );
    }

    // Case 3: baseUrl: "packages", paths: { "core/*": ["core-pkg/*"] }
    {
        let mut paths = HashMap::new();
        paths.insert("core/*".to_string(), vec!["core-pkg/*".to_string()]);

        let tsconfig = TsConfig {
            base_url: Some("packages".to_string()),
            paths,
        };
        let tsconfig = TsConfig::new(Some("packages".to_string()), paths);

        let resolver = ImportResolver::new(known_files.clone(), Some(tsconfig.clone()));
        let resolved = resolver.resolve("packages/app/main.ts", "core/index");

        assert_eq!(
            resolved,
            ResolvedTarget::Internal("packages/core-pkg/index.ts".to_string()),
            "Target path 'core-pkg/*' under baseUrl 'packages' must resolve to 'packages/core-pkg/index.ts', got {resolved:?}"
        );
    }
}

/// Defect R5: Modern Extension Substitution
///
/// In modern TypeScript (Node16 / NodeNext / Bundler), imports often specify `.js`
/// extensions (e.g. `import './util.js'`) which correspond to TypeScript source files
/// `.ts` or `.tsx` on disk.
///
/// - `./util.js` -> resolves to `util.ts` or `util.tsx` when `util.js` does not exist on disk.
/// - `./foo.mjs` -> resolves to `foo.mts` when `foo.mjs` does not exist on disk.
/// - `./bar.cjs` -> resolves to `bar.cts` when `bar.cjs` does not exist on disk.
/// - Exact matches (`util.js` exists on disk) take precedence.
#[test]
fn test_defect_r5_modern_extension_substitution() {
    // 1. `./util.js` -> `util.ts`
    {
        let mut known_files = HashSet::new();
        known_files.insert("src/main.ts".to_string());
        known_files.insert("src/util.ts".to_string());

        let resolver = ImportResolver::new(known_files, None);
        let resolved = resolver.resolve("src/main.ts", "./util.js");

        assert_eq!(
            resolved,
            ResolvedTarget::Internal("src/util.ts".to_string()),
            "Importing './util.js' must substitute extension and resolve to 'src/util.ts' when util.js is absent, got {resolved:?}"
        );
    }

    // 2. `./util.js` -> `util.tsx`
    {
        let mut known_files = HashSet::new();
        known_files.insert("src/main.ts".to_string());
        known_files.insert("src/util.tsx".to_string());

        let resolver = ImportResolver::new(known_files, None);
        let resolved = resolver.resolve("src/main.ts", "./util.js");

        assert_eq!(
            resolved,
            ResolvedTarget::Internal("src/util.tsx".to_string()),
            "Importing './util.js' must substitute extension and resolve to 'src/util.tsx' when util.js is absent, got {resolved:?}"
        );
    }

    // 3. `./foo.mjs` -> `foo.mts`
    {
        let mut known_files = HashSet::new();
        known_files.insert("src/main.ts".to_string());
        known_files.insert("src/foo.mts".to_string());

        let resolver = ImportResolver::new(known_files, None);
        let resolved = resolver.resolve("src/main.ts", "./foo.mjs");

        assert_eq!(
            resolved,
            ResolvedTarget::Internal("src/foo.mts".to_string()),
            "Importing './foo.mjs' must substitute extension and resolve to 'src/foo.mts' when foo.mjs is absent, got {resolved:?}"
        );
    }

    // 4. `./bar.cjs` -> `bar.cts`
    {
        let mut known_files = HashSet::new();
        known_files.insert("src/main.ts".to_string());
        known_files.insert("src/bar.cts".to_string());

        let resolver = ImportResolver::new(known_files, None);
        let resolved = resolver.resolve("src/main.ts", "./bar.cjs");

        assert_eq!(
            resolved,
            ResolvedTarget::Internal("src/bar.cts".to_string()),
            "Importing './bar.cjs' must substitute extension and resolve to 'src/bar.cts' when bar.cjs is absent, got {resolved:?}"
        );
    }

    // 5. Exact match has priority when the .js file actually exists
    {
        let mut known_files = HashSet::new();
        known_files.insert("src/main.ts".to_string());
        known_files.insert("src/util.js".to_string());
        known_files.insert("src/util.ts".to_string());

        let resolver = ImportResolver::new(known_files, None);
        let resolved = resolver.resolve("src/main.ts", "./util.js");

        assert_eq!(
            resolved,
            ResolvedTarget::Internal("src/util.js".to_string()),
            "Exact match 'src/util.js' must have priority when it exists on disk, got {resolved:?}"
        );
    }
}

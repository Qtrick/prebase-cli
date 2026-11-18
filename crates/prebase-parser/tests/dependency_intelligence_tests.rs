use std::collections::{HashMap, HashSet};
use std::fs;

use prebase_core::model::{NodeAnalysisStatus, ResolutionStatus};
use prebase_parser::tsconfig::clean_jsonc;
use prebase_parser::{ImportResolver, RepositoryAnalyzer, ResolvedTarget, TsConfig};

// ============================================================================
// 1. Package Configuration Leakage
// ============================================================================

/// Defect: Package Configuration Leakage in Isolated Resolver
///
/// When a repository has multiple packages (e.g. `packages/a` and `packages/b`):
/// - `packages/a` has a tsconfig with alias `@a/*` -> `src/*` (or `packages/a/src/*`).
/// - `packages/b` has NO tsconfig.
///
/// An import from `packages/b/src/index.ts` importing `@a/utils` must NOT resolve
/// using `packages/a`'s tsconfig. It must never leak package A's alias mappings to package B.
/// Instead, it must be treated as `External` (scoped npm package) or `Unresolved`.
///
/// An import from `packages/a/src/index.ts` importing `@a/utils` DOES resolve to `packages/a/src/utils.ts`.
#[test]
fn test_package_configuration_leakage_isolated_resolver() {
    let mut known_files = HashSet::new();
    known_files.insert("packages/a/src/index.ts".to_string());
    known_files.insert("packages/a/src/utils.ts".to_string());
    known_files.insert("packages/b/src/index.ts".to_string());

    // Package A's tsconfig configured with config_dir "packages/a"
    let mut paths_a = HashMap::new();
    paths_a.insert("@a/*".to_string(), vec!["src/*".to_string()]);
    let mut cfg_a = TsConfig::new(None, paths_a);
    cfg_a.config_dir = "packages/a".to_string();

    let resolver = ImportResolver::with_configs(known_files, vec![cfg_a]);

    // 1. Package A resolving its own alias: MUST resolve to packages/a/src/utils.ts
    let res_a = resolver.resolve("packages/a/src/index.ts", "@a/utils");
    assert_eq!(
        res_a,
        ResolvedTarget::Internal("packages/a/src/utils.ts".to_string()),
        "Package A importing '@a/utils' must resolve to 'packages/a/src/utils.ts', got {res_a:?}"
    );

    // 2. Package B has no tsconfig. It must NOT leak Package A's tsconfig!
    // Even though packages/a/src/utils.ts exists in known_files, package B must NOT resolve to it.
    let res_b = resolver.resolve("packages/b/src/index.ts", "@a/utils");
    assert_ne!(
        res_b,
        ResolvedTarget::Internal("packages/a/src/utils.ts".to_string()),
        "Package B must NOT resolve '@a/utils' to Package A's internal file (configuration leakage defect)"
    );
    assert!(
        matches!(res_b, ResolvedTarget::External(_) | ResolvedTarget::Unresolved(_)),
        "Package B importing '@a/utils' without tsconfig must be External or Unresolved, got {res_b:?}"
    );

    // 3. Generic alias leak test: Package A maps `@/*` -> `src/*`
    let mut paths_generic = HashMap::new();
    paths_generic.insert("@/*".to_string(), vec!["src/*".to_string()]);
    let mut cfg_generic = TsConfig::new(None, paths_generic);
    cfg_generic.config_dir = "packages/a".to_string();

    let resolver_generic = ImportResolver::with_configs(
        {
            let mut k = HashSet::new();
            k.insert("packages/a/src/index.ts".to_string());
            k.insert("packages/a/src/helper.ts".to_string());
            k.insert("packages/b/src/index.ts".to_string());
            k
        },
        vec![cfg_generic],
    );

    let res_b_generic = resolver_generic.resolve("packages/b/src/index.ts", "@/helper");
    assert_ne!(
        res_b_generic,
        ResolvedTarget::Internal("packages/a/src/helper.ts".to_string()),
        "Package B must NOT resolve '@/helper' using Package A's tsconfig '@/*' mapping"
    );
}

/// Defect: Package Configuration Leakage in Real Repository Disk Fixture
///
/// In an end-to-end repository scan where `packages/a` has a `tsconfig.json` and `packages/b` does not,
/// analysis must not create an internal dependency edge from `packages/b/src/index.ts` to `packages/a/src/utils.ts`.
#[test]
fn test_package_configuration_leakage_e2e_disk_fixture() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();

    // Setup package A
    let pkg_a_dir = root.join("packages").join("a");
    let pkg_a_src = pkg_a_dir.join("src");
    fs::create_dir_all(&pkg_a_src).unwrap();
    fs::write(
        pkg_a_dir.join("tsconfig.json"),
        r#"{
            "compilerOptions": {
                "paths": {
                    "@a/*": ["src/*"]
                }
            }
        }"#,
    )
    .unwrap();
    fs::write(
        pkg_a_src.join("index.ts"),
        "import { utilA } from \"@a/utils\";\nexport const a = utilA;\n",
    )
    .unwrap();
    fs::write(pkg_a_src.join("utils.ts"), "export const utilA = 100;\n").unwrap();

    // Setup package B (NO tsconfig.json)
    let pkg_b_dir = root.join("packages").join("b");
    let pkg_b_src = pkg_b_dir.join("src");
    fs::create_dir_all(&pkg_b_src).unwrap();
    fs::write(
        pkg_b_src.join("index.ts"),
        "import { utilA } from \"@a/utils\";\nexport const b = utilA;\n",
    )
    .unwrap();

    let analyzer = RepositoryAnalyzer::default();
    let result = analyzer
        .analyze_path(root)
        .expect("Repository analysis must complete");

    let snapshot = result.snapshot;

    // 1. Package A's index.ts must have an internal dependency edge to packages/a/src/utils.ts
    let pkg_a_rel = snapshot.edges.iter().find(|r| {
        r.source_file_id == "packages/a/src/index.ts"
            && r.target_file_id == "packages/a/src/utils.ts"
    });
    assert!(
        pkg_a_rel.is_some(),
        "Package A must resolve '@a/utils' internally to 'packages/a/src/utils.ts'"
    );
    assert_eq!(
        pkg_a_rel.unwrap().resolution_status,
        ResolutionStatus::ResolvedInternal
    );

    // 2. Package B's index.ts must NOT have an internal dependency edge to packages/a/src/utils.ts
    let leaked_rel = snapshot.edges.iter().find(|r| {
        r.source_file_id == "packages/b/src/index.ts"
            && r.target_file_id == "packages/a/src/utils.ts"
    });
    assert!(
        leaked_rel.is_none(),
        "Package B must NOT have an edge to 'packages/a/src/utils.ts' - config from Package A was leaked!"
    );

    // 3. Package B's node in snapshot must have 0 direct internal dependencies
    let pkg_b_node = snapshot
        .nodes
        .iter()
        .find(|n| n.relative_path == "packages/b/src/index.ts")
        .expect("packages/b/src/index.ts node must exist");
    assert_eq!(
        pkg_b_node.direct_dependency_count, 0,
        "Package B's direct_dependency_count must be 0 (no internal dependencies), got {}",
        pkg_b_node.direct_dependency_count
    );
}

// ============================================================================
// 2. Alias Wildcard Matching with Suffixes
// ============================================================================

/// Defect: Alias Wildcard Matching with Suffixes and Fixed Targets
///
/// TypeScript tsconfig paths supports:
/// 1. Patterns with wildcards and suffixes: e.g. `@/*/types` -> `["src/*/types.ts"]` or `["src/*/types/index.ts"]`
/// 2. Subpath patterns: e.g. `#generated/*` -> `["generated/*"]`
/// 3. Fixed targets without wildcards: e.g. `@/common` -> `["src/common.ts"]`
/// 4. Wildcard patterns mapping to a fixed target: e.g. `@/env/*` -> `["src/env.ts"]`
#[test]
fn test_alias_wildcard_matching_with_suffixes() {
    let mut known_files = HashSet::new();
    known_files.insert("src/users/types.ts".to_string());
    known_files.insert("src/billing/types.ts".to_string());
    known_files.insert("src/orders/types/index.ts".to_string());
    known_files.insert("src/users/models.ts".to_string());
    known_files.insert("generated/schema.ts".to_string());
    known_files.insert("generated/proto/user.ts".to_string());
    known_files.insert("src/common.ts".to_string());
    known_files.insert("src/env.ts".to_string());

    let mut paths = HashMap::new();
    // Pattern with wildcard in the middle and suffix
    paths.insert(
        "@/*/types".to_string(),
        vec![
            "src/*/types.ts".to_string(),
            "src/*/types/index.ts".to_string(),
        ],
    );
    // Subpath pattern (# prefix)
    paths.insert("#generated/*".to_string(), vec!["generated/*".to_string()]);
    // Exact match target without wildcard
    paths.insert("@/common".to_string(), vec!["src/common.ts".to_string()]);
    // Wildcard pattern mapping to fixed target
    paths.insert("@/env/*".to_string(), vec!["src/env.ts".to_string()]);

    let tsconfig = TsConfig::new(None, paths);
    let resolver = ImportResolver::new(known_files, Some(tsconfig));

    // Case 1: Pattern with suffix: `@/users/types` matches `@/*/types` with wildcard "users"
    // Target `src/*/types.ts` substitutes "users" -> `src/users/types.ts`
    let res_users_types = resolver.resolve("src/index.ts", "@/users/types");
    assert_eq!(
        res_users_types,
        ResolvedTarget::Internal("src/users/types.ts".to_string()),
        "Pattern '@/*/types' must resolve '@/users/types' to 'src/users/types.ts', got {res_users_types:?}"
    );

    // Case 2: Pattern with suffix: `@/billing/types`
    let res_billing_types = resolver.resolve("src/index.ts", "@/billing/types");
    assert_eq!(
        res_billing_types,
        ResolvedTarget::Internal("src/billing/types.ts".to_string()),
        "Pattern '@/*/types' must resolve '@/billing/types' to 'src/billing/types.ts', got {res_billing_types:?}"
    );

    // Case 3: Pattern with suffix where first target misses but second target (`src/*/types/index.ts`) hits
    let res_orders_types = resolver.resolve("src/index.ts", "@/orders/types");
    assert_eq!(
        res_orders_types,
        ResolvedTarget::Internal("src/orders/types/index.ts".to_string()),
        "Pattern '@/*/types' fallback target 'src/*/types/index.ts' must resolve for 'orders', got {res_orders_types:?}"
    );

    // Case 4: Suffix mismatch: `@/users/models` does NOT end with `/types`
    let res_users_models = resolver.resolve("src/index.ts", "@/users/models");
    assert_ne!(
        res_users_models,
        ResolvedTarget::Internal("src/users/types.ts".to_string()),
        "'@/users/models' must not match '@/*/types'"
    );

    // Case 5: Subpath pattern `#generated/*`
    let res_gen_schema = resolver.resolve("src/index.ts", "#generated/schema");
    assert_eq!(
        res_gen_schema,
        ResolvedTarget::Internal("generated/schema.ts".to_string()),
        "Subpath pattern '#generated/*' must resolve '#generated/schema' to 'generated/schema.ts', got {res_gen_schema:?}"
    );

    let res_gen_proto = resolver.resolve("src/index.ts", "#generated/proto/user");
    assert_eq!(
        res_gen_proto,
        ResolvedTarget::Internal("generated/proto/user.ts".to_string()),
        "Subpath pattern '#generated/*' must resolve '#generated/proto/user' to 'generated/proto/user.ts', got {res_gen_proto:?}"
    );

    // Case 6: Exact match target without wildcard `@/common`
    let res_common = resolver.resolve("src/index.ts", "@/common");
    assert_eq!(
        res_common,
        ResolvedTarget::Internal("src/common.ts".to_string()),
        "Exact target '@/common' must resolve to 'src/common.ts', got {res_common:?}"
    );

    // Case 7: Wildcard pattern mapping to fixed target `@/env/*`
    let res_env_prod = resolver.resolve("src/index.ts", "@/env/production");
    assert_eq!(
        res_env_prod,
        ResolvedTarget::Internal("src/env.ts".to_string()),
        "Wildcard mapping to fixed target '@/env/*' must resolve to 'src/env.ts', got {res_env_prod:?}"
    );

    let res_env_dev = resolver.resolve("src/index.ts", "@/env/development");
    assert_eq!(
        res_env_dev,
        ResolvedTarget::Internal("src/env.ts".to_string()),
        "Wildcard mapping to fixed target '@/env/*' must resolve to 'src/env.ts', got {res_env_dev:?}"
    );
}

// ============================================================================
// 3. Precedence and Non-Fallthrough in Paths
// ============================================================================

/// Defect: Fallthrough to Less-Specific Pattern when Best-Matching Pattern Misses
///
/// TypeScript Module Resolution Specification:
/// When resolving a path mapping, the single best matching pattern (highest specificity)
/// is selected. TypeScript will ONLY attempt to resolve using the targets specified
/// by that chosen pattern. If none of those targets resolve to an existing file,
/// path mapping FAILS for this configuration. It must NOT fall through to a less-specific pattern!
///
/// Given:
///   `@/components/*` -> `["special/components/*"]`
///   `@/*`            -> `["src/*"]`
///
/// Import: `@/components/Missing`
/// If `special/components/Missing.ts` does NOT exist, but `src/components/Missing.ts` DOES exist:
/// - Best matching pattern is `@/components/*`.
/// - Its target `special/components/Missing.ts` does not exist.
/// - Resolution MUST NOT fall through to `@/*` -> `src/components/Missing.ts`.
/// - Result MUST be `Unresolved`!
#[test]
fn test_precedence_and_non_fallthrough_in_paths() {
    let mut known_files = HashSet::new();
    // Exists under the broader `@/*` path, but NOT under `@/components/*`
    known_files.insert("src/components/Missing.ts".to_string());
    // Exists under both
    known_files.insert("special/components/Normal.ts".to_string());
    known_files.insert("src/components/Normal.ts".to_string());
    // Exists only under `@/*`
    known_files.insert("src/utils/Helper.ts".to_string());

    let mut paths = HashMap::new();
    paths.insert(
        "@/components/*".to_string(),
        vec!["special/components/*".to_string()],
    );
    paths.insert("@/*".to_string(), vec!["src/*".to_string()]);

    let tsconfig = TsConfig::new(None, paths);
    let resolver = ImportResolver::new(known_files, Some(tsconfig));

    // 1. Baseline positive check: `@/components/Normal` resolves via specific pattern
    let res_normal = resolver.resolve("src/index.ts", "@/components/Normal");
    assert_eq!(
        res_normal,
        ResolvedTarget::Internal("special/components/Normal.ts".to_string()),
        "Normal component must resolve to specific pattern target 'special/components/Normal.ts'"
    );

    // 2. Baseline positive check: `@/utils/Helper` matches only broader pattern `@/*`
    let res_helper = resolver.resolve("src/index.ts", "@/utils/Helper");
    assert_eq!(
        res_helper,
        ResolvedTarget::Internal("src/utils/Helper.ts".to_string()),
        "Helper must resolve via '@/*' to 'src/utils/Helper.ts'"
    );

    // 3. DEFECT TEST: Non-fallthrough!
    // `@/components/Missing` matches `@/components/*`.
    // Target `special/components/Missing` is missing on disk.
    // Resolution must NOT fall through to `@/*` even though `src/components/Missing.ts` exists!
    let res_missing = resolver.resolve("src/index.ts", "@/components/Missing");
    assert_ne!(
        res_missing,
        ResolvedTarget::Internal("src/components/Missing.ts".to_string()),
        "Defect: Resolution fell through from best-matching pattern '@/components/*' to broader pattern '@/*'"
    );
    assert!(
        matches!(res_missing, ResolvedTarget::Unresolved(_)),
        "When best-matching pattern's targets miss, result must be Unresolved without fallthrough, got {res_missing:?}"
    );

    // 4. Multi-target non-fallthrough:
    // If specific pattern has 2 targets, and BOTH miss, it must still NOT fall through to `@/*`.
    let mut multi_paths = HashMap::new();
    multi_paths.insert(
        "@/ui/*".to_string(),
        vec!["custom/ui/*".to_string(), "theme/ui/*".to_string()],
    );
    multi_paths.insert("@/*".to_string(), vec!["src/*".to_string()]);

    let mut multi_known = HashSet::new();
    multi_known.insert("src/ui/Dialog.ts".to_string());

    let multi_resolver = ImportResolver::new(multi_known, Some(TsConfig::new(None, multi_paths)));
    let res_dialog = multi_resolver.resolve("src/index.ts", "@/ui/Dialog");
    assert_ne!(
        res_dialog,
        ResolvedTarget::Internal("src/ui/Dialog.ts".to_string()),
        "Defect: Resolution fell through multi-target pattern '@/ui/*' to broader pattern '@/*'"
    );
    assert!(
        matches!(res_dialog, ResolvedTarget::Unresolved(_)),
        "When all targets of best-matching pattern fail, result must be Unresolved, got {res_dialog:?}"
    );
}

// ============================================================================
// 4. Extension Substitution and No-Double-Appending
// ============================================================================

/// Defect: Double-Appending Extensions vs Substitution
///
/// In modern TypeScript (Node16 / NodeNext / Bundler), imports often specify `.js`
/// or other runtime extensions (e.g. `import './util.js'`).
/// TypeScript substitutes `.js` with `.ts`, `.tsx`, or `.d.ts`.
/// It NEVER double-appends an extension to an existing extension (e.g. `util.js.ts`)!
///
/// If a repository contains `src/util.js.ts` (e.g. from an artifact or backup) and
/// `src/util.ts` does NOT exist:
/// Importing `./util.js` must NOT resolve to `src/util.js.ts`!
#[test]
fn test_extension_substitution_no_double_appending() {
    // 1. `./util.js` must NOT resolve to `src/util.js.ts`
    {
        let mut known_files = HashSet::new();
        known_files.insert("src/main.ts".to_string());
        known_files.insert("src/util.js.ts".to_string());
        // Note: src/util.js, src/util.ts, src/util.tsx, src/util.d.ts do NOT exist!

        let resolver = ImportResolver::new(known_files, None);
        let resolved = resolver.resolve("src/main.ts", "./util.js");

        assert_ne!(
            resolved,
            ResolvedTarget::Internal("src/util.js.ts".to_string()),
            "Defect: Importing './util.js' double-appended '.ts' to resolve to 'src/util.js.ts'!"
        );
        assert!(
            matches!(resolved, ResolvedTarget::Unresolved(_)),
            "Importing './util.js' when only 'src/util.js.ts' exists must be Unresolved, got {resolved:?}"
        );
    }

    // 2. `./component.jsx` must NOT resolve to `src/component.jsx.tsx`
    {
        let mut known_files = HashSet::new();
        known_files.insert("src/main.ts".to_string());
        known_files.insert("src/component.jsx.tsx".to_string());

        let resolver = ImportResolver::new(known_files, None);
        let resolved = resolver.resolve("src/main.ts", "./component.jsx");

        assert_ne!(
            resolved,
            ResolvedTarget::Internal("src/component.jsx.tsx".to_string()),
            "Defect: Importing './component.jsx' double-appended '.tsx' to resolve to 'src/component.jsx.tsx'!"
        );
        assert!(
            matches!(resolved, ResolvedTarget::Unresolved(_)),
            "Importing './component.jsx' when only 'src/component.jsx.tsx' exists must be Unresolved, got {resolved:?}"
        );
    }

    // 3. `./foo.mjs` must NOT resolve to `src/foo.mjs.mts`
    {
        let mut known_files = HashSet::new();
        known_files.insert("src/main.ts".to_string());
        known_files.insert("src/foo.mjs.mts".to_string());

        let resolver = ImportResolver::new(known_files, None);
        let resolved = resolver.resolve("src/main.ts", "./foo.mjs");

        assert_ne!(
            resolved,
            ResolvedTarget::Internal("src/foo.mjs.mts".to_string()),
            "Defect: Importing './foo.mjs' double-appended '.mts' to resolve to 'src/foo.mjs.mts'!"
        );
        assert!(
            matches!(resolved, ResolvedTarget::Unresolved(_)),
            "Importing './foo.mjs' when only 'src/foo.mjs.mts' exists must be Unresolved, got {resolved:?}"
        );
    }

    // 4. `./bar.cjs` must NOT resolve to `src/bar.cjs.cts`
    {
        let mut known_files = HashSet::new();
        known_files.insert("src/main.ts".to_string());
        known_files.insert("src/bar.cjs.cts".to_string());

        let resolver = ImportResolver::new(known_files, None);
        let resolved = resolver.resolve("src/main.ts", "./bar.cjs");

        assert_ne!(
            resolved,
            ResolvedTarget::Internal("src/bar.cjs.cts".to_string()),
            "Defect: Importing './bar.cjs' double-appended '.cts' to resolve to 'src/bar.cjs.cts'!"
        );
        assert!(
            matches!(resolved, ResolvedTarget::Unresolved(_)),
            "Importing './bar.cjs' when only 'src/bar.cjs.cts' exists must be Unresolved, got {resolved:?}"
        );
    }
}

/// Comprehensive Extension Substitution Matrix
///
/// Verifies proper substitution for:
/// - `.js`  -> `.ts`, `.tsx`, `.d.ts`
/// - `.jsx` -> `.tsx`, `.ts`
/// - `.mjs` -> `.mts`, `.d.mts`
/// - `.cjs` -> `.cts`, `.d.cts`
/// - Exact file on disk takes priority over substitution.
#[test]
fn test_extension_substitution_matrix() {
    let mut known_files = HashSet::new();
    known_files.insert("src/main.ts".to_string());
    known_files.insert("src/a.ts".to_string());
    known_files.insert("src/b.tsx".to_string());
    known_files.insert("src/c.d.ts".to_string());
    known_files.insert("src/d.tsx".to_string());
    known_files.insert("src/e.mts".to_string());
    known_files.insert("src/f.d.mts".to_string());
    known_files.insert("src/g.cts".to_string());
    known_files.insert("src/h.d.cts".to_string());
    known_files.insert("src/exact.js".to_string());
    known_files.insert("src/exact.ts".to_string());

    let resolver = ImportResolver::new(known_files, None);

    // .js -> .ts
    assert_eq!(
        resolver.resolve("src/main.ts", "./a.js"),
        ResolvedTarget::Internal("src/a.ts".to_string())
    );

    // .js -> .tsx
    assert_eq!(
        resolver.resolve("src/main.ts", "./b.js"),
        ResolvedTarget::Internal("src/b.tsx".to_string())
    );

    // .js -> .d.ts
    assert_eq!(
        resolver.resolve("src/main.ts", "./c.js"),
        ResolvedTarget::Internal("src/c.d.ts".to_string())
    );

    // .jsx -> .tsx
    assert_eq!(
        resolver.resolve("src/main.ts", "./d.jsx"),
        ResolvedTarget::Internal("src/d.tsx".to_string())
    );

    // .mjs -> .mts
    assert_eq!(
        resolver.resolve("src/main.ts", "./e.mjs"),
        ResolvedTarget::Internal("src/e.mts".to_string())
    );

    // .mjs -> .d.mts
    assert_eq!(
        resolver.resolve("src/main.ts", "./f.mjs"),
        ResolvedTarget::Internal("src/f.d.mts".to_string())
    );

    // .cjs -> .cts
    assert_eq!(
        resolver.resolve("src/main.ts", "./g.cjs"),
        ResolvedTarget::Internal("src/g.cts".to_string())
    );

    // .cjs -> .d.cts
    assert_eq!(
        resolver.resolve("src/main.ts", "./h.cjs"),
        ResolvedTarget::Internal("src/h.d.cts".to_string())
    );

    // Exact match has priority over substitution
    assert_eq!(
        resolver.resolve("src/main.ts", "./exact.js"),
        ResolvedTarget::Internal("src/exact.js".to_string())
    );
}

// ============================================================================
// 5. JSONC Correctness
// ============================================================================

/// Defect: JSONC UTF-8 BOM Handling
///
/// Files saved with a UTF-8 Byte Order Mark (`\u{feff}`) must be handled transparently.
/// Standard JSON parsers fail if a BOM precedes the opening `{`.
/// `TsConfig::parse_jsonc` must strip the BOM and parse successfully.
#[test]
fn test_jsonc_utf8_bom_handling() {
    // 1. Simple JSON with UTF-8 BOM
    let bom_json = "\u{feff}{\"compilerOptions\": {\"baseUrl\": \"./src\"}}";
    let parsed = TsConfig::parse_jsonc(bom_json, "");
    assert!(
        parsed.is_some(),
        "JSONC with UTF-8 BOM must parse successfully, got None"
    );
    assert_eq!(
        parsed.unwrap().base_url.as_deref(),
        Some("./src"),
        "Parsed baseUrl must match"
    );

    // 2. BOM combined with comments and trailing commas
    let bom_complex = "\u{feff}{\n  // Configuration\n  \"compilerOptions\": {\n    \"baseUrl\": \"./src\",\n  },\n}";
    let parsed_complex = TsConfig::parse_jsonc(bom_complex, "");
    assert!(
        parsed_complex.is_some(),
        "JSONC with UTF-8 BOM, comments, and trailing commas must parse successfully"
    );
    assert_eq!(parsed_complex.unwrap().base_url.as_deref(), Some("./src"));
}

/// Defect: Block Comments Between Tokens Must Not Concatenate Tokens
///
/// In standard ECMAScript / C comment stripping, block comments act as whitespace.
/// When comment syntax `/* comment */` separates two tokens without other whitespace:
/// `tokenA/* comment */tokenB` must be replaced by whitespace (e.g. `tokenA tokenB`),
/// NOT concatenated into `tokenAtokenB`.
#[test]
fn test_jsonc_block_comments_do_not_concatenate_tokens() {
    // 1. Tokens separated only by block comments must not merge
    let input = "tokenA/* comment */tokenB";
    let cleaned = clean_jsonc(input);
    assert_ne!(
        cleaned, "tokenAtokenB",
        "Defect: Block comment removal concatenated adjacent tokens into 'tokenAtokenB'"
    );
    assert!(
        cleaned == "tokenA tokenB"
            || cleaned.split_whitespace().collect::<Vec<_>>() == vec!["tokenA", "tokenB"],
        "Cleaned output must separate tokens with whitespace, got '{cleaned}'"
    );

    // 2. Boolean tokens separated by block comment
    let bool_input = "true/* comment */false";
    let cleaned_bool = clean_jsonc(bool_input);
    assert_ne!(
        cleaned_bool, "truefalse",
        "Defect: 'true/* comment */false' was concatenated into 'truefalse'"
    );

    // 3. Number tokens separated by block comment
    let num_input = "1/* comment */2";
    let cleaned_num = clean_jsonc(num_input);
    assert_ne!(
        cleaned_num, "12",
        "Defect: '1/* comment */2' was concatenated into '12'"
    );

    // 4. JSON property colon without whitespace around comment
    let json_input = "{\"compilerOptions\"/* comment */:/* comment */{\"baseUrl\":\"./src\"}}";
    let parsed = TsConfig::parse_jsonc(json_input, "");
    assert!(
        parsed.is_some(),
        "JSON with block comments between key, colon, and value must parse successfully"
    );

    // 5. Multi-line block comments must also separate tokens
    let multiline_input = "tokenA/*\nline1\nline2\n*/tokenB";
    let cleaned_multiline = clean_jsonc(multiline_input);
    assert_ne!(
        cleaned_multiline, "tokenAtokenB",
        "Defect: Multi-line block comment concatenated tokens into 'tokenAtokenB'"
    );
}

/// Verification: Comments Inside String Literals Must Be Preserved
///
/// Characters looking like comments (e.g. `//` in URLs or `/* ... */` in strings)
/// inside double quotes must be preserved as literal string contents.
#[test]
fn test_jsonc_comments_inside_strings() {
    let json_with_strings = r#"{
        "compilerOptions": {
            "baseUrl": "https://example.com/api//v1",
            "paths": {
                "@/*": ["/* not a comment */", "nested \"// escaped //\" inside"]
            }
        }
    }"#;

    let parsed = TsConfig::parse_jsonc(json_with_strings, "");
    assert!(
        parsed.is_some(),
        "JSON containing URLs and comment markers inside strings must parse successfully"
    );
    let cfg = parsed.unwrap();
    assert_eq!(
        cfg.base_url.as_deref(),
        Some("https://example.com/api//v1"),
        "URL with '//' in string must be preserved intact"
    );
    assert_eq!(cfg.paths.len(), 1);
    assert_eq!(cfg.paths[0].0, "@/*");
    assert_eq!(
        cfg.paths[0].1,
        vec![
            "/* not a comment */".to_string(),
            "nested \"// escaped //\" inside".to_string()
        ],
        "String contents containing comment syntax must be preserved intact"
    );
}

/// Verification: Trailing Commas in Objects and Arrays
///
/// Trailing commas before `}` and `]` must be tolerated in all positions,
/// including nested arrays, nested objects, and when followed by whitespace or newlines.
#[test]
fn test_jsonc_trailing_commas_in_objects_and_arrays() {
    let json_trailing = r#"{
        "compilerOptions": {
            "baseUrl": "./",
            "paths": {
                "@components/*": [
                    "src/components/*",
                    "fallback/components/*",
                ],
                "@utils/*": [
                    "src/utils/*",
                ],
            },
        },
    }"#;

    let parsed = TsConfig::parse_jsonc(json_trailing, "");
    assert!(
        parsed.is_some(),
        "JSON with multiple trailing commas in objects and arrays must parse successfully"
    );
    let cfg = parsed.unwrap();
    assert_eq!(cfg.base_url.as_deref(), Some("./"));
    assert_eq!(cfg.paths.len(), 2);
}

// ============================================================================
// 6. Local Bounded extends Support and Cycle Prevention
// ============================================================================

#[test]
fn test_tsconfig_local_bounded_extends() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();

    // Base config in root
    let base_json = r#"{
        "compilerOptions": {
            "baseUrl": "./",
            "paths": {
                "@shared/*": ["packages/shared/src/*"]
            }
        }
    }"#;
    fs::write(root.join("tsconfig.base.json"), base_json).unwrap();

    // Child config in packages/app/tsconfig.json extending ../../tsconfig.base.json
    fs::create_dir_all(root.join("packages/app")).unwrap();
    let child_json = r#"{
        "extends": "../../tsconfig.base.json",
        "compilerOptions": {
            "baseUrl": "./src"
        }
    }"#;
    fs::write(root.join("packages/app/tsconfig.json"), child_json).unwrap();

    let loaded = TsConfig::load_from_file_in_repo(root, "packages/app/tsconfig.json");
    assert!(
        loaded.is_some(),
        "Child config with local extends must load"
    );
    let cfg = loaded.unwrap();
    // Inherited paths from base
    assert_eq!(cfg.paths.len(), 1);
    assert_eq!(cfg.paths[0].0, "@shared/*");
    // Child overridden baseUrl
    assert_eq!(cfg.base_url.as_deref(), Some("./src"));
    assert_eq!(cfg.config_dir, "packages/app");
}

#[test]
fn test_tsconfig_multi_extends_array_inheritance() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();

    // Base config 1: provides baseUrl
    let base1_json = r#"{
        "compilerOptions": {
            "baseUrl": "./base"
        }
    }"#;
    fs::write(root.join("tsconfig.base1.json"), base1_json).unwrap();

    // Base config 2: provides paths and overrides baseUrl
    let base2_json = r#"{
        "compilerOptions": {
            "baseUrl": "./base2",
            "paths": {
                "@components/*": ["src/components/*"]
            }
        }
    }"#;
    fs::write(root.join("tsconfig.base2.json"), base2_json).unwrap();

    // Child config with multi-extends array
    let child_json = r#"{
        "extends": ["./tsconfig.base1.json", "./tsconfig.base2.json"]
    }"#;
    fs::write(root.join("tsconfig.json"), child_json).unwrap();

    let loaded = TsConfig::load_from_file_in_repo(root, "tsconfig.json");
    assert!(
        loaded.is_some(),
        "Multi-extends config must load successfully"
    );
    let cfg = loaded.unwrap();

    // base2 overrode base1's baseUrl
    assert_eq!(cfg.base_url.as_deref(), Some("./base2"));
    // paths inherited from base2
    assert_eq!(cfg.paths.len(), 1);
    assert_eq!(cfg.paths[0].0, "@components/*");
}

#[test]
fn test_tsconfig_extends_cycle_prevention() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();

    // Config A extends B, Config B extends A
    let json_a = r#"{ "extends": "./tsconfig.b.json" }"#;
    let json_b = r#"{ "extends": "./tsconfig.a.json" }"#;
    fs::write(root.join("tsconfig.a.json"), json_a).unwrap();
    fs::write(root.join("tsconfig.b.json"), json_b).unwrap();

    // Must not hang or stack overflow; must gracefully return None
    let loaded = TsConfig::load_from_file_in_repo(root, "tsconfig.a.json");
    assert!(
        loaded.is_none(),
        "Circular extends must be detected and return None"
    );
}

// ============================================================================
// 7. Advanced Dependency Intelligence & Diagnostic Rigor
// ============================================================================

/// Defect 1: Root tsconfig extends inheritance via load_from_dir
///
/// When root `tsconfig.json` has `"extends": "./tsconfig.base.json"`, loading via
/// `TsConfig::load_from_dir` must properly resolve the local relative `extends` and
/// inherit `baseUrl` and `paths` from the base configuration.
#[test]
fn test_root_tsconfig_extends_inheritance() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();

    let base_json = r#"{
        "compilerOptions": {
            "baseUrl": "./src",
            "paths": {
                "@components/*": ["components/*"]
            }
        }
    }"#;
    fs::write(root.join("tsconfig.base.json"), base_json).unwrap();

    let root_json = r#"{
        "extends": "./tsconfig.base.json"
    }"#;
    fs::write(root.join("tsconfig.json"), root_json).unwrap();

    let loaded = TsConfig::load_from_dir(root).expect("Root tsconfig with extends must load");
    assert_eq!(
        loaded.base_url.as_deref(),
        Some("./src"),
        "Root tsconfig must inherit baseUrl from './tsconfig.base.json', got {:?}",
        loaded.base_url
    );
    assert_eq!(
        loaded.paths.len(),
        1,
        "Root tsconfig must inherit paths from './tsconfig.base.json', got {:?}",
        loaded.paths
    );
    assert_eq!(loaded.paths[0].0, "@components/*");
    assert_eq!(loaded.paths[0].1, vec!["components/*".to_string()]);
}

/// Defect 2: Explicit empty paths ("paths": {}) in child tsconfig clears inheritance
///
/// In TypeScript tsconfig inheritance, specifying an explicit `"paths": {}` in a child
/// config intentionally overrides and clears the parent config's path mappings.
/// It must NOT inherit parent paths when child explicitly specifies an empty object.
#[test]
fn test_child_tsconfig_explicit_empty_paths_clears_inheritance() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();

    let base_json = r#"{
        "compilerOptions": {
            "paths": {
                "@/*": ["src/*"]
            }
        }
    }"#;
    fs::write(root.join("tsconfig.json"), base_json).unwrap();

    let app_dir = root.join("packages/app");
    fs::create_dir_all(&app_dir).unwrap();
    let child_json = r#"{
        "extends": "../../tsconfig.json",
        "compilerOptions": {
            "paths": {}
        }
    }"#;
    fs::write(app_dir.join("tsconfig.json"), child_json).unwrap();

    let loaded = TsConfig::load_from_file_in_repo(root, "packages/app/tsconfig.json")
        .expect("Child tsconfig must load");

    assert!(
        loaded.paths.is_empty(),
        "Child config with explicit empty '\"paths\": {{}}' must clear paths inheritance, got {:?}",
        loaded.paths
    );
}

/// Defect 3: Relative path anchor preservation when inheriting baseUrl
///
/// In TypeScript, `baseUrl` is resolved relative to the directory containing the tsconfig
/// file where `baseUrl` was declared.
/// If `tsconfig.base.json` in root defines `"baseUrl": "./src"`, and a child config in
/// `packages/app/tsconfig.json` extends it without defining `baseUrl`, resolving an import
/// alias in `packages/app` must anchor `baseUrl` to the root `src`, NOT `packages/app/src`!
#[test]
fn test_tsconfig_relative_path_anchor_preservation() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();

    let base_json = r#"{
        "compilerOptions": {
            "baseUrl": "./src",
            "paths": {
                "@shared/*": ["shared/*"]
            }
        }
    }"#;
    fs::write(root.join("tsconfig.base.json"), base_json).unwrap();

    // Root src/shared/util.ts exists
    let root_shared_dir = root.join("src/shared");
    fs::create_dir_all(&root_shared_dir).unwrap();
    fs::write(root_shared_dir.join("util.ts"), "export const util = 1;\n").unwrap();

    // Child packages/app/tsconfig.json extends ../../tsconfig.base.json without defining baseUrl
    let app_dir = root.join("packages/app");
    let app_src_dir = app_dir.join("src");
    fs::create_dir_all(&app_src_dir).unwrap();
    let child_json = r#"{
        "extends": "../../tsconfig.base.json"
    }"#;
    fs::write(app_dir.join("tsconfig.json"), child_json).unwrap();
    fs::write(
        app_src_dir.join("index.ts"),
        "import { util } from \"@shared/util\";\n",
    )
    .unwrap();

    // Notice: packages/app/src/shared/util.ts does NOT exist on disk!

    let mut known_files = HashSet::new();
    known_files.insert("src/shared/util.ts".to_string());
    known_files.insert("packages/app/src/index.ts".to_string());

    let child_cfg = TsConfig::load_from_file_in_repo(root, "packages/app/tsconfig.json")
        .expect("Child tsconfig must load");

    let resolver = ImportResolver::with_configs(known_files, vec![child_cfg]);
    let res = resolver.resolve("packages/app/src/index.ts", "@shared/util");

    assert_eq!(
        res,
        ResolvedTarget::Internal("src/shared/util.ts".to_string()),
        "Child config inheriting baseUrl './src' from root must anchor to root 'src/shared/util.ts', got {res:?}"
    );
}

/// Defect 4: Workspace package missing dist target must not resolve as Internal
///
/// When `package.json` specifies `"main": "dist/index.js"`, but `dist/index.js` does NOT
/// exist on disk/known_files:
/// - Resolving `"@test/core"` must NOT return `ResolvedTarget::Internal("packages/core/dist/index.js")`.
/// - It should resolve to grounded source (`"packages/core/src/index.ts"`) if available or return `Unresolved`.
/// - The analyzer must NOT emit an internal edge pointing to a non-existent file!
#[test]
fn test_workspace_package_missing_dist_target_not_internal() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();

    let core_pkg_dir = root.join("packages/core");
    let core_src_dir = core_pkg_dir.join("src");
    fs::create_dir_all(&core_src_dir).unwrap();
    fs::write(
        core_pkg_dir.join("package.json"),
        r#"{
            "name": "@test/core",
            "main": "dist/index.js"
        }"#,
    )
    .unwrap();
    fs::write(core_src_dir.join("index.ts"), "export const core = 1;\n").unwrap();

    let app_pkg_dir = root.join("packages/app");
    let app_src_dir = app_pkg_dir.join("src");
    fs::create_dir_all(&app_src_dir).unwrap();
    fs::write(
        app_src_dir.join("index.ts"),
        "import { core } from \"@test/core\";\nconsole.log(core);\n",
    )
    .unwrap();

    let analyzer = RepositoryAnalyzer::default();
    let res = analyzer.analyze_path(root).expect("Analysis must succeed");
    let snapshot = res.snapshot;

    // Must NOT have an internal edge to the non-existent dist target
    let dist_edge = snapshot.edges.iter().find(|e| {
        e.source_file_id == "packages/app/src/index.ts"
            && e.target_file_id == "packages/core/dist/index.js"
    });
    assert!(
        dist_edge.is_none(),
        "Must NOT create an internal edge to non-existent 'packages/core/dist/index.js'"
    );

    // If resolver is queried directly, it must not resolve to missing dist
    let mut known_files = HashSet::new();
    known_files.insert("packages/core/src/index.ts".to_string());
    known_files.insert("packages/app/src/index.ts".to_string());

    let mut workspace_packages = HashMap::new();
    workspace_packages.insert(
        "@test/core".to_string(),
        "packages/core/dist/index.js".to_string(),
    );

    let resolver =
        ImportResolver::with_configs_and_packages(known_files, Vec::new(), workspace_packages);
    let resolved = resolver.resolve("packages/app/src/index.ts", "@test/core");

    assert_ne!(
        resolved,
        ResolvedTarget::Internal("packages/core/dist/index.js".to_string()),
        "Resolving '@test/core' when dist/index.js is absent must NOT return Internal('packages/core/dist/index.js')"
    );
}

/// Defect 5: Missing internal target records diagnostic issue and is not dropped silently
///
/// When analyzing a file that imports an internal target that is dropped or missing from
/// known_files, the analyzer must record an issue (e.g. UnresolvedInternalTarget or MissingInternalTarget)
/// in `snapshot.issues` rather than silently dropping the edge with zero issues.
#[test]
fn test_missing_internal_target_records_issue_and_does_not_drop_silently() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();

    let pkg_dir = root.join("packages/pkg");
    fs::create_dir_all(&pkg_dir).unwrap();
    fs::write(
        pkg_dir.join("package.json"),
        r#"{
            "name": "@test/pkg",
            "main": "dist/index.js"
        }"#,
    )
    .unwrap();

    let app_dir = root.join("packages/app/src");
    fs::create_dir_all(&app_dir).unwrap();
    fs::write(
        app_dir.join("index.ts"),
        "import { something } from \"@test/pkg\";\nexport const a = something;\n",
    )
    .unwrap();

    let analyzer = RepositoryAnalyzer::default();
    let res = analyzer.analyze_path(root).expect("Analysis must succeed");
    let snapshot = res.snapshot;

    let missing_issue = snapshot.issues.iter().find(|i| {
        i.issue_kind == "UnresolvedInternalTarget" || i.issue_kind == "MissingInternalTarget"
    });
    assert!(
        missing_issue.is_some(),
        "Snapshot must record UnresolvedInternalTarget or MissingInternalTarget issue when internal target is missing from known files, found issues: {:?}",
        snapshot.issues
    );
}

/// Defect 6: Partially analyzed node status and SyntaxWarning issue
///
/// When a source file contains syntax errors (`has_syntax_errors`), the node's
/// `analysis_status` must be set to `NodeAnalysisStatus::PartiallyAnalyzed` (not `Analyzed`),
/// and an issue with `issue_kind: "SyntaxWarning"` must be recorded.
#[test]
fn test_partially_analyzed_node_status() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();

    let src_dir = root.join("src");
    fs::create_dir_all(&src_dir).unwrap();

    fs::write(src_dir.join("valid.ts"), "export const x = 1;\n").unwrap();
    fs::write(
        src_dir.join("broken.ts"),
        "import { x } from './valid';\nconst broken = {{{ ;\nexport const y = x;\n",
    )
    .unwrap();

    let analyzer = RepositoryAnalyzer::default();
    let res = analyzer.analyze_path(root).expect("Analysis must succeed");
    let snapshot = res.snapshot;

    let valid_node = snapshot
        .nodes
        .iter()
        .find(|n| n.relative_path == "src/valid.ts")
        .expect("valid.ts node must exist");
    assert_eq!(valid_node.analysis_status, NodeAnalysisStatus::Analyzed);

    let broken_node = snapshot
        .nodes
        .iter()
        .find(|n| n.relative_path == "src/broken.ts")
        .expect("broken.ts node must exist");
    assert_eq!(
        broken_node.analysis_status,
        NodeAnalysisStatus::PartiallyAnalyzed,
        "File with syntax errors must have PartiallyAnalyzed status, got {:?}",
        broken_node.analysis_status
    );

    let syntax_warning = snapshot
        .issues
        .iter()
        .find(|i| i.file_path == "src/broken.ts" && i.issue_kind == "SyntaxWarning");
    assert!(
        syntax_warning.is_some(),
        "Expected SyntaxWarning issue for 'src/broken.ts', found: {:?}",
        snapshot.issues
    );
}

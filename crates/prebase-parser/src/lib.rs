pub mod analyzer;
pub mod ast;
pub mod resolver;
pub mod tsconfig;

pub use analyzer::{AnalysisResult, RepositoryAnalyzer};
pub use ast::{ParsedImport, SourceParser};
pub use resolver::{ImportResolver, ResolvedTarget};
pub use tsconfig::TsConfig;

#[cfg(test)]
mod tests {
    use super::*;
    use prebase_core::model::RelationshipKind;
    use std::collections::HashSet;

    #[test]
    fn test_tree_sitter_import_extractions() {
        let mut parser = SourceParser::new();

        let code = r#"
            // Leading comment
            import React, { useState, useEffect } from "react";
            import * as utils from "./utils";
            import "./styles.css";
            import type { AppProps } from "./types";
            export { Button } from "./components/Button";
            export * from "./components/Card";
            export type * from "./types/api";

            const helper = require("./legacyHelper");
            const dynamicModule = import("./lazyFeature");

            function test() {
                // Nested comment with "fake/import"
                console.log("hello");
            }
        "#;

        let imports = parser.parse_file(".tsx", code).unwrap();

        // 1. react
        let react_imp = imports.iter().find(|i| i.specifier == "react").unwrap();
        assert_eq!(react_imp.relationship_kind, RelationshipKind::Import);
        assert!(!react_imp.is_type_only);

        // 2. ./utils
        let utils_imp = imports.iter().find(|i| i.specifier == "./utils").unwrap();
        assert_eq!(utils_imp.relationship_kind, RelationshipKind::Import);

        // 3. ./styles.css
        let styles_imp = imports
            .iter()
            .find(|i| i.specifier == "./styles.css")
            .unwrap();
        assert_eq!(styles_imp.relationship_kind, RelationshipKind::Import);

        // 4. import type from ./types
        let type_imp = imports.iter().find(|i| i.specifier == "./types").unwrap();
        assert_eq!(type_imp.relationship_kind, RelationshipKind::TypeOnly);
        assert!(type_imp.is_type_only);

        // 5. export from ./components/Button
        let exp_btn = imports
            .iter()
            .find(|i| i.specifier == "./components/Button")
            .unwrap();
        assert_eq!(exp_btn.relationship_kind, RelationshipKind::Export);

        // 6. export * from ./components/Card
        let exp_card = imports
            .iter()
            .find(|i| i.specifier == "./components/Card")
            .unwrap();
        assert_eq!(exp_card.relationship_kind, RelationshipKind::Export);

        // 7. export type * from ./types/api
        let exp_type = imports
            .iter()
            .find(|i| i.specifier == "./types/api")
            .unwrap();
        assert_eq!(exp_type.relationship_kind, RelationshipKind::TypeOnly);

        // 8. require("./legacyHelper")
        let req_imp = imports
            .iter()
            .find(|i| i.specifier == "./legacyHelper")
            .unwrap();
        assert_eq!(req_imp.relationship_kind, RelationshipKind::Import);

        // 9. import("./lazyFeature")
        let dyn_imp = imports
            .iter()
            .find(|i| i.specifier == "./lazyFeature")
            .unwrap();
        assert_eq!(dyn_imp.relationship_kind, RelationshipKind::DynamicImport);

        // Ensure comment strings were NOT extracted
        assert!(!imports.iter().any(|i| i.specifier.contains("fake/import")));
    }

    #[test]
    fn test_tree_sitter_syntax_resilience() {
        let mut parser = SourceParser::new();
        // Incomplete code with syntax errors
        let broken_code = r#"
            import { valid } from "./validModule";
            function broken( {
                missing_closing_paren...
            import type { Another } from "./another";
        "#;

        let imports = parser.parse_file(".ts", broken_code).unwrap();
        assert!(imports.iter().any(|i| i.specifier == "./validModule"));
    }

    #[test]
    fn test_import_resolver_relative_and_extensionless() {
        let mut known = HashSet::new();
        known.insert("src/index.ts".to_string());
        known.insert("src/utils/math.ts".to_string());
        known.insert("src/components/Header/index.tsx".to_string());
        known.insert("src/legacy.js".to_string());

        let resolver = ImportResolver::new(known, None);

        // 1. Relative extensionless import
        let res1 = resolver.resolve("src/index.ts", "./utils/math");
        assert_eq!(res1, ResolvedTarget::Internal("src/utils/math.ts".into()));

        // 2. Relative index file import
        let res2 = resolver.resolve("src/index.ts", "./components/Header");
        assert_eq!(
            res2,
            ResolvedTarget::Internal("src/components/Header/index.tsx".into())
        );

        // 3. Parent dir relative import
        let res3 = resolver.resolve("src/utils/math.ts", "../legacy");
        assert_eq!(res3, ResolvedTarget::Internal("src/legacy.js".into()));

        // 4. External package
        let res4 = resolver.resolve("src/index.ts", "react");
        assert_eq!(res4, ResolvedTarget::External("react".into()));

        // 5. Unresolved missing file
        let res5 = resolver.resolve("src/index.ts", "./nonexistent");
        assert!(matches!(res5, ResolvedTarget::Unresolved(_)));
    }

    #[test]
    fn test_repository_analyzer_e2e_on_disk() {
        use std::fs;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();

        let src_dir = root.join("src");
        let components_dir = src_dir.join("components");
        fs::create_dir_all(&components_dir).unwrap();

        // 1. src/index.ts -> imports ./components/App
        fs::write(
            src_dir.join("index.ts"),
            r#"
            import { App } from "./components/App";
            import "react";
            console.log(App);
            "#,
        )
        .unwrap();

        // 2. src/components/App.tsx -> imports ../utils and ./Header
        fs::write(
            components_dir.join("App.tsx"),
            r#"
            import { add } from "../utils";
            import { Header } from "./Header";
            export function App() { return Header(); }
            "#,
        )
        .unwrap();

        // 3. src/components/Header.tsx
        fs::write(
            components_dir.join("Header.tsx"),
            r#"
            export function Header() { return "header"; }
            "#,
        )
        .unwrap();

        // 4. src/utils.ts
        fs::write(
            src_dir.join("utils.ts"),
            r#"
            export function add(a: number, b: number) { return a + b; }
            "#,
        )
        .unwrap();

        // 5. Secret file that must be excluded: .env
        fs::write(root.join(".env"), "SECRET_API_KEY=12345").unwrap();

        let analyzer = RepositoryAnalyzer::default();
        let res = analyzer.analyze_path(root).unwrap();

        let snapshot = res.snapshot;
        assert_eq!(snapshot.nodes.len(), 4);
        assert!(!snapshot.nodes.iter().any(|n| n.relative_path == ".env"));

        // Edges:
        // index.ts -> App.tsx
        // App.tsx -> utils.ts
        // App.tsx -> Header.tsx
        assert_eq!(snapshot.edges.len(), 3);

        let index_edge = snapshot
            .edges
            .iter()
            .find(|e| e.source_file_id == "src/index.ts")
            .unwrap();
        assert_eq!(index_edge.target_file_id, "src/components/App.tsx");

        let app_to_utils = snapshot
            .edges
            .iter()
            .find(|e| {
                e.source_file_id == "src/components/App.tsx" && e.target_file_id == "src/utils.ts"
            })
            .unwrap();
        assert_eq!(app_to_utils.evidence.len(), 1);

        assert_eq!(snapshot.coverage.total_discovered, 4);
        assert_eq!(snapshot.coverage.total_analyzed, 4);
        assert!(snapshot.coverage.is_complete);
    }
}

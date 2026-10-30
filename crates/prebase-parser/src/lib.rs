pub mod analyzer;
pub mod ast;
pub mod resolver;
pub mod tsconfig;

pub use analyzer::{AnalysisResult, RepositoryAnalyzer};
pub use ast::{ParsedImport, SourceParser};
pub use resolver::{ImportResolver, ProjectContext, ResolvedTarget};
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
    fn test_all_languages_extractions_verified() {
        let mut parser = SourceParser::new();

        // 1. Python
        let py_code = r#"
            import os
            import my_pkg.mod
            from .utils import helper
            from ..parent import base
            import numpy as np
        "#;
        let py_imps = parser.parse_source("python", py_code).unwrap();
        assert_eq!(py_imps.len(), 5);
        assert_eq!(py_imps[0].specifier, "os");
        assert_eq!(py_imps[1].specifier, "my_pkg.mod");
        assert_eq!(py_imps[2].specifier, ".utils");
        assert_eq!(py_imps[3].specifier, "..parent");
        assert_eq!(py_imps[4].specifier, "numpy");

        // 2. Rust
        let rust_code = r#"
            mod service;
            use crate::service::Client;
            use super::utils;
            use std::collections::HashMap;
            mod inline { fn f() {} }
        "#;
        let r_imps = parser.parse_source("rust", rust_code).unwrap();
        assert_eq!(r_imps.len(), 4);
        assert_eq!(r_imps[0].specifier, "service");
        assert_eq!(
            r_imps[0].relationship_kind,
            RelationshipKind::ModuleDeclaration
        );
        assert_eq!(r_imps[1].specifier, "crate::service::Client");
        assert_eq!(r_imps[1].relationship_kind, RelationshipKind::Import);
        assert_eq!(r_imps[2].specifier, "super::utils");
        assert_eq!(r_imps[3].specifier, "std::collections::HashMap");

        // 3. Go
        let go_code = r#"
            package main
            import "fmt"
            import "example.com/app/pkg/service"
            import (
                "os"
                alias "net/http"
            )
        "#;
        let go_imps = parser.parse_source("go", go_code).unwrap();
        assert_eq!(go_imps.len(), 4);
        assert_eq!(go_imps[0].specifier, "fmt");
        assert_eq!(
            go_imps[0].relationship_kind,
            RelationshipKind::PackageImport
        );
        assert_eq!(go_imps[1].specifier, "example.com/app/pkg/service");
        assert_eq!(go_imps[2].specifier, "os");
        assert_eq!(go_imps[3].specifier, "net/http");

        // 4. Java
        let java_code = r#"
            package com.example;
            import com.example.service.UserService;
            import com.example.utils.*;
        "#;
        let j_imps = parser.parse_source("java", java_code).unwrap();
        assert_eq!(j_imps.len(), 2);
        assert_eq!(j_imps[0].specifier, "com.example.service.UserService");
        assert_eq!(j_imps[0].relationship_kind, RelationshipKind::Import);
        assert_eq!(j_imps[1].specifier, "com.example.utils.*");
        assert_eq!(j_imps[1].relationship_kind, RelationshipKind::PackageImport);

        // 5. C/C++
        let c_code = r#"
            #include "local.h"
            #include <vector>
            #include <stdio.h>
        "#;
        let c_imps = parser.parse_source("c", c_code).unwrap();
        assert_eq!(c_imps.len(), 3);
        assert_eq!(c_imps[0].specifier, "local.h");
        assert_eq!(c_imps[0].relationship_kind, RelationshipKind::Include);
        assert_eq!(c_imps[1].specifier, "vector");
        assert_eq!(c_imps[2].specifier, "stdio.h");

        // 6. C#
        let cs_code = r#"
            using System;
            using MyProject.Services;
        "#;
        let cs_imps = parser.parse_source("csharp", cs_code).unwrap();
        assert_eq!(cs_imps.len(), 2);
        assert_eq!(cs_imps[0].specifier, "System");
        assert_eq!(cs_imps[0].relationship_kind, RelationshipKind::Import);
        assert_eq!(cs_imps[1].specifier, "MyProject.Services");

        // 7. Ruby
        let rb_code = r#"
            require_relative "helpers"
            require "json"
            load "config.rb"
        "#;
        let rb_imps = parser.parse_source("ruby", rb_code).unwrap();
        assert_eq!(rb_imps.len(), 3);
        assert_eq!(rb_imps[0].specifier, "helpers");
        assert_eq!(rb_imps[0].relationship_kind, RelationshipKind::Require);
        assert_eq!(rb_imps[1].specifier, "json");
        assert_eq!(rb_imps[2].specifier, "config.rb");

        // 8. PHP
        let php_code = r#"<?php
            require_once "config.php";
            include 'header.php';
            use App\Services\UserService;
        "#;
        let php_imps = parser.parse_source("php", php_code).unwrap();
        assert_eq!(php_imps.len(), 3);
        assert_eq!(php_imps[0].specifier, "config.php");
        assert_eq!(php_imps[0].relationship_kind, RelationshipKind::Require);
        assert_eq!(php_imps[1].specifier, "header.php");
        assert_eq!(php_imps[1].relationship_kind, RelationshipKind::Require);
        assert_eq!(php_imps[2].specifier, "App\\Services\\UserService");
        assert_eq!(php_imps[2].relationship_kind, RelationshipKind::Import);

        // 9. Lua
        let lua_code = r#"
            local sock = require("socket")
            local mod = require 'my_module'
        "#;
        let lua_imps = parser.parse_source("lua", lua_code).unwrap();
        assert_eq!(lua_imps.len(), 2);
        assert_eq!(lua_imps[0].specifier, "socket");
        assert_eq!(lua_imps[0].relationship_kind, RelationshipKind::Require);
        assert_eq!(lua_imps[1].specifier, "my_module");

        // 10. Kotlin
        let kt_code = r#"
            package com.example
            import com.example.service.UserService
            import com.example.utils.*
        "#;
        let kt_imps = parser.parse_source("kotlin", kt_code).unwrap();
        assert_eq!(kt_imps.len(), 2);
        assert_eq!(kt_imps[0].specifier, "com.example.service.UserService");
        assert_eq!(kt_imps[0].relationship_kind, RelationshipKind::Import);
        assert_eq!(kt_imps[1].specifier, "com.example.utils.*");
        assert_eq!(
            kt_imps[1].relationship_kind,
            RelationshipKind::PackageImport
        );

        // 11. Swift
        let swift_code = r#"
            import Foundation
            import UIKit
        "#;
        let swift_imps = parser.parse_source("swift", swift_code).unwrap();
        assert_eq!(swift_imps.len(), 2);
        assert_eq!(swift_imps[0].specifier, "Foundation");
        assert_eq!(swift_imps[0].relationship_kind, RelationshipKind::Import);
        assert_eq!(swift_imps[1].specifier, "UIKit");

        // 12. Scala
        let scala_code = r#"
            import scala.collection.mutable.ArrayBuffer
        "#;
        let scala_imps = parser.parse_source("scala", scala_code).unwrap();
        assert_eq!(scala_imps.len(), 1);
        assert_eq!(
            scala_imps[0].specifier,
            "scala.collection.mutable.ArrayBuffer"
        );
        assert_eq!(scala_imps[0].relationship_kind, RelationshipKind::Import);

        // 13. Elixir
        let ex_code = r#"
            alias Foo.Bar
            import Enum
            require Logger
        "#;
        let ex_imps = parser.parse_source("elixir", ex_code).unwrap();
        assert_eq!(ex_imps.len(), 3);
        assert_eq!(ex_imps[0].specifier, "Foo.Bar");
        assert_eq!(ex_imps[0].relationship_kind, RelationshipKind::Import);
        assert_eq!(ex_imps[1].specifier, "Enum");
        assert_eq!(ex_imps[2].specifier, "Logger");

        // 14. Haskell
        let hs_code = r#"
            import Data.List
            import qualified Data.Map as Map
        "#;
        let hs_imps = parser.parse_source("haskell", hs_code).unwrap();
        assert_eq!(hs_imps.len(), 2);
        assert_eq!(hs_imps[0].specifier, "Data.List");
        assert_eq!(hs_imps[1].specifier, "Data.Map");

        // 15. R
        let r_code = r#"
            source("helpers.R")
            library("ggplot2")
            require(dplyr)
        "#;
        let r_imps = parser.parse_source("r", r_code).unwrap();
        assert_eq!(r_imps.len(), 3);
        assert_eq!(r_imps[0].specifier, "helpers.R");
        assert_eq!(r_imps[0].relationship_kind, RelationshipKind::Include);
        assert_eq!(r_imps[1].specifier, "ggplot2");
        assert_eq!(r_imps[1].relationship_kind, RelationshipKind::Import);
        assert_eq!(r_imps[2].specifier, "dplyr");

        // 16. Shell
        let sh_code = r#"
            source ./utils.sh
            . ./config.sh
        "#;
        let sh_imps = parser.parse_source("shell", sh_code).unwrap();
        assert_eq!(sh_imps.len(), 2);
        assert_eq!(sh_imps[0].specifier, "./utils.sh");
        assert_eq!(sh_imps[0].relationship_kind, RelationshipKind::Include);
        assert_eq!(sh_imps[1].specifier, "./config.sh");

        // 17. HTML
        let html_code = r#"
            <!DOCTYPE html>
            <html>
            <head>
                <link rel="stylesheet" href="./style.css">
                <script src="./app.js"></script>
            </head>
            </html>
        "#;
        let html_imps = parser.parse_source("html", html_code).unwrap();
        assert_eq!(html_imps.len(), 2);
        assert_eq!(html_imps[0].specifier, "./style.css");
        assert_eq!(html_imps[0].relationship_kind, RelationshipKind::Import);
        assert_eq!(html_imps[1].specifier, "./app.js");

        // 18. CSS
        let css_code = r#"
            @import "base.css";
            @import url("components/button.css");
        "#;
        let css_imps = parser.parse_source("css", css_code).unwrap();
        assert_eq!(css_imps.len(), 2);
        assert_eq!(css_imps[0].specifier, "base.css");
        assert_eq!(css_imps[0].relationship_kind, RelationshipKind::Import);
        assert_eq!(css_imps[1].specifier, "components/button.css");
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

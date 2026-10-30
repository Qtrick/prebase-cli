use std::collections::HashSet;
use std::path::PathBuf;

use prebase_core::model::{NodeAnalysisStatus, RelationshipKind};
use prebase_parser::{
    ImportResolver, ProjectContext, RepositoryAnalyzer, ResolvedTarget, SourceParser,
};

// =========================================================================
// 1. AST Parser Extractions for all Core Languages
// =========================================================================

#[test]
fn test_parser_extractions_python() {
    let mut parser = SourceParser::new();
    let code = r#"
import os
import my_pkg.mod
from .utils import helper
from ..parent import base
import numpy as np
from . import local_fn
"#;
    let imps = parser.parse_source("python", code).unwrap();
    assert_eq!(imps.len(), 6);

    assert_eq!(imps[0].specifier, "os");
    assert_eq!(imps[0].relationship_kind, RelationshipKind::Import);

    assert_eq!(imps[1].specifier, "my_pkg.mod");
    assert_eq!(imps[1].relationship_kind, RelationshipKind::Import);

    assert_eq!(imps[2].specifier, ".utils");
    assert_eq!(imps[2].relationship_kind, RelationshipKind::Import);

    assert_eq!(imps[3].specifier, "..parent");
    assert_eq!(imps[3].relationship_kind, RelationshipKind::Import);

    assert_eq!(imps[4].specifier, "numpy");
    assert_eq!(imps[4].relationship_kind, RelationshipKind::Import);

    assert_eq!(imps[5].specifier, ".");
    assert_eq!(imps[5].relationship_kind, RelationshipKind::Import);
}

#[test]
fn test_parser_extractions_rust() {
    let mut parser = SourceParser::new();
    let code = r#"
mod service;
use crate::service::Client;
use super::utils;
use std::collections::HashMap;

mod inline_mod {
    pub fn ignore_me() {}
}
"#;
    let imps = parser.parse_source("rust", code).unwrap();
    assert_eq!(imps.len(), 4);

    assert_eq!(imps[0].specifier, "service");
    assert_eq!(
        imps[0].relationship_kind,
        RelationshipKind::ModuleDeclaration
    );

    assert_eq!(imps[1].specifier, "crate::service::Client");
    assert_eq!(imps[1].relationship_kind, RelationshipKind::Import);

    assert_eq!(imps[2].specifier, "super::utils");
    assert_eq!(imps[2].relationship_kind, RelationshipKind::Import);

    assert_eq!(imps[3].specifier, "std::collections::HashMap");
    assert_eq!(imps[3].relationship_kind, RelationshipKind::Import);
}

#[test]
fn test_parser_extractions_go() {
    let mut parser = SourceParser::new();
    let code = r#"
package main

import "fmt"
import "example.com/app/pkg/service"
import (
    "os"
    alias "net/http"
)
"#;
    let imps = parser.parse_source("go", code).unwrap();
    assert_eq!(imps.len(), 4);

    assert_eq!(imps[0].specifier, "fmt");
    assert_eq!(imps[0].relationship_kind, RelationshipKind::PackageImport);

    assert_eq!(imps[1].specifier, "example.com/app/pkg/service");
    assert_eq!(imps[1].relationship_kind, RelationshipKind::PackageImport);

    assert_eq!(imps[2].specifier, "os");
    assert_eq!(imps[2].relationship_kind, RelationshipKind::PackageImport);

    assert_eq!(imps[3].specifier, "net/http");
    assert_eq!(imps[3].relationship_kind, RelationshipKind::PackageImport);
}

#[test]
fn test_parser_extractions_java() {
    let mut parser = SourceParser::new();
    let code = r#"
package com.example;

import com.example.service.UserService;
import com.example.utils.*;
import java.util.List;
"#;
    let imps = parser.parse_source("java", code).unwrap();
    assert_eq!(imps.len(), 3);

    assert_eq!(imps[0].specifier, "com.example.service.UserService");
    assert_eq!(imps[0].relationship_kind, RelationshipKind::Import);

    assert_eq!(imps[1].specifier, "com.example.utils.*");
    assert_eq!(imps[1].relationship_kind, RelationshipKind::PackageImport);

    assert_eq!(imps[2].specifier, "java.util.List");
    assert_eq!(imps[2].relationship_kind, RelationshipKind::Import);
}

#[test]
fn test_parser_extractions_c_cpp() {
    let mut parser = SourceParser::new();
    let code = r#"
#include "local.h"
#include <vector>
#include <stdio.h>
#include "engine/core.hpp"
"#;
    let imps = parser.parse_source("cpp", code).unwrap();
    assert_eq!(imps.len(), 4);

    assert_eq!(imps[0].specifier, "local.h");
    assert_eq!(imps[0].relationship_kind, RelationshipKind::Include);

    assert_eq!(imps[1].specifier, "vector");
    assert_eq!(imps[1].relationship_kind, RelationshipKind::Include);

    assert_eq!(imps[2].specifier, "stdio.h");
    assert_eq!(imps[2].relationship_kind, RelationshipKind::Include);

    assert_eq!(imps[3].specifier, "engine/core.hpp");
    assert_eq!(imps[3].relationship_kind, RelationshipKind::Include);
}

#[test]
fn test_parser_extractions_csharp() {
    let mut parser = SourceParser::new();
    let code = r#"
using System;
using MyProject.Services;
using static System.Math;
"#;
    let imps = parser.parse_source("csharp", code).unwrap();
    assert_eq!(imps.len(), 3);

    assert_eq!(imps[0].specifier, "System");
    assert_eq!(imps[0].relationship_kind, RelationshipKind::Import);

    assert_eq!(imps[1].specifier, "MyProject.Services");
    assert_eq!(imps[1].relationship_kind, RelationshipKind::Import);

    assert_eq!(imps[2].specifier, "System.Math");
    assert_eq!(imps[2].relationship_kind, RelationshipKind::Import);
}

#[test]
fn test_parser_extractions_ruby() {
    let mut parser = SourceParser::new();
    let code = r#"
require_relative "helpers"
require "json"
load "config.rb"
"#;
    let imps = parser.parse_source("ruby", code).unwrap();
    assert_eq!(imps.len(), 3);

    assert_eq!(imps[0].specifier, "helpers");
    assert_eq!(imps[0].relationship_kind, RelationshipKind::Require);

    assert_eq!(imps[1].specifier, "json");
    assert_eq!(imps[1].relationship_kind, RelationshipKind::Require);

    assert_eq!(imps[2].specifier, "config.rb");
    assert_eq!(imps[2].relationship_kind, RelationshipKind::Require);
}

#[test]
fn test_parser_extractions_php() {
    let mut parser = SourceParser::new();
    let code = r#"<?php
require_once "config.php";
include 'header.php';
use App\Services\UserService;
"#;
    let imps = parser.parse_source("php", code).unwrap();
    assert_eq!(imps.len(), 3);

    assert_eq!(imps[0].specifier, "config.php");
    assert_eq!(imps[0].relationship_kind, RelationshipKind::Require);

    assert_eq!(imps[1].specifier, "header.php");
    assert_eq!(imps[1].relationship_kind, RelationshipKind::Require);

    assert_eq!(imps[2].specifier, "App\\Services\\UserService");
    assert_eq!(imps[2].relationship_kind, RelationshipKind::Import);
}

#[test]
fn test_parser_extractions_scripting_and_web() {
    let mut parser = SourceParser::new();

    // Lua
    let lua_code = r#"
        local sock = require("socket")
        local mod = require 'my_module'
    "#;
    let lua_imps = parser.parse_source("lua", lua_code).unwrap();
    assert_eq!(lua_imps.len(), 2);
    assert_eq!(lua_imps[0].specifier, "socket");
    assert_eq!(lua_imps[0].relationship_kind, RelationshipKind::Require);
    assert_eq!(lua_imps[1].specifier, "my_module");

    // Kotlin
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

    // Swift
    let swift_code = r#"
        import Foundation
        import UIKit
    "#;
    let swift_imps = parser.parse_source("swift", swift_code).unwrap();
    assert_eq!(swift_imps.len(), 2);
    assert_eq!(swift_imps[0].specifier, "Foundation");
    assert_eq!(swift_imps[0].relationship_kind, RelationshipKind::Import);
    assert_eq!(swift_imps[1].specifier, "UIKit");

    // Scala
    let scala_code = r#"
        import scala.collection.mutable.ArrayBuffer
        import scala.util._
    "#;
    let scala_imps = parser.parse_source("scala", scala_code).unwrap();
    assert_eq!(scala_imps.len(), 2);
    assert_eq!(
        scala_imps[0].specifier,
        "scala.collection.mutable.ArrayBuffer"
    );
    assert_eq!(scala_imps[0].relationship_kind, RelationshipKind::Import);
    assert_eq!(scala_imps[1].specifier, "scala.util._");

    // Elixir
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

    // Haskell
    let hs_code = r#"
        import Data.List
        import qualified Data.Map as Map
    "#;
    let hs_imps = parser.parse_source("haskell", hs_code).unwrap();
    assert_eq!(hs_imps.len(), 2);
    assert_eq!(hs_imps[0].specifier, "Data.List");
    assert_eq!(hs_imps[1].specifier, "Data.Map");

    // R
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

    // Shell
    let sh_code = r#"
        source ./utils.sh
        . ./config.sh
    "#;
    let sh_imps = parser.parse_source("shell", sh_code).unwrap();
    assert_eq!(sh_imps.len(), 2);
    assert_eq!(sh_imps[0].specifier, "./utils.sh");
    assert_eq!(sh_imps[0].relationship_kind, RelationshipKind::Include);
    assert_eq!(sh_imps[1].specifier, "./config.sh");

    // HTML
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

    // CSS
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

// =========================================================================
// 2. Language-Aware Resolver Semantics
// =========================================================================

#[test]
fn test_resolver_semantics_python() {
    let mut known = HashSet::new();
    known.insert("src/pkg/main.py".to_string());
    known.insert("src/pkg/utils.py".to_string());
    known.insert("src/pkg/sub/__init__.py".to_string());
    known.insert("src/pkg/sub/calc.py".to_string());
    known.insert("src/pkg/parent.py".to_string());

    let resolver = ImportResolver::new(known, None);

    // Relative same-level import
    let res1 = resolver.resolve_for_language("src/pkg/main.py", "python", ".utils");
    assert_eq!(res1, ResolvedTarget::Internal("src/pkg/utils.py".into()));

    // Relative parent-level import
    let res2 = resolver.resolve_for_language("src/pkg/sub/calc.py", "python", "..parent");
    assert_eq!(res2, ResolvedTarget::Internal("src/pkg/parent.py".into()));

    // Relative package __init__.py import
    let res3 = resolver.resolve_for_language("src/pkg/main.py", "python", ".sub");
    assert_eq!(
        res3,
        ResolvedTarget::Internal("src/pkg/sub/__init__.py".into())
    );

    // Absolute internal import
    let res4 = resolver.resolve_for_language("src/pkg/main.py", "python", "pkg.utils");
    assert_eq!(res4, ResolvedTarget::Internal("src/pkg/utils.py".into()));

    // Standard library external package
    let res5 = resolver.resolve_for_language("src/pkg/main.py", "python", "os");
    assert_eq!(res5, ResolvedTarget::External("os".into()));

    let res6 = resolver.resolve_for_language("src/pkg/main.py", "python", "sys");
    assert_eq!(res6, ResolvedTarget::External("sys".into()));

    let res7 = resolver.resolve_for_language("src/pkg/main.py", "python", "typing");
    assert_eq!(res7, ResolvedTarget::External("typing".into()));

    // Common 3rd party external package
    let res8 = resolver.resolve_for_language("src/pkg/main.py", "python", "requests");
    assert_eq!(res8, ResolvedTarget::External("requests".into()));

    // Unresolved relative import
    let res9 = resolver.resolve_for_language("src/pkg/main.py", "python", ".nonexistent");
    assert!(matches!(res9, ResolvedTarget::Unresolved(_)));

    let res10 = resolver.resolve_for_language("src/pkg/sub/calc.py", "python", "...invalid_step");
    assert!(matches!(res10, ResolvedTarget::Unresolved(_)));
}

#[test]
fn test_resolver_semantics_rust() {
    let mut known = HashSet::new();
    known.insert("src/main.rs".to_string());
    known.insert("src/service.rs".to_string());
    known.insert("src/service/worker.rs".to_string());
    known.insert("src/utils/mod.rs".to_string());

    let resolver = ImportResolver::new(known, None);

    // 1. Direct module declaration (mod service;)
    let res1 = resolver.resolve_for_language("src/main.rs", "rust", "service");
    assert_eq!(res1, ResolvedTarget::Internal("src/service.rs".into()));

    // 2. Mod.rs declaration (mod utils;)
    let res2 = resolver.resolve_for_language("src/main.rs", "rust", "utils");
    assert_eq!(res2, ResolvedTarget::Internal("src/utils/mod.rs".into()));

    // 3. Submodule declaration (mod worker; inside src/service.rs)
    let res3 = resolver.resolve_for_language("src/service.rs", "rust", "worker");
    assert_eq!(
        res3,
        ResolvedTarget::Internal("src/service/worker.rs".into())
    );

    // 4. use crate::service::worker::Task;
    let res4 = resolver.resolve_for_language("src/main.rs", "rust", "crate::service::worker::Task");
    assert_eq!(
        res4,
        ResolvedTarget::Internal("src/service/worker.rs".into())
    );

    // 5. use crate::utils::Helper;
    let res5 = resolver.resolve_for_language("src/service.rs", "rust", "crate::utils::Helper");
    assert_eq!(res5, ResolvedTarget::Internal("src/utils/mod.rs".into()));

    // 6. External standard library or third-party crate
    let res6 = resolver.resolve_for_language("src/main.rs", "rust", "std::collections::HashMap");
    assert_eq!(res6, ResolvedTarget::External("std".into()));

    let res7 = resolver.resolve_for_language("src/main.rs", "rust", "tokio::sync::mpsc");
    assert_eq!(res7, ResolvedTarget::External("tokio".into()));

    // 7. Unresolved declarations and crate paths
    let res8 = resolver.resolve_for_language("src/main.rs", "rust", "nonexistent_mod");
    assert!(matches!(res8, ResolvedTarget::Unresolved(_)));

    let res9 = resolver.resolve_for_language("src/main.rs", "rust", "crate::missing::Thing");
    assert!(matches!(res9, ResolvedTarget::Unresolved(_)));

    let res10 =
        resolver.resolve_for_language("src/service/worker.rs", "rust", "super::nonexistent");
    assert!(matches!(res10, ResolvedTarget::Unresolved(_)));
}

#[test]
fn test_resolver_semantics_go() {
    let mut known = HashSet::new();
    known.insert("cmd/server/main.go".to_string());
    known.insert("cmd/server/config.go".to_string());
    known.insert("pkg/service/service.go".to_string());
    known.insert("pkg/service/service_test.go".to_string());

    let context = ProjectContext {
        go_module_name: Some("example.com/app".to_string()),
        go_modules: vec![(String::new(), "example.com/app".to_string())],
        ..Default::default()
    };
    let resolver = ImportResolver::with_context(known, context);

    // Module-aware internal import
    let res1 =
        resolver.resolve_for_language("cmd/server/main.go", "go", "example.com/app/pkg/service");
    assert_eq!(
        res1,
        ResolvedTarget::Internal("pkg/service/service.go".into())
    );

    // Standard library package
    let res2 = resolver.resolve_for_language("cmd/server/main.go", "go", "fmt");
    assert_eq!(res2, ResolvedTarget::External("fmt".into()));

    let res3 = resolver.resolve_for_language("cmd/server/main.go", "go", "net/http");
    assert_eq!(res3, ResolvedTarget::External("net/http".into()));

    // Third-party external package
    let res4 = resolver.resolve_for_language("cmd/server/main.go", "go", "github.com/google/uuid");
    assert_eq!(
        res4,
        ResolvedTarget::External("github.com/google/uuid".into())
    );

    // Unresolved module subpackage
    let res5 = resolver.resolve_for_language(
        "cmd/server/main.go",
        "go",
        "example.com/app/pkg/nonexistent",
    );
    assert!(matches!(res5, ResolvedTarget::Unresolved(_)));

    // Unresolved relative import
    let res6 = resolver.resolve_for_language("cmd/server/main.go", "go", "./missing");
    assert!(matches!(res6, ResolvedTarget::Unresolved(_)));
}

#[test]
fn test_resolver_semantics_java() {
    let mut known = HashSet::new();
    known.insert("src/main/java/com/example/polyglot/App.java".to_string());
    known.insert("src/main/java/com/example/polyglot/service/UserService.java".to_string());
    known.insert("src/main/java/com/example/polyglot/utils/Helper.java".to_string());

    let resolver = ImportResolver::new(known, None);

    // Single class import
    let res1 = resolver.resolve_for_language(
        "src/main/java/com/example/polyglot/App.java",
        "java",
        "com.example.polyglot.service.UserService",
    );
    assert_eq!(
        res1,
        ResolvedTarget::Internal(
            "src/main/java/com/example/polyglot/service/UserService.java".into()
        )
    );

    // Wildcard package import
    let res2 = resolver.resolve_for_language(
        "src/main/java/com/example/polyglot/App.java",
        "java",
        "com.example.polyglot.utils.*",
    );
    assert_eq!(
        res2,
        ResolvedTarget::Internal("src/main/java/com/example/polyglot/utils/Helper.java".into())
    );

    // External package
    let res3 = resolver.resolve_for_language(
        "src/main/java/com/example/polyglot/App.java",
        "java",
        "java.util.List",
    );
    assert_eq!(res3, ResolvedTarget::External("java".into()));

    let res4 = resolver.resolve_for_language(
        "src/main/java/com/example/polyglot/App.java",
        "java",
        "org.springframework.boot.SpringApplication",
    );
    assert_eq!(res4, ResolvedTarget::External("org".into()));
}

#[test]
fn test_resolver_semantics_c_cpp() {
    let mut known = HashSet::new();
    known.insert("src/main.c".to_string());
    known.insert("src/local.h".to_string());
    known.insert("include/common.h".to_string());

    let resolver = ImportResolver::new(known, None);

    // 1. Same-directory relative include
    let res1 = resolver.resolve_for_language("src/main.c", "c", "local.h");
    assert_eq!(res1, ResolvedTarget::Internal("src/local.h".into()));

    // 2. Project include directory
    let res2 = resolver.resolve_for_language("src/main.c", "c", "common.h");
    assert_eq!(res2, ResolvedTarget::Internal("include/common.h".into()));

    // 3. System headers
    let res3 = resolver.resolve_for_language("src/main.c", "c", "stdio.h");
    assert_eq!(res3, ResolvedTarget::External("stdio.h".into()));

    let res4 = resolver.resolve_for_language("src/main.c", "cpp", "vector");
    assert_eq!(res4, ResolvedTarget::External("vector".into()));

    // 4. Unresolved relative include
    let res5 = resolver.resolve_for_language("src/main.c", "c", "./missing.h");
    assert!(matches!(res5, ResolvedTarget::Unresolved(_)));
}

#[test]
fn test_resolver_semantics_csharp() {
    let mut known = HashSet::new();
    known.insert("Program.cs".to_string());
    known.insert("Services/DataService.cs".to_string());

    let resolver = ImportResolver::new(known, None);

    // Namespace resolution
    let res1 = resolver.resolve_for_language("Program.cs", "csharp", "Services");
    assert_eq!(
        res1,
        ResolvedTarget::Internal("Services/DataService.cs".into())
    );

    // External namespaces
    let res2 = resolver.resolve_for_language("Program.cs", "csharp", "System");
    assert_eq!(res2, ResolvedTarget::External("System".into()));

    let res3 = resolver.resolve_for_language("Program.cs", "csharp", "System.Collections.Generic");
    assert_eq!(res3, ResolvedTarget::External("System".into()));
}

#[test]
fn test_resolver_semantics_ruby() {
    let mut known = HashSet::new();
    known.insert("app.rb".to_string());
    known.insert("lib/helper.rb".to_string());

    let resolver = ImportResolver::new(known, None);

    // Relative require
    let res1 = resolver.resolve_for_language("app.rb", "ruby", "lib/helper");
    assert_eq!(res1, ResolvedTarget::Internal("lib/helper.rb".into()));

    // External gem
    let res2 = resolver.resolve_for_language("app.rb", "ruby", "json");
    assert_eq!(res2, ResolvedTarget::External("json".into()));

    // Unresolved relative require
    let res3 = resolver.resolve_for_language("app.rb", "ruby", "./missing");
    assert!(matches!(res3, ResolvedTarget::Unresolved(_)));
}

#[test]
fn test_resolver_semantics_php() {
    let mut known = HashSet::new();
    known.insert("public/index.php".to_string());
    known.insert("public/config.php".to_string());
    known.insert("src/App/Services/UserService.php".to_string());

    let resolver = ImportResolver::new(known, None);

    // Relative require
    let res1 = resolver.resolve_for_language("public/index.php", "php", "config.php");
    assert_eq!(res1, ResolvedTarget::Internal("public/config.php".into()));

    // Namespace use
    let res2 =
        resolver.resolve_for_language("public/index.php", "php", "App\\Services\\UserService");
    assert_eq!(
        res2,
        ResolvedTarget::Internal("src/App/Services/UserService.php".into())
    );

    // External namespace
    let res3 = resolver.resolve_for_language("public/index.php", "php", "Monolog\\Logger");
    assert_eq!(res3, ResolvedTarget::External("Monolog\\Logger".into()));

    // Unresolved relative require
    let res4 = resolver.resolve_for_language("public/index.php", "php", "./missing.php");
    assert!(matches!(res4, ResolvedTarget::Unresolved(_)));
}

#[test]
fn test_resolver_semantics_r_elixir_haskell() {
    let mut known = HashSet::new();
    known.insert("analysis/run.R".to_string());
    known.insert("analysis/helpers.R".to_string());
    known.insert("analysis/utils.r".to_string());
    known.insert("lib/my_app/accounts.ex".to_string());
    known.insert("src/MyProject/Internal.hs".to_string());

    let resolver = ImportResolver::new(known, None);

    // 1. R source() same folder inclusion
    let res1 = resolver.resolve_for_language("analysis/run.R", "r", "helpers.R");
    assert_eq!(res1, ResolvedTarget::Internal("analysis/helpers.R".into()));

    let res2 = resolver.resolve_for_language("analysis/run.R", "r", "./utils.r");
    assert_eq!(res2, ResolvedTarget::Internal("analysis/utils.r".into()));

    // 2. R package libraries
    let res3 = resolver.resolve_for_language("analysis/run.R", "r", "ggplot2");
    assert_eq!(res3, ResolvedTarget::External("ggplot2".into()));

    let res4 = resolver.resolve_for_language("analysis/run.R", "r", "dplyr");
    assert_eq!(res4, ResolvedTarget::External("dplyr".into()));

    // 3. Elixir alias
    let res5 = resolver.resolve_for_language("lib/my_app.ex", "elixir", "MyApp.Accounts");
    assert_eq!(
        res5,
        ResolvedTarget::Internal("lib/my_app/accounts.ex".into())
    );

    let res6 = resolver.resolve_for_language("lib/my_app.ex", "elixir", "Enum");
    assert_eq!(res6, ResolvedTarget::External("Enum".into()));

    // 4. Haskell import
    let res7 = resolver.resolve_for_language("src/Main.hs", "haskell", "MyProject.Internal");
    assert_eq!(
        res7,
        ResolvedTarget::Internal("src/MyProject/Internal.hs".into())
    );

    let res8 = resolver.resolve_for_language("src/Main.hs", "haskell", "Data.List");
    assert_eq!(res8, ResolvedTarget::External("Data".into()));
}

#[test]
fn test_resolver_path_traversal_boundaries() {
    let mut known = HashSet::new();
    known.insert("secret.txt".to_string());
    known.insert("index.ts".to_string());
    known.insert("src/app.ts".to_string());
    known.insert("src/sub/mod.ts".to_string());

    let resolver = ImportResolver::new(known, None);

    // 1. Attempt to step above repository root from src/app.ts
    let res1 = resolver.resolve_for_language("src/app.ts", "typescript", "../../secret.txt");
    assert!(
        matches!(res1, ResolvedTarget::Unresolved(_)),
        "Must not resolve out-of-bounds traversal"
    );

    // 2. Attempt from root index.ts
    let res2 = resolver.resolve_for_language("index.ts", "typescript", "../secret.txt");
    assert!(
        matches!(res2, ResolvedTarget::Unresolved(_)),
        "Must not resolve out-of-bounds traversal"
    );

    // 3. Python relative import with excessive dots
    let res3 = resolver.resolve_for_language("src/app.py", "python", "...outside");
    assert!(
        matches!(res3, ResolvedTarget::Unresolved(_)),
        "Must not resolve excessive dots in Python"
    );

    // 4. Relative file resolver
    let res4 = resolver.resolve_for_language("src/sub/mod.ts", "shell", "../../secret.txt");
    assert_eq!(
        res4,
        ResolvedTarget::Internal("secret.txt".into()),
        "Direct traversal to root file is allowed if within repo boundary"
    );

    let res5 = resolver.resolve_for_language("src/sub/mod.ts", "shell", "../../../secret.txt");
    assert!(
        matches!(res5, ResolvedTarget::Unresolved(_)),
        "Escape past root must fail"
    );
}

#[test]
fn test_resolver_workspace_cargo_and_rust_submodules() {
    let mut known = HashSet::new();
    known.insert("crates/core/src/lib.rs".to_string());
    known.insert("crates/core/src/service.rs".to_string());
    known.insert("crates/core/src/service/worker/mod.rs".to_string());
    known.insert("crates/app/src/main.rs".to_string());

    let context = ProjectContext {
        cargo_packages: vec![
            ("crates/core".to_string(), "prebase-core".to_string()),
            ("crates/app".to_string(), "prebase-app".to_string()),
        ],
        ..Default::default()
    };

    let resolver = ImportResolver::with_context(known, context);

    // 1. Directory module worker/mod.rs inside service.rs
    let res1 = resolver.resolve_for_language("crates/core/src/service.rs", "rust", "worker");
    assert_eq!(
        res1,
        ResolvedTarget::Internal("crates/core/src/service/worker/mod.rs".into())
    );

    // 2. Cross-crate import via workspace package name
    let res2 =
        resolver.resolve_for_language("crates/app/src/main.rs", "rust", "prebase-core::service");
    assert_eq!(
        res2,
        ResolvedTarget::Internal("crates/core/src/service.rs".into())
    );

    // 3. Cross-crate import of root package
    let res3 = resolver.resolve_for_language("crates/app/src/main.rs", "rust", "prebase-core");
    assert_eq!(
        res3,
        ResolvedTarget::Internal("crates/core/src/lib.rs".into())
    );
}

// =========================================================================
// 3. End-to-End Polyglot Repository Analysis on Real Fixtures
// =========================================================================

#[test]
fn test_polyglot_repository_analysis_e2e() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let fixture_dir = manifest_dir
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("tests/fixtures/polyglot-repo");

    assert!(
        fixture_dir.exists(),
        "Polyglot fixture directory must exist"
    );

    let analyzer = RepositoryAnalyzer::default();
    let result = analyzer.analyze_path(&fixture_dir).unwrap();
    let snapshot = result.snapshot;

    // 1. Excluded files security verification (.env must NEVER be a node)
    assert!(
        !snapshot
            .nodes
            .iter()
            .any(|n| n.relative_path.contains(".env")),
        ".env file was not excluded by repository scanner!"
    );

    // 2. Node canonical language verification
    let get_node = |path: &str| {
        snapshot
            .nodes
            .iter()
            .find(|n| n.relative_path == path)
            .unwrap_or_else(|| panic!("Missing node: {path}"))
    };

    assert_eq!(get_node("rust_crate/src/main.rs").language, "rust");
    assert_eq!(get_node("python_app/main.py").language, "python");
    assert_eq!(get_node("go_app/cmd/server/main.go").language, "go");
    assert_eq!(
        get_node("java_app/src/main/java/com/example/polyglot/App.java").language,
        "java"
    );
    assert_eq!(get_node("native_app/src/main.c").language, "c");
    assert_eq!(get_node("native_app/src/engine.cpp").language, "cpp");
    assert_eq!(get_node("csharp_app/Program.cs").language, "csharp");
    assert_eq!(get_node("ruby_app/app.rb").language, "ruby");
    assert_eq!(get_node("php_app/index.php").language, "php");
    assert_eq!(get_node("lua_app/main.lua").language, "lua");
    assert_eq!(get_node("scripts/deploy.sh").language, "shell");
    assert_eq!(get_node("web_app/public/index.html").language, "html");
    assert_eq!(get_node("web_app/public/styles.css").language, "css");
    assert_eq!(get_node("web_app/src/index.ts").language, "typescript");
    assert_eq!(get_node("README.md").language, "markdown");
    assert_eq!(get_node("config.json").language, "json");
    assert_eq!(get_node("settings.yaml").language, "yaml");

    // 3. Node analysis status verification
    // Fully analyzed files
    assert_eq!(
        get_node("rust_crate/src/main.rs").analysis_status,
        NodeAnalysisStatus::Analyzed
    );
    assert_eq!(
        get_node("go_app/cmd/server/main.go").analysis_status,
        NodeAnalysisStatus::Analyzed
    );
    assert_eq!(
        get_node("csharp_app/Program.cs").analysis_status,
        NodeAnalysisStatus::Analyzed
    );

    // Truthful PartiallyAnalyzed status for file with missing import
    assert_eq!(
        get_node("python_app/broken_import.py").analysis_status,
        NodeAnalysisStatus::PartiallyAnalyzed
    );

    // Level 0 Recognized status for config / documentation
    assert_eq!(
        get_node("README.md").analysis_status,
        NodeAnalysisStatus::Recognized
    );
    assert_eq!(
        get_node("config.json").analysis_status,
        NodeAnalysisStatus::Recognized
    );
    assert_eq!(
        get_node("settings.yaml").analysis_status,
        NodeAnalysisStatus::Recognized
    );

    // 4. Relationship Kind verification
    let find_edge = |src: &str, tgt: &str| {
        snapshot
            .edges
            .iter()
            .find(|e| e.source_file_id == src && e.target_file_id == tgt)
            .unwrap_or_else(|| panic!("Missing edge {src} -> {tgt}"))
    };

    // Import
    let py_edge = find_edge("python_app/main.py", "python_app/utils.py");
    assert_eq!(py_edge.relationship_kind, RelationshipKind::Import);

    let cs_edge = find_edge(
        "csharp_app/Program.cs",
        "csharp_app/Services/DataService.cs",
    );
    assert_eq!(cs_edge.relationship_kind, RelationshipKind::Import);

    // ModuleDeclaration
    let rust_mod_edge = find_edge("rust_crate/src/main.rs", "rust_crate/src/service.rs");
    assert_eq!(
        rust_mod_edge.relationship_kind,
        RelationshipKind::ModuleDeclaration
    );

    // PackageImport
    let go_pkg_edge = find_edge("go_app/cmd/server/main.go", "go_app/pkg/math/calc.go");
    assert_eq!(
        go_pkg_edge.relationship_kind,
        RelationshipKind::PackageImport
    );

    // Include
    let c_include_edge = find_edge("native_app/src/main.c", "native_app/include/common.h");
    assert_eq!(c_include_edge.relationship_kind, RelationshipKind::Include);

    let sh_include_edge = find_edge("scripts/deploy.sh", "scripts/common.sh");
    assert_eq!(sh_include_edge.relationship_kind, RelationshipKind::Include);

    // Require
    let ruby_require_edge = find_edge("ruby_app/app.rb", "ruby_app/lib/helper.rb");
    assert_eq!(
        ruby_require_edge.relationship_kind,
        RelationshipKind::Require
    );

    let lua_require_edge = find_edge("lua_app/main.lua", "lua_app/helper.lua");
    assert_eq!(
        lua_require_edge.relationship_kind,
        RelationshipKind::Require
    );

    let php_require_edge = find_edge("php_app/index.php", "php_app/config.php");
    assert_eq!(
        php_require_edge.relationship_kind,
        RelationshipKind::Require
    );

    // 5. Coverage and Issue tracking verification
    assert_eq!(snapshot.coverage.total_issues, 1);
    assert!(!snapshot.coverage.is_complete);
    assert_eq!(snapshot.issues.len(), 1);
    assert_eq!(snapshot.issues[0].file_path, "python_app/broken_import.py");
    assert_eq!(snapshot.issues[0].issue_kind, "UnresolvedImport");
    assert!(snapshot.issues[0].message.contains("nonexistent_submodule"));
}

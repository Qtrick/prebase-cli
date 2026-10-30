use prebase_core::model::RelationshipKind;
use std::collections::HashMap;
use tree_sitter::{Node, Parser};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedImport {
    pub specifier: String,
    pub line: usize,
    pub column: usize,
    pub relationship_kind: RelationshipKind,
    pub is_type_only: bool,
}

pub struct SourceParser {
    parsers: HashMap<String, Parser>,
}

impl Default for SourceParser {
    fn default() -> Self {
        Self::new()
    }
}

impl SourceParser {
    pub fn new() -> Self {
        Self {
            parsers: HashMap::new(),
        }
    }

    pub(crate) fn get_or_init_parser(&mut self, language_id: &str) -> Result<&mut Parser, String> {
        if !self.parsers.contains_key(language_id) {
            let mut parser = Parser::new();
            let loaded = match language_id {
                "typescript" => parser.set_language(&tree_sitter_typescript::language_typescript()),
                "tsx" => parser.set_language(&tree_sitter_typescript::language_tsx()),
                "javascript" => parser.set_language(&tree_sitter_javascript::language()),
                "jsx" => parser.set_language(&tree_sitter_javascript::language()),
                "python" => parser.set_language(&tree_sitter_python::language()),
                "rust" => parser.set_language(&tree_sitter_rust::language()),
                "go" => parser.set_language(&tree_sitter_go::language()),
                "java" => parser.set_language(&tree_sitter_java::language()),
                "c" => parser.set_language(&tree_sitter_c::language()),
                "cpp" => parser.set_language(&tree_sitter_cpp::language()),
                "csharp" => parser.set_language(&tree_sitter_c_sharp::language()),
                "ruby" => parser.set_language(&tree_sitter_ruby::language()),
                "php" => parser.set_language(&tree_sitter_php::language_php()),
                "kotlin" => parser.set_language(&tree_sitter_kotlin::language()),
                "swift" => parser.set_language(&tree_sitter_swift::language()),
                "lua" => parser.set_language(&tree_sitter_lua::language()),
                "scala" => parser.set_language(&tree_sitter_scala::language()),
                "elixir" => parser.set_language(&tree_sitter_elixir::language()),
                "haskell" => parser.set_language(&tree_sitter_haskell::language()),
                "r" => parser.set_language(&tree_sitter_r::language()),
                "shell" => parser.set_language(&tree_sitter_bash::language()),
                "html" => parser.set_language(&tree_sitter_html::language()),
                "css" | "scss" => parser.set_language(&tree_sitter_css::language()),
                "json" => parser.set_language(&tree_sitter_json::language()),
                _ => return Err(format!("Unsupported language parser: {language_id}")),
            };

            loaded.map_err(|e| format!("Failed to set language grammar for {language_id}: {e}"))?;
            self.parsers.insert(language_id.to_string(), parser);
        }

        Ok(self.parsers.get_mut(language_id).unwrap())
    }

    pub fn parse_file(
        &mut self,
        extension: &str,
        source_code: &str,
    ) -> Result<Vec<ParsedImport>, String> {
        let lang = prebase_core::languages::detect_language(extension)
            .or_else(|| {
                if !extension.starts_with('.') {
                    prebase_core::languages::detect_language(&format!(".{extension}"))
                } else {
                    None
                }
            })
            .map(|d| d.id)
            .unwrap_or("unknown");

        self.parse_source(lang, source_code)
    }

    pub fn parse_source(
        &mut self,
        language: &str,
        source_code: &str,
    ) -> Result<Vec<ParsedImport>, String> {
        let parser = self.get_or_init_parser(language)?;
        let tree = parser
            .parse(source_code, None)
            .ok_or_else(|| format!("Tree-sitter failed to parse {language}"))?;

        let mut imports = Vec::new();
        let bytes = source_code.as_bytes();
        let root = tree.root_node();

        match language {
            "typescript" | "tsx" | "javascript" | "jsx" => {
                self.traverse_javascript(root, bytes, &mut imports);
            }
            "python" => {
                self.traverse_python(root, bytes, &mut imports);
            }
            "rust" => {
                self.traverse_rust(root, bytes, &mut imports);
            }
            "go" => {
                self.traverse_go(root, bytes, &mut imports);
            }
            "java" => {
                self.traverse_java(root, bytes, &mut imports);
            }
            "c" | "cpp" => {
                self.traverse_c_cpp(root, bytes, &mut imports);
            }
            "csharp" => {
                self.traverse_csharp(root, bytes, &mut imports);
            }
            "ruby" => {
                self.traverse_ruby(root, bytes, &mut imports);
            }
            "php" => {
                self.traverse_php(root, bytes, &mut imports);
            }
            "kotlin" => {
                self.traverse_kotlin(root, bytes, &mut imports);
            }
            "swift" => {
                self.traverse_swift(root, bytes, &mut imports);
            }
            "lua" => {
                self.traverse_lua(root, bytes, &mut imports);
            }
            "scala" => {
                self.traverse_scala(root, bytes, &mut imports);
            }
            "elixir" => {
                self.traverse_elixir(root, bytes, &mut imports);
            }
            "haskell" => {
                self.traverse_haskell(root, bytes, &mut imports);
            }
            "r" => {
                self.traverse_r(root, bytes, &mut imports);
            }
            "shell" => {
                self.traverse_shell(root, bytes, &mut imports);
            }
            "html" => {
                self.traverse_html(root, bytes, &mut imports);
            }
            "css" | "scss" => {
                self.traverse_css(root, bytes, &mut imports);
            }
            _ => {}
        }

        Ok(imports)
    }

    // ==========================================
    // JavaScript / TypeScript
    // ==========================================
    fn traverse_javascript(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        match node.kind() {
            "import_statement" => {
                if let Some(imp) = self.extract_js_import_statement(node, source) {
                    imports.push(imp);
                }
            }
            "export_statement" => {
                if let Some(exp) = self.extract_js_export_statement(node, source) {
                    imports.push(exp);
                }
            }
            "call_expression" => {
                if let Some(call) = self.extract_js_call_expression(node, source) {
                    imports.push(call);
                }
            }
            _ => {}
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_javascript(child, source, imports);
        }
    }

    fn extract_js_import_statement(&self, node: Node, source: &[u8]) -> Option<ParsedImport> {
        let source_node = node
            .child_by_field_name("source")
            .or_else(|| self.find_first_child_of_kind(node, "string"))?;

        let specifier = self.strip_quotes(source_node.utf8_text(source).ok()?);
        if specifier.is_empty() {
            return None;
        }

        let node_text = node.utf8_text(source).ok()?;
        let is_type_only = node_text.starts_with("import type")
            || self.has_child_with_kind_and_text(node, source, "type");

        let relationship_kind = if is_type_only {
            RelationshipKind::TypeOnly
        } else {
            RelationshipKind::Import
        };

        let start_pos = node.start_position();
        Some(ParsedImport {
            specifier,
            line: start_pos.row + 1,
            column: start_pos.column + 1,
            relationship_kind,
            is_type_only,
        })
    }

    fn extract_js_export_statement(&self, node: Node, source: &[u8]) -> Option<ParsedImport> {
        let source_node = node
            .child_by_field_name("source")
            .or_else(|| self.find_first_child_of_kind(node, "string"))?;

        let specifier = self.strip_quotes(source_node.utf8_text(source).ok()?);
        if specifier.is_empty() {
            return None;
        }

        let node_text = node.utf8_text(source).ok()?;
        let is_type_only = node_text.starts_with("export type");
        let relationship_kind = if is_type_only {
            RelationshipKind::TypeOnly
        } else {
            RelationshipKind::Export
        };

        let start_pos = node.start_position();
        Some(ParsedImport {
            specifier,
            line: start_pos.row + 1,
            column: start_pos.column + 1,
            relationship_kind,
            is_type_only,
        })
    }

    fn extract_js_call_expression(&self, node: Node, source: &[u8]) -> Option<ParsedImport> {
        let func_node = node.child_by_field_name("function")?;
        let func_text = func_node.utf8_text(source).ok()?;

        let args_node = node.child_by_field_name("arguments")?;
        let arg_string_node = self.find_first_child_of_kind(args_node, "string")?;
        let specifier = self.strip_quotes(arg_string_node.utf8_text(source).ok()?);
        if specifier.is_empty() {
            return None;
        }

        let relationship_kind = if func_text == "require" {
            RelationshipKind::Import
        } else if func_text == "import" || func_node.kind() == "import" {
            RelationshipKind::DynamicImport
        } else {
            return None;
        };

        let start_pos = node.start_position();
        Some(ParsedImport {
            specifier,
            line: start_pos.row + 1,
            column: start_pos.column + 1,
            relationship_kind,
            is_type_only: false,
        })
    }

    // ==========================================
    // Python
    // ==========================================
    fn traverse_python(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        match node.kind() {
            "import_statement" => {
                // e.g. import foo, bar as b
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if child.kind() == "dotted_name" {
                        if let Ok(spec) = child.utf8_text(source) {
                            let start = child.start_position();
                            imports.push(ParsedImport {
                                specifier: spec.to_string(),
                                line: start.row + 1,
                                column: start.column + 1,
                                relationship_kind: RelationshipKind::Import,
                                is_type_only: false,
                            });
                        }
                    } else if child.kind() == "aliased_import" {
                        if let Some(dn) = child.child_by_field_name("name") {
                            if let Ok(spec) = dn.utf8_text(source) {
                                let start = dn.start_position();
                                imports.push(ParsedImport {
                                    specifier: spec.to_string(),
                                    line: start.row + 1,
                                    column: start.column + 1,
                                    relationship_kind: RelationshipKind::Import,
                                    is_type_only: false,
                                });
                            }
                        }
                    }
                }
            }
            "import_from_statement" => {
                // e.g. from foo.bar import baz
                // e.g. from . import local
                // e.g. from ..sub import helper
                let module_name_opt = node
                    .child_by_field_name("module_name")
                    .and_then(|m| m.utf8_text(source).ok().map(|s| s.to_string()));

                let start = node.start_position();
                if let Some(mod_name) = module_name_opt {
                    imports.push(ParsedImport {
                        specifier: mod_name,
                        line: start.row + 1,
                        column: start.column + 1,
                        relationship_kind: RelationshipKind::Import,
                        is_type_only: false,
                    });
                } else {
                    // Check for leading dots in relative imports
                    let node_text = node.utf8_text(source).unwrap_or("");
                    if let Some(from_idx) = node_text.find("from ") {
                        let after_from = &node_text[from_idx + 5..];
                        if let Some(import_idx) = after_from.find(" import") {
                            let raw_mod = after_from[..import_idx].trim();
                            if !raw_mod.is_empty() {
                                imports.push(ParsedImport {
                                    specifier: raw_mod.to_string(),
                                    line: start.row + 1,
                                    column: start.column + 1,
                                    relationship_kind: RelationshipKind::Import,
                                    is_type_only: false,
                                });
                            }
                        }
                    }
                }
            }
            _ => {}
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_python(child, source, imports);
        }
    }

    // ==========================================
    // Rust
    // ==========================================
    fn traverse_rust(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        match node.kind() {
            "mod_item" => {
                // e.g. mod service; or #[path = "..."] mod foo;
                // If it has a body, it's an inline module: mod foo { ... }
                let has_body = node.child_by_field_name("body").is_some();
                if !has_body {
                    if let Some(name_node) = node.child_by_field_name("name") {
                        if let Ok(name) = name_node.utf8_text(source) {
                            let start = node.start_position();
                            imports.push(ParsedImport {
                                specifier: name.to_string(),
                                line: start.row + 1,
                                column: start.column + 1,
                                relationship_kind: RelationshipKind::ModuleDeclaration,
                                is_type_only: false,
                            });
                        }
                    }
                }
            }
            "use_declaration" => {
                // e.g. use crate::service::Client;
                // e.g. use super::utils;
                if let Some(argument) = node.child_by_field_name("argument") {
                    if let Ok(spec) = argument.utf8_text(source) {
                        let clean_spec = spec.trim().trim_end_matches(';').trim();
                        let start = node.start_position();
                        imports.push(ParsedImport {
                            specifier: clean_spec.to_string(),
                            line: start.row + 1,
                            column: start.column + 1,
                            relationship_kind: RelationshipKind::Import,
                            is_type_only: false,
                        });
                    }
                }
            }
            _ => {}
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_rust(child, source, imports);
        }
    }

    // ==========================================
    // Go
    // ==========================================
    fn traverse_go(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        if node.kind() == "import_spec" {
            if let Some(path_node) = node.child_by_field_name("path") {
                if let Ok(raw) = path_node.utf8_text(source) {
                    let specifier = self.strip_quotes(raw);
                    if !specifier.is_empty() {
                        let start = node.start_position();
                        imports.push(ParsedImport {
                            specifier,
                            line: start.row + 1,
                            column: start.column + 1,
                            relationship_kind: RelationshipKind::PackageImport,
                            is_type_only: false,
                        });
                    }
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_go(child, source, imports);
        }
    }

    // ==========================================
    // Java
    // ==========================================
    fn traverse_java(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        if node.kind() == "import_declaration" {
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() == "scoped_identifier" || child.kind() == "identifier" {
                    if let Ok(spec) = child.utf8_text(source) {
                        let is_wildcard = node.utf8_text(source).unwrap_or("").contains(".*");
                        let full_spec = if is_wildcard {
                            format!("{spec}.*")
                        } else {
                            spec.to_string()
                        };
                        let start = node.start_position();
                        imports.push(ParsedImport {
                            specifier: full_spec,
                            line: start.row + 1,
                            column: start.column + 1,
                            relationship_kind: if is_wildcard {
                                RelationshipKind::PackageImport
                            } else {
                                RelationshipKind::Import
                            },
                            is_type_only: false,
                        });
                        break;
                    }
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_java(child, source, imports);
        }
    }

    // ==========================================
    // C and C++
    // ==========================================
    fn traverse_c_cpp(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        if node.kind() == "preproc_include" {
            if let Some(path_node) = node.child_by_field_name("path") {
                if let Ok(raw) = path_node.utf8_text(source) {
                    let trimmed = raw.trim();
                    let specifier = if (trimmed.starts_with('"') && trimmed.ends_with('"'))
                        || (trimmed.starts_with('<') && trimmed.ends_with('>'))
                    {
                        if trimmed.len() >= 2 {
                            trimmed[1..trimmed.len() - 1].to_string()
                        } else {
                            String::new()
                        }
                    } else {
                        trimmed.to_string()
                    };

                    if !specifier.is_empty() {
                        let start = node.start_position();
                        imports.push(ParsedImport {
                            specifier,
                            line: start.row + 1,
                            column: start.column + 1,
                            relationship_kind: RelationshipKind::Include,
                            is_type_only: false,
                        });
                    }
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_c_cpp(child, source, imports);
        }
    }

    // ==========================================
    // C#
    // ==========================================
    fn traverse_csharp(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        if node.kind() == "using_directive" {
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() == "qualified_name" || child.kind() == "identifier" {
                    if let Ok(spec) = child.utf8_text(source) {
                        let start = node.start_position();
                        imports.push(ParsedImport {
                            specifier: spec.to_string(),
                            line: start.row + 1,
                            column: start.column + 1,
                            relationship_kind: RelationshipKind::Import,
                            is_type_only: false,
                        });
                        break;
                    }
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_csharp(child, source, imports);
        }
    }

    // ==========================================
    // Ruby
    // ==========================================
    fn traverse_ruby(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        if node.kind() == "call" {
            if let Some(method_node) = node.child_by_field_name("method") {
                if let Ok(method) = method_node.utf8_text(source) {
                    if method == "require_relative" || method == "require" || method == "load" {
                        if let Some(args) = node.child_by_field_name("arguments") {
                            if let Some(str_node) = self.find_first_child_of_kind(args, "string") {
                                if let Ok(raw) = str_node.utf8_text(source) {
                                    let specifier = self.strip_quotes(raw);
                                    if !specifier.is_empty() {
                                        let start = node.start_position();
                                        imports.push(ParsedImport {
                                            specifier,
                                            line: start.row + 1,
                                            column: start.column + 1,
                                            relationship_kind: RelationshipKind::Require,
                                            is_type_only: false,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_ruby(child, source, imports);
        }
    }

    // ==========================================
    // PHP
    // ==========================================
    fn traverse_php(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        match node.kind() {
            "include_expression"
            | "require_expression"
            | "include_once_expression"
            | "require_once_expression" => {
                if let Some(str_node) = self
                    .find_first_child_of_kind(node, "string")
                    .or_else(|| self.find_first_child_of_kind(node, "encapsed_string"))
                {
                    if let Ok(raw) = str_node.utf8_text(source) {
                        let specifier = self.strip_quotes(raw);
                        if !specifier.is_empty() {
                            let start = node.start_position();
                            imports.push(ParsedImport {
                                specifier,
                                line: start.row + 1,
                                column: start.column + 1,
                                relationship_kind: RelationshipKind::Require,
                                is_type_only: false,
                            });
                        }
                    }
                }
            }
            "namespace_use_declaration" => {
                if let Some(clause) = self.find_first_child_of_kind(node, "namespace_use_clause") {
                    if let Ok(spec) = clause.utf8_text(source) {
                        let clean = spec.split(" as ").next().unwrap_or(spec).trim();
                        let start = node.start_position();
                        imports.push(ParsedImport {
                            specifier: clean.to_string(),
                            line: start.row + 1,
                            column: start.column + 1,
                            relationship_kind: RelationshipKind::Import,
                            is_type_only: false,
                        });
                    }
                }
            }
            _ => {}
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_php(child, source, imports);
        }
    }

    // ==========================================
    // Kotlin
    // ==========================================
    fn traverse_kotlin(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        if node.kind() == "import_header" {
            if let Some(id_node) = self.find_first_child_of_kind(node, "identifier") {
                if let Ok(spec) = id_node.utf8_text(source) {
                    let is_wildcard = self
                        .find_first_child_of_kind(node, "wildcard_import")
                        .is_some();
                    let full_spec = if is_wildcard {
                        format!("{spec}.*")
                    } else {
                        spec.to_string()
                    };
                    let start = node.start_position();
                    imports.push(ParsedImport {
                        specifier: full_spec,
                        line: start.row + 1,
                        column: start.column + 1,
                        relationship_kind: if is_wildcard {
                            RelationshipKind::PackageImport
                        } else {
                            RelationshipKind::Import
                        },
                        is_type_only: false,
                    });
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_kotlin(child, source, imports);
        }
    }

    // ==========================================
    // Swift
    // ==========================================
    fn traverse_swift(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        if node.kind() == "import_declaration" {
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() == "identifier" {
                    if let Ok(spec) = child.utf8_text(source) {
                        let start = node.start_position();
                        imports.push(ParsedImport {
                            specifier: spec.to_string(),
                            line: start.row + 1,
                            column: start.column + 1,
                            relationship_kind: RelationshipKind::Import,
                            is_type_only: false,
                        });
                        break;
                    }
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_swift(child, source, imports);
        }
    }

    // ==========================================
    // Lua
    // ==========================================
    fn traverse_lua(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        if node.kind() == "function_call" {
            let func_name = node
                .child_by_field_name("prefix")
                .or_else(|| node.child_by_field_name("name"))
                .or_else(|| self.find_first_child_of_kind(node, "identifier"))
                .and_then(|n| n.utf8_text(source).ok());

            if func_name == Some("require") {
                let str_node = self
                    .find_first_child_of_kind(node, "arguments")
                    .and_then(|args| self.find_first_child_of_kind(args, "string"))
                    .or_else(|| self.find_first_child_of_kind(node, "string"));

                if let Some(snode) = str_node {
                    if let Ok(raw) = snode.utf8_text(source) {
                        let specifier = self.strip_quotes(raw);
                        if !specifier.is_empty() {
                            let start = node.start_position();
                            imports.push(ParsedImport {
                                specifier,
                                line: start.row + 1,
                                column: start.column + 1,
                                relationship_kind: RelationshipKind::Require,
                                is_type_only: false,
                            });
                        }
                    }
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_lua(child, source, imports);
        }
    }

    // ==========================================
    // Scala
    // ==========================================
    fn traverse_scala(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        if node.kind() == "import_declaration" {
            if let Ok(text) = node.utf8_text(source) {
                let trimmed = text.trim();
                if let Some(spec) = trimmed.strip_prefix("import") {
                    let clean = spec.trim().trim_end_matches(';').trim();
                    if !clean.is_empty() {
                        let start = node.start_position();
                        imports.push(ParsedImport {
                            specifier: clean.to_string(),
                            line: start.row + 1,
                            column: start.column + 1,
                            relationship_kind: RelationshipKind::Import,
                            is_type_only: false,
                        });
                    }
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_scala(child, source, imports);
        }
    }

    // ==========================================
    // Elixir
    // ==========================================
    fn traverse_elixir(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        if node.kind() == "call" {
            let func_name = node
                .child_by_field_name("target")
                .or_else(|| self.find_first_child_of_kind(node, "identifier"))
                .and_then(|n| n.utf8_text(source).ok());

            if let Some(tname) = func_name {
                if tname == "alias" || tname == "import" || tname == "require" {
                    if let Some(args) = node
                        .child_by_field_name("arguments")
                        .or_else(|| self.find_first_child_of_kind(node, "arguments"))
                    {
                        if let Ok(arg_text) = args.utf8_text(source) {
                            let spec = arg_text
                                .trim()
                                .trim_start_matches('(')
                                .trim_end_matches(')')
                                .trim();
                            if !spec.is_empty() {
                                let start = node.start_position();
                                imports.push(ParsedImport {
                                    specifier: spec.to_string(),
                                    line: start.row + 1,
                                    column: start.column + 1,
                                    relationship_kind: RelationshipKind::Import,
                                    is_type_only: false,
                                });
                            }
                        }
                    }
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_elixir(child, source, imports);
        }
    }

    // ==========================================
    // Haskell
    // ==========================================
    fn traverse_haskell(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        if node.kind() == "import" {
            if let Some(mod_node) = self.find_first_child_of_kind(node, "module") {
                if let Ok(spec) = mod_node.utf8_text(source) {
                    let start = node.start_position();
                    imports.push(ParsedImport {
                        specifier: spec.to_string(),
                        line: start.row + 1,
                        column: start.column + 1,
                        relationship_kind: RelationshipKind::Import,
                        is_type_only: false,
                    });
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_haskell(child, source, imports);
        }
    }

    // ==========================================
    // R
    // ==========================================
    fn traverse_r(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        if node.kind() == "call" {
            if let Some(fn_node) = self.find_first_child_of_kind(node, "identifier") {
                if let Ok(fname) = fn_node.utf8_text(source) {
                    if fname == "source" || fname == "library" || fname == "require" {
                        if let Some(args) = self.find_first_child_of_kind(node, "arguments") {
                            let mut spec_opt = None;
                            let mut cursor = args.walk();
                            for child in args.children(&mut cursor) {
                                if child.kind() == "string" {
                                    spec_opt =
                                        child.utf8_text(source).ok().map(|s| self.strip_quotes(s));
                                    break;
                                } else if child.kind() == "argument" {
                                    if let Some(snode) =
                                        self.find_first_child_of_kind(child, "string")
                                    {
                                        spec_opt = snode
                                            .utf8_text(source)
                                            .ok()
                                            .map(|s| self.strip_quotes(s));
                                        break;
                                    } else if let Some(inode) =
                                        self.find_first_child_of_kind(child, "identifier")
                                    {
                                        spec_opt =
                                            inode.utf8_text(source).ok().map(|s| s.to_string());
                                        break;
                                    }
                                } else if child.kind() == "identifier" {
                                    spec_opt = child.utf8_text(source).ok().map(|s| s.to_string());
                                    break;
                                }
                            }

                            if let Some(spec) = spec_opt {
                                if !spec.is_empty() {
                                    let start = node.start_position();
                                    imports.push(ParsedImport {
                                        specifier: spec,
                                        line: start.row + 1,
                                        column: start.column + 1,
                                        relationship_kind: if fname == "source" {
                                            RelationshipKind::Include
                                        } else {
                                            RelationshipKind::Import
                                        },
                                        is_type_only: false,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_r(child, source, imports);
        }
    }

    // ==========================================
    // Shell / Bash
    // ==========================================
    fn traverse_shell(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        if node.kind() == "command" {
            if let Some(cmd_name) = self.find_first_child_of_kind(node, "command_name") {
                if let Ok(name) = cmd_name.utf8_text(source) {
                    if name == "source" || name == "." {
                        let mut cursor = node.walk();
                        for child in node.children(&mut cursor) {
                            if child.kind() == "word" || child.kind() == "string" {
                                if let Ok(raw) = child.utf8_text(source) {
                                    let spec = self.strip_quotes(raw);
                                    if !spec.is_empty() && spec != name {
                                        let start = node.start_position();
                                        imports.push(ParsedImport {
                                            specifier: spec,
                                            line: start.row + 1,
                                            column: start.column + 1,
                                            relationship_kind: RelationshipKind::Include,
                                            is_type_only: false,
                                        });
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_shell(child, source, imports);
        }
    }

    // ==========================================
    // HTML
    // ==========================================
    fn traverse_html(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        if node.kind() == "element"
            || node.kind() == "script_element"
            || node.kind() == "style_element"
        {
            if let Some(start_tag) = self.find_first_child_of_kind(node, "start_tag") {
                if let Some(tag_name) = self.find_first_child_of_kind(start_tag, "tag_name") {
                    if let Ok(tname) = tag_name.utf8_text(source) {
                        let is_script = tname.eq_ignore_ascii_case("script");
                        let is_link = tname.eq_ignore_ascii_case("link");

                        if is_script || is_link {
                            let mut cursor = start_tag.walk();
                            for child in start_tag.children(&mut cursor) {
                                if child.kind() == "attribute" {
                                    if let Some(attr_name) =
                                        self.find_first_child_of_kind(child, "attribute_name")
                                    {
                                        if let Ok(aname) = attr_name.utf8_text(source) {
                                            if (is_script && aname == "src")
                                                || (is_link && aname == "href")
                                            {
                                                if let Some(val) = self.find_first_child_of_kind(
                                                    child,
                                                    "quoted_attribute_value",
                                                ) {
                                                    if let Ok(raw) = val.utf8_text(source) {
                                                        let spec = self.strip_quotes(raw);
                                                        if !spec.is_empty() {
                                                            let start = child.start_position();
                                                            imports.push(ParsedImport {
                                                                specifier: spec,
                                                                line: start.row + 1,
                                                                column: start.column + 1,
                                                                relationship_kind:
                                                                    RelationshipKind::Import,
                                                                is_type_only: false,
                                                            });
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_html(child, source, imports);
        }
    }

    // ==========================================
    // CSS / SCSS
    // ==========================================
    fn traverse_css(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        if node.kind() == "import_statement" {
            if let Some(str_val) = self.find_first_child_of_kind(node, "string_value") {
                if let Ok(raw) = str_val.utf8_text(source) {
                    let specifier = self.strip_quotes(raw);
                    if !specifier.is_empty() {
                        let start = node.start_position();
                        imports.push(ParsedImport {
                            specifier,
                            line: start.row + 1,
                            column: start.column + 1,
                            relationship_kind: RelationshipKind::Import,
                            is_type_only: false,
                        });
                    }
                }
            } else if let Some(call_node) = self.find_first_child_of_kind(node, "call_expression") {
                if let Some(args) = self.find_first_child_of_kind(call_node, "arguments") {
                    if let Ok(raw) = args.utf8_text(source) {
                        let specifier = self
                            .strip_quotes(raw.trim().trim_start_matches('(').trim_end_matches(')'));
                        if !specifier.is_empty() {
                            let start = node.start_position();
                            imports.push(ParsedImport {
                                specifier,
                                line: start.row + 1,
                                column: start.column + 1,
                                relationship_kind: RelationshipKind::Import,
                                is_type_only: false,
                            });
                        }
                    }
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_css(child, source, imports);
        }
    }

    // ==========================================
    // Utilities
    // ==========================================
    fn strip_quotes(&self, raw: &str) -> String {
        let trimmed = raw.trim();
        if (trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\''))
            || (trimmed.starts_with('`') && trimmed.ends_with('`'))
        {
            if trimmed.len() >= 2 {
                trimmed[1..trimmed.len() - 1].to_string()
            } else {
                String::new()
            }
        } else {
            trimmed.to_string()
        }
    }

    fn find_first_child_of_kind<'a>(&self, node: Node<'a>, kind: &str) -> Option<Node<'a>> {
        let mut cursor = node.walk();
        let hit = node
            .children(&mut cursor)
            .find(|&child| child.kind() == kind);
        hit
    }

    fn has_child_with_kind_and_text(&self, node: Node, source: &[u8], text: &str) -> bool {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Ok(t) = child.utf8_text(source) {
                if t == text {
                    return true;
                }
            }
        }
        false
    }
}

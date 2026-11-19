use prebase_core::model::RelationshipKind;
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
    ts_parser: Parser,
    tsx_parser: Parser,
    js_parser: Parser,
    rs_parser: Parser,
    py_parser: Parser,
}

impl Default for SourceParser {
    fn default() -> Self {
        Self::new()
    }
}

impl SourceParser {
    pub fn new() -> Self {
        let mut ts_parser = Parser::new();
        ts_parser
            .set_language(&tree_sitter_typescript::language_typescript())
            .expect("Failed to load TypeScript language grammar");

        let mut tsx_parser = Parser::new();
        tsx_parser
            .set_language(&tree_sitter_typescript::language_tsx())
            .expect("Failed to load TSX language grammar");

        let mut js_parser = Parser::new();
        js_parser
            .set_language(&tree_sitter_javascript::language())
            .expect("Failed to load JavaScript language grammar");

        let mut rs_parser = Parser::new();
        rs_parser
            .set_language(&tree_sitter_rust::language())
            .expect("Failed to load Rust language grammar");

        let mut py_parser = Parser::new();
        py_parser
            .set_language(&tree_sitter_python::language())
            .expect("Failed to load Python language grammar");

        Self {
            ts_parser,
            tsx_parser,
            js_parser,
            rs_parser,
            py_parser,
        }
    }

    pub fn parse_file(
        &mut self,
        extension: &str,
        source_code: &str,
    ) -> Result<Vec<ParsedImport>, String> {
        self.parse_file_with_diagnostics(extension, source_code)
            .map(|(imps, _)| imps)
    }

    pub fn parse_file_with_diagnostics(
        &mut self,
        extension: &str,
        source_code: &str,
    ) -> Result<(Vec<ParsedImport>, bool), String> {
        let (tree, is_rust, is_python) = match extension {
            ".tsx" | ".jsx" => (
                self.tsx_parser
                    .parse(source_code, None)
                    .ok_or_else(|| "Tree-sitter failed to parse TSX/JSX".to_string())?,
                false,
                false,
            ),
            ".ts" | ".mts" | ".cts" => (
                self.ts_parser
                    .parse(source_code, None)
                    .ok_or_else(|| "Tree-sitter failed to parse TS".to_string())?,
                false,
                false,
            ),
            ".rs" => (
                self.rs_parser
                    .parse(source_code, None)
                    .ok_or_else(|| "Tree-sitter failed to parse Rust".to_string())?,
                true,
                false,
            ),
            ".py" | ".pyi" => (
                self.py_parser
                    .parse(source_code, None)
                    .ok_or_else(|| "Tree-sitter failed to parse Python".to_string())?,
                false,
                true,
            ),
            _ => (
                self.js_parser
                    .parse(source_code, None)
                    .ok_or_else(|| "Tree-sitter failed to parse JS".to_string())?,
                false,
                false,
            ),
        };

        let has_syntax_errors = tree.root_node().has_error();
        let mut imports = Vec::new();
        if is_rust {
            self.traverse_rust_node(tree.root_node(), source_code.as_bytes(), &mut imports);
        } else if is_python {
            self.traverse_python_node(
                tree.root_node(),
                source_code.as_bytes(),
                false,
                &mut imports,
            );
        } else {
            self.traverse_node(tree.root_node(), source_code.as_bytes(), &mut imports);
        }
        Ok((imports, has_syntax_errors))
    }

    fn traverse_node(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        match node.kind() {
            "import_statement" => {
                if let Some(imp) = self.extract_import_statement(node, source) {
                    imports.push(imp);
                }
            }
            "export_statement" => {
                if let Some(exp) = self.extract_export_statement(node, source) {
                    imports.push(exp);
                }
            }
            "call_expression" => {
                if let Some(call) = self.extract_call_expression(node, source) {
                    imports.push(call);
                }
            }
            _ => {}
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.traverse_node(child, source, imports);
        }
    }

    fn extract_import_statement(&self, node: Node, source: &[u8]) -> Option<ParsedImport> {
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

    fn extract_export_statement(&self, node: Node, source: &[u8]) -> Option<ParsedImport> {
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

    fn extract_call_expression(&self, node: Node, source: &[u8]) -> Option<ParsedImport> {
        let func_node = node.child_by_field_name("function")?;
        let func_text = func_node.utf8_text(source).ok()?;

        let args_node = node.child_by_field_name("arguments")?;
        let arg_string_node = self.find_first_child_of_kind(args_node, "string")?;
        let specifier = self.strip_quotes(arg_string_node.utf8_text(source).ok()?);
        if specifier.is_empty() {
            return None;
        }

        let (relationship_kind, _) = if func_text == "require" {
            (RelationshipKind::Import, false)
        } else if func_text == "import" || func_node.kind() == "import" {
            (RelationshipKind::DynamicImport, true)
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

    fn traverse_rust_node(&self, node: Node, source: &[u8], imports: &mut Vec<ParsedImport>) {
        match node.kind() {
            "mod_item" => {
                // If it has a body (e.g. mod tests { ... }), it's an inline module definition,
                // NOT an external file module declaration!
                if node.child_by_field_name("body").is_none() {
                    if let Some(name_node) = node.child_by_field_name("name") {
                        if let Ok(name) = name_node.utf8_text(source) {
                            let mut cursor = node.walk();
                            let is_pub = node
                                .children(&mut cursor)
                                .any(|c| c.kind() == "visibility_modifier");

                            // Check for #[path = "..."] attribute
                            let mut path_attr = None;
                            if let Some(parent) = node.parent() {
                                let mut p_cursor = parent.walk();
                                for sibling in parent.children(&mut p_cursor) {
                                    if sibling.end_position() <= node.start_position()
                                        && sibling.kind() == "attribute_item"
                                    {
                                        if let Ok(attr_text) = sibling.utf8_text(source) {
                                            if attr_text.contains("path") {
                                                if let Some(start) = attr_text.find('"') {
                                                    if let Some(end) =
                                                        attr_text[start + 1..].find('"')
                                                    {
                                                        path_attr = Some(
                                                            attr_text[start + 1..start + 1 + end]
                                                                .to_string(),
                                                        );
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            let specifier = if let Some(p) = path_attr {
                                format!("mod {name}#[path={p}]")
                            } else {
                                format!("mod {name}")
                            };

                            let start = node.start_position();
                            imports.push(ParsedImport {
                                specifier,
                                line: start.row + 1,
                                column: start.column + 1,
                                relationship_kind: if is_pub {
                                    RelationshipKind::Export
                                } else {
                                    RelationshipKind::Import
                                },
                                is_type_only: false,
                            });
                        }
                    }
                }
            }
            "use_declaration" => {
                let mut cursor = node.walk();
                let is_pub = node
                    .children(&mut cursor)
                    .any(|c| c.kind() == "visibility_modifier");
                if let Some(arg) = node.child_by_field_name("argument") {
                    self.extract_rust_use_nodes(arg, source, "", is_pub, imports);
                }
            }
            _ => {
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    self.traverse_rust_node(child, source, imports);
                }
            }
        }
    }

    fn extract_rust_use_nodes(
        &self,
        node: Node,
        source: &[u8],
        prefix: &str,
        is_pub: bool,
        imports: &mut Vec<ParsedImport>,
    ) {
        match node.kind() {
            "use_as_clause" => {
                if let Some(path_node) = node.child_by_field_name("path") {
                    self.extract_rust_use_nodes(path_node, source, prefix, is_pub, imports);
                }
            }
            "scoped_use_list" => {
                let base_path = node
                    .child_by_field_name("path")
                    .and_then(|p| p.utf8_text(source).ok())
                    .unwrap_or("");
                let new_prefix = if prefix.is_empty() {
                    format!("{base_path}::")
                } else {
                    format!("{prefix}{base_path}::")
                };
                if let Some(list_node) = node.child_by_field_name("list") {
                    self.extract_rust_use_nodes(list_node, source, &new_prefix, is_pub, imports);
                }
            }
            "use_list" => {
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if child.kind() != "{" && child.kind() != "}" && child.kind() != "," {
                        self.extract_rust_use_nodes(child, source, prefix, is_pub, imports);
                    }
                }
            }
            "scoped_identifier" | "identifier" | "use_wildcard" => {
                if let Ok(text) = node.utf8_text(source) {
                    let full_spec = format!("{prefix}{text}");
                    let start = node.start_position();
                    imports.push(ParsedImport {
                        specifier: full_spec,
                        line: start.row + 1,
                        column: start.column + 1,
                        relationship_kind: if is_pub {
                            RelationshipKind::Export
                        } else {
                            RelationshipKind::Import
                        },
                        is_type_only: false,
                    });
                }
            }
            _ => {
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    self.extract_rust_use_nodes(child, source, prefix, is_pub, imports);
                }
            }
        }
    }

    fn traverse_python_node(
        &self,
        node: Node,
        source: &[u8],
        is_type_checking: bool,
        imports: &mut Vec<ParsedImport>,
    ) {
        match node.kind() {
            "if_statement" => {
                let cond_text = node
                    .child_by_field_name("condition")
                    .and_then(|c| c.utf8_text(source).ok())
                    .unwrap_or("");
                let is_tc = is_type_checking
                    || cond_text == "TYPE_CHECKING"
                    || cond_text.ends_with(".TYPE_CHECKING");

                if let Some(consequence) = node.child_by_field_name("consequence") {
                    self.traverse_python_node(consequence, source, is_tc, imports);
                }
                if let Some(alternative) = node.child_by_field_name("alternative") {
                    self.traverse_python_node(alternative, source, is_type_checking, imports);
                }
            }
            "import_statement" => {
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    let (spec_opt, pos) = match child.kind() {
                        "dotted_name" => (
                            child.utf8_text(source).ok().map(|s| s.to_string()),
                            child.start_position(),
                        ),
                        "aliased_import" => {
                            let name_node = child.child_by_field_name("name");
                            (
                                name_node
                                    .and_then(|n| n.utf8_text(source).ok())
                                    .map(|s| s.to_string()),
                                child.start_position(),
                            )
                        }
                        _ => (None, child.start_position()),
                    };
                    if let Some(spec) = spec_opt {
                        if !spec.is_empty() {
                            imports.push(ParsedImport {
                                specifier: spec,
                                line: pos.row + 1,
                                column: pos.column + 1,
                                relationship_kind: if is_type_checking {
                                    RelationshipKind::TypeOnly
                                } else {
                                    RelationshipKind::Import
                                },
                                is_type_only: is_type_checking,
                            });
                        }
                    }
                }
            }
            "import_from_statement" => {
                let start_pos = node.start_position();
                let mut prefix = String::new();
                let mut module_name = String::new();

                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if child.kind() == "relative_import" {
                        if let Ok(rel_text) = child.utf8_text(source) {
                            prefix = rel_text.to_string();
                        }
                    } else if child.kind() == "dotted_name"
                        && module_name.is_empty()
                        && prefix.is_empty()
                    {
                        if let Ok(name_text) = child.utf8_text(source) {
                            module_name = name_text.to_string();
                        }
                    }
                }

                let base_specifier = if !prefix.is_empty() {
                    prefix
                } else {
                    module_name
                };

                if !base_specifier.is_empty() {
                    let mut imported_names = Vec::new();
                    let mut cursor2 = node.walk();
                    let mut found_import_kw = false;
                    for child in node.children(&mut cursor2) {
                        if child.kind() == "import" {
                            found_import_kw = true;
                            continue;
                        }
                        if found_import_kw {
                            match child.kind() {
                                "dotted_name" => {
                                    if let Ok(t) = child.utf8_text(source) {
                                        imported_names.push(t.to_string());
                                    }
                                }
                                "aliased_import" => {
                                    if let Some(n) = child.child_by_field_name("name") {
                                        if let Ok(t) = n.utf8_text(source) {
                                            imported_names.push(t.to_string());
                                        }
                                    }
                                }
                                "identifier" => {
                                    if let Ok(t) = child.utf8_text(source) {
                                        imported_names.push(t.to_string());
                                    }
                                }
                                _ => {}
                            }
                        }
                    }

                    if imported_names.is_empty() {
                        imports.push(ParsedImport {
                            specifier: base_specifier,
                            line: start_pos.row + 1,
                            column: start_pos.column + 1,
                            relationship_kind: if is_type_checking {
                                RelationshipKind::TypeOnly
                            } else {
                                RelationshipKind::Import
                            },
                            is_type_only: is_type_checking,
                        });
                    } else {
                        for sym in imported_names {
                            let combined = if base_specifier == "." || base_specifier == ".." {
                                format!("{base_specifier}{sym}")
                            } else {
                                format!("{base_specifier}:{sym}")
                            };
                            imports.push(ParsedImport {
                                specifier: combined,
                                line: start_pos.row + 1,
                                column: start_pos.column + 1,
                                relationship_kind: if is_type_checking {
                                    RelationshipKind::TypeOnly
                                } else {
                                    RelationshipKind::Import
                                },
                                is_type_only: is_type_checking,
                            });
                        }
                    }
                }
            }
            _ => {
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    self.traverse_python_node(child, source, is_type_checking, imports);
                }
            }
        }
    }

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

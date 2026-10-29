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

        Self {
            ts_parser,
            tsx_parser,
            js_parser,
        }
    }

    pub fn parse_file(
        &mut self,
        extension: &str,
        source_code: &str,
    ) -> Result<Vec<ParsedImport>, String> {
        let tree = match extension {
            ".tsx" | ".jsx" => self
                .tsx_parser
                .parse(source_code, None)
                .ok_or_else(|| "Tree-sitter failed to parse TSX/JSX".to_string())?,
            ".ts" | ".mts" | ".cts" => self
                .ts_parser
                .parse(source_code, None)
                .ok_or_else(|| "Tree-sitter failed to parse TS".to_string())?,
            _ => self
                .js_parser
                .parse(source_code, None)
                .ok_or_else(|| "Tree-sitter failed to parse JS".to_string())?,
        };

        let mut imports = Vec::new();
        self.traverse_node(tree.root_node(), source_code.as_bytes(), &mut imports);
        Ok(imports)
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
        // e.g. import { a } from "./b";
        // e.g. import "./side-effect";
        // e.g. import type { Foo } from "./types";
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
            line: start_pos.row + 1, // 1-based line
            column: start_pos.column + 1,
            relationship_kind,
            is_type_only,
        })
    }

    fn extract_export_statement(&self, node: Node, source: &[u8]) -> Option<ParsedImport> {
        // e.g. export { a } from "./b";
        // e.g. export * from "./b";
        // e.g. export type * from "./types";
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
        // Check for require("...") or import("...")
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

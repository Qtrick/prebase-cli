pub mod graph;
pub mod index;
pub mod model;
pub mod scanner;

pub use graph::CanonicalGraph;
pub use index::{FileInspection, GraphIndex};
pub use model::*;
pub use scanner::{DiscoveredFile, RepositoryScanner, ScanError, ScanOutput, ScannerConfig};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_directional_edge_semantics_and_indexing() {
        let mut graph = CanonicalGraph::new();

        // A imports B, B imports C
        // A -> B, B -> C
        let node_a = FileNode {
            id: "src/a.ts".into(),
            relative_path: "src/a.ts".into(),
            filename: "a.ts".into(),
            language: "typescript".into(),
            size_bytes: 100,
            file_kind: FileKind::Source,
            analysis_status: NodeAnalysisStatus::Analyzed,
            direct_dependency_count: 0,
            direct_dependent_count: 0,
        };
        let node_b = FileNode {
            id: "src/b.ts".into(),
            relative_path: "src/b.ts".into(),
            filename: "b.ts".into(),
            language: "typescript".into(),
            size_bytes: 200,
            file_kind: FileKind::Source,
            analysis_status: NodeAnalysisStatus::Analyzed,
            direct_dependency_count: 0,
            direct_dependent_count: 0,
        };
        let node_c = FileNode {
            id: "src/c.ts".into(),
            relative_path: "src/c.ts".into(),
            filename: "c.ts".into(),
            language: "typescript".into(),
            size_bytes: 300,
            file_kind: FileKind::Source,
            analysis_status: NodeAnalysisStatus::Analyzed,
            direct_dependency_count: 0,
            direct_dependent_count: 0,
        };

        graph.add_node(node_a);
        graph.add_node(node_b);
        graph.add_node(node_c);

        let evidence_ab = DependencyEvidence {
            source_file_id: "src/a.ts".into(),
            import_specifier: "./b".into(),
            line: 1,
            column: 1,
            relationship_kind: RelationshipKind::Import,
            is_type_only: false,
        };
        graph.add_evidence_or_edge(
            "src/a.ts",
            "src/b.ts",
            evidence_ab,
            RelationshipKind::Import,
            ResolutionStatus::ResolvedInternal,
        );

        let evidence_bc = DependencyEvidence {
            source_file_id: "src/b.ts".into(),
            import_specifier: "./c".into(),
            line: 2,
            column: 1,
            relationship_kind: RelationshipKind::Import,
            is_type_only: false,
        };
        graph.add_evidence_or_edge(
            "src/b.ts",
            "src/c.ts",
            evidence_bc,
            RelationshipKind::Import,
            ResolutionStatus::ResolvedInternal,
        );

        let snapshot = graph.build_snapshot("test-repo", 1, AnalysisCoverage::default());
        assert_eq!(snapshot.schema_version, "1.0.0");
        assert_eq!(snapshot.nodes.len(), 3);
        assert_eq!(snapshot.edges.len(), 2);

        // Check node A: depends on B (1 dependency, 0 dependents)
        let a = snapshot.nodes.iter().find(|n| n.id == "src/a.ts").unwrap();
        assert_eq!(a.direct_dependency_count, 1);
        assert_eq!(a.direct_dependent_count, 0);

        // Check node B: imports C, imported by A (1 dependency, 1 dependent)
        let b = snapshot.nodes.iter().find(|n| n.id == "src/b.ts").unwrap();
        assert_eq!(b.direct_dependency_count, 1);
        assert_eq!(b.direct_dependent_count, 1);

        // Check node C: imported by B (0 dependencies, 1 dependent)
        let c = snapshot.nodes.iter().find(|n| n.id == "src/c.ts").unwrap();
        assert_eq!(c.direct_dependency_count, 0);
        assert_eq!(c.direct_dependent_count, 1);

        // Index testing
        let index = GraphIndex::build(&snapshot);
        let deps_of_a = index.get_dependencies("src/a.ts");
        assert_eq!(deps_of_a.len(), 1);
        assert_eq!(deps_of_a[0].id, "src/b.ts");

        let dependents_of_b = index.get_dependents("src/b.ts");
        assert_eq!(dependents_of_b.len(), 1);
        assert_eq!(dependents_of_b[0].id, "src/a.ts");

        let inspection_b = index.inspect_file("src/b.ts").unwrap();
        assert_eq!(inspection_b.dependencies.len(), 1);
        assert_eq!(inspection_b.dependencies[0].id, "src/c.ts");
        assert_eq!(inspection_b.dependents.len(), 1);
        assert_eq!(inspection_b.dependents[0].id, "src/a.ts");
    }

    #[test]
    fn test_edge_evidence_deduplication() {
        let mut graph = CanonicalGraph::new();
        graph.add_node(FileNode {
            id: "src/main.ts".into(),
            relative_path: "src/main.ts".into(),
            filename: "main.ts".into(),
            language: "typescript".into(),
            size_bytes: 100,
            file_kind: FileKind::Source,
            analysis_status: NodeAnalysisStatus::Analyzed,
            direct_dependency_count: 0,
            direct_dependent_count: 0,
        });
        graph.add_node(FileNode {
            id: "src/util.ts".into(),
            relative_path: "src/util.ts".into(),
            filename: "util.ts".into(),
            language: "typescript".into(),
            size_bytes: 100,
            file_kind: FileKind::Source,
            analysis_status: NodeAnalysisStatus::Analyzed,
            direct_dependency_count: 0,
            direct_dependent_count: 0,
        });

        // Add import at line 1
        graph.add_evidence_or_edge(
            "src/main.ts",
            "src/util.ts",
            DependencyEvidence {
                source_file_id: "src/main.ts".into(),
                import_specifier: "./util".into(),
                line: 1,
                column: 1,
                relationship_kind: RelationshipKind::TypeOnly,
                is_type_only: true,
            },
            RelationshipKind::TypeOnly,
            ResolutionStatus::ResolvedInternal,
        );

        // Add exact duplicate of line 1 (must be deduplicated)
        graph.add_evidence_or_edge(
            "src/main.ts",
            "src/util.ts",
            DependencyEvidence {
                source_file_id: "src/main.ts".into(),
                import_specifier: "./util".into(),
                line: 1,
                column: 1,
                relationship_kind: RelationshipKind::TypeOnly,
                is_type_only: true,
            },
            RelationshipKind::TypeOnly,
            ResolutionStatus::ResolvedInternal,
        );

        // Add second evidence at the same line/col but different semantic kind (Import vs TypeOnly)
        // This also escalates the edge kind from TypeOnly to Import
        graph.add_evidence_or_edge(
            "src/main.ts",
            "src/util.ts",
            DependencyEvidence {
                source_file_id: "src/main.ts".into(),
                import_specifier: "./util".into(),
                line: 1,
                column: 1,
                relationship_kind: RelationshipKind::Import,
                is_type_only: false,
            },
            RelationshipKind::Import,
            ResolutionStatus::ResolvedInternal,
        );

        // Add third import to the same target at line 5
        graph.add_evidence_or_edge(
            "src/main.ts",
            "src/util.ts",
            DependencyEvidence {
                source_file_id: "src/main.ts".into(),
                import_specifier: "./util".into(),
                line: 5,
                column: 1,
                relationship_kind: RelationshipKind::Export,
                is_type_only: false,
            },
            RelationshipKind::Export,
            ResolutionStatus::ResolvedInternal,
        );

        let snapshot = graph.build_snapshot("test-repo", 1, AnalysisCoverage::default());
        // Must produce exactly 1 edge with 3 distinct evidence entries
        assert_eq!(snapshot.edges.len(), 1);
        let edge = &snapshot.edges[0];
        // Edge kind must be escalated to Import (highest precedence: Import > Export > DynamicImport > TypeOnly)
        assert_eq!(edge.relationship_kind, RelationshipKind::Import);
        assert_eq!(edge.evidence.len(), 3);
        assert_eq!(edge.evidence[0].line, 1);
        assert_eq!(
            edge.evidence[0].relationship_kind,
            RelationshipKind::TypeOnly
        );
        assert_eq!(edge.evidence[1].line, 1);
        assert_eq!(edge.evidence[1].relationship_kind, RelationshipKind::Import);
        assert_eq!(edge.evidence[2].line, 5);
        assert_eq!(edge.evidence[2].relationship_kind, RelationshipKind::Export);
    }

    #[test]
    fn test_edge_relationship_escalation_full_hierarchy() {
        let mut graph = CanonicalGraph::new();
        graph.add_node(FileNode {
            id: "src/a.ts".into(),
            relative_path: "src/a.ts".into(),
            filename: "a.ts".into(),
            language: "typescript".into(),
            size_bytes: 100,
            file_kind: FileKind::Source,
            analysis_status: NodeAnalysisStatus::Analyzed,
            direct_dependency_count: 0,
            direct_dependent_count: 0,
        });
        graph.add_node(FileNode {
            id: "src/b.ts".into(),
            relative_path: "src/b.ts".into(),
            filename: "b.ts".into(),
            language: "typescript".into(),
            size_bytes: 100,
            file_kind: FileKind::Source,
            analysis_status: NodeAnalysisStatus::Analyzed,
            direct_dependency_count: 0,
            direct_dependent_count: 0,
        });

        // Step 1: Start at base priority 1: TypeOnly
        graph.add_evidence_or_edge(
            "src/a.ts",
            "src/b.ts",
            DependencyEvidence {
                source_file_id: "src/a.ts".into(),
                import_specifier: "./b".into(),
                line: 1,
                column: 1,
                relationship_kind: RelationshipKind::TypeOnly,
                is_type_only: true,
            },
            RelationshipKind::TypeOnly,
            ResolutionStatus::ResolvedInternal,
        );
        let snap1 = graph.build_snapshot("test", 1, AnalysisCoverage::default());
        assert_eq!(snap1.edges[0].relationship_kind, RelationshipKind::TypeOnly);

        // Step 2: Escalate to priority 2: DynamicImport
        graph.add_evidence_or_edge(
            "src/a.ts",
            "src/b.ts",
            DependencyEvidence {
                source_file_id: "src/a.ts".into(),
                import_specifier: "./b".into(),
                line: 2,
                column: 5,
                relationship_kind: RelationshipKind::DynamicImport,
                is_type_only: false,
            },
            RelationshipKind::DynamicImport,
            ResolutionStatus::ResolvedInternal,
        );
        let snap2 = graph.build_snapshot("test", 2, AnalysisCoverage::default());
        assert_eq!(
            snap2.edges[0].relationship_kind,
            RelationshipKind::DynamicImport
        );

        // Step 3: Escalate to priority 3: Export
        graph.add_evidence_or_edge(
            "src/a.ts",
            "src/b.ts",
            DependencyEvidence {
                source_file_id: "src/a.ts".into(),
                import_specifier: "./b".into(),
                line: 3,
                column: 1,
                relationship_kind: RelationshipKind::Export,
                is_type_only: false,
            },
            RelationshipKind::Export,
            ResolutionStatus::ResolvedInternal,
        );
        let snap3 = graph.build_snapshot("test", 3, AnalysisCoverage::default());
        assert_eq!(snap3.edges[0].relationship_kind, RelationshipKind::Export);

        // Step 4: Escalate to priority 4: Import (highest precedence)
        graph.add_evidence_or_edge(
            "src/a.ts",
            "src/b.ts",
            DependencyEvidence {
                source_file_id: "src/a.ts".into(),
                import_specifier: "./b".into(),
                line: 4,
                column: 1,
                relationship_kind: RelationshipKind::Import,
                is_type_only: false,
            },
            RelationshipKind::Import,
            ResolutionStatus::ResolvedInternal,
        );
        let snap4 = graph.build_snapshot("test", 4, AnalysisCoverage::default());
        assert_eq!(snap4.edges[0].relationship_kind, RelationshipKind::Import);

        // Step 5: Invariance against downgrades: adding lower priority kinds must NOT downgrade Import
        graph.add_evidence_or_edge(
            "src/a.ts",
            "src/b.ts",
            DependencyEvidence {
                source_file_id: "src/a.ts".into(),
                import_specifier: "./b".into(),
                line: 10,
                column: 1,
                relationship_kind: RelationshipKind::TypeOnly,
                is_type_only: true,
            },
            RelationshipKind::TypeOnly,
            ResolutionStatus::ResolvedInternal,
        );
        let snap5 = graph.build_snapshot("test", 5, AnalysisCoverage::default());
        assert_eq!(snap5.edges[0].relationship_kind, RelationshipKind::Import);

        // Step 6: Parity verification with add_edge method
        let mut graph2 = CanonicalGraph::new();
        graph2.add_node(snap1.nodes[0].clone());
        graph2.add_node(snap1.nodes[1].clone());

        graph2.add_edge(DependencyEdge {
            id: String::new(),
            source_file_id: "src/a.ts".into(),
            target_file_id: "src/b.ts".into(),
            relationship_kind: RelationshipKind::TypeOnly,
            resolution_status: ResolutionStatus::ResolvedInternal,
            evidence: vec![DependencyEvidence {
                source_file_id: "src/a.ts".into(),
                import_specifier: "./b".into(),
                line: 1,
                column: 1,
                relationship_kind: RelationshipKind::TypeOnly,
                is_type_only: true,
            }],
        });
        graph2.add_edge(DependencyEdge {
            id: String::new(),
            source_file_id: "src/a.ts".into(),
            target_file_id: "src/b.ts".into(),
            relationship_kind: RelationshipKind::Import,
            resolution_status: ResolutionStatus::ResolvedInternal,
            evidence: vec![DependencyEvidence {
                source_file_id: "src/a.ts".into(),
                import_specifier: "./b".into(),
                line: 2,
                column: 1,
                relationship_kind: RelationshipKind::Import,
                is_type_only: false,
            }],
        });
        let snap_g2 = graph2.build_snapshot("test2", 1, AnalysisCoverage::default());
        assert_eq!(snap_g2.edges.len(), 1);
        assert_eq!(snap_g2.edges[0].relationship_kind, RelationshipKind::Import);
        assert_eq!(snap_g2.edges[0].evidence.len(), 2);
    }

    #[test]
    fn test_search_ranking() {
        let mut graph = CanonicalGraph::new();
        for path in &[
            "src/components/Button.tsx",
            "src/components/ButtonRow.tsx",
            "src/utils/buttons.ts",
            "src/core/app.ts",
        ] {
            graph.add_node(FileNode {
                id: path.to_string(),
                relative_path: path.to_string(),
                filename: path.split('/').next_back().unwrap().to_string(),
                language: "typescript".into(),
                size_bytes: 50,
                file_kind: FileKind::Source,
                analysis_status: NodeAnalysisStatus::Analyzed,
                direct_dependency_count: 0,
                direct_dependent_count: 0,
            });
        }
        let snapshot = graph.build_snapshot("test", 1, AnalysisCoverage::default());
        let index = GraphIndex::build(&snapshot);

        let results = index.search_files("Button.tsx", 10);
        assert!(!results.is_empty());
        assert_eq!(results[0].filename, "Button.tsx");

        let prefix_results = index.search_files("Button", 10);
        assert_eq!(prefix_results.len(), 3); // Button.tsx, ButtonRow.tsx, buttons.ts
    }
}

use prebase_core::model::{
    AnalysisCoverage, DependencyEdge, DependencyPathResult, FileKind, FileNode, GraphSnapshot,
    NodeAnalysisStatus, PathDirection, RelationshipKind, ResolutionStatus,
};
use prebase_core::{find_dependency_path, GraphIndex};

fn make_node(id: &str) -> FileNode {
    FileNode {
        id: id.to_string(),
        relative_path: id.to_string(),
        filename: id.rsplit('/').next().unwrap_or(id).to_string(),
        language: "typescript".to_string(),
        size_bytes: 100,
        file_kind: FileKind::Source,
        analysis_status: NodeAnalysisStatus::Analyzed,
        direct_dependency_count: 0,
        direct_dependent_count: 0,
    }
}

fn make_edge(src: &str, tgt: &str, is_type: bool) -> DependencyEdge {
    DependencyEdge {
        id: DependencyEdge::make_edge_id(src, tgt),
        source_file_id: src.to_string(),
        target_file_id: tgt.to_string(),
        relationship_kind: if is_type {
            RelationshipKind::TypeOnly
        } else {
            RelationshipKind::Import
        },
        resolution_status: ResolutionStatus::ResolvedInternal,
        evidence: vec![],
    }
}

fn make_index(nodes: Vec<FileNode>, edges: Vec<DependencyEdge>) -> GraphIndex {
    let snapshot = GraphSnapshot {
        schema_version: prebase_core::model::CURRENT_SCHEMA_VERSION.to_string(),
        repository_id: "test-repo".to_string(),
        revision: 1,
        nodes,
        edges,
        coverage: AnalysisCoverage::default(),
        issues: vec![],
        insights: None,
    };
    GraphIndex::build(&snapshot)
}

/// DPE-01: Empty graph returns MissingEndpoint or NotFound
#[test]
fn test_dpe_01_empty_graph_returns_missing_endpoint_or_not_found() {
    let index = make_index(vec![], vec![]);

    let res_outgoing = index.find_path("src/a.ts", "src/b.ts", PathDirection::Outgoing, true);
    assert!(
        matches!(
            res_outgoing,
            DependencyPathResult::MissingEndpoint(_) | DependencyPathResult::NotFound
        ),
        "Expected MissingEndpoint or NotFound on empty graph, got {:?}",
        res_outgoing
    );

    let res_incoming = index.find_path("src/b.ts", "src/a.ts", PathDirection::Incoming, true);
    assert!(
        matches!(
            res_incoming,
            DependencyPathResult::MissingEndpoint(_) | DependencyPathResult::NotFound
        ),
        "Expected MissingEndpoint or NotFound on empty graph with incoming direction, got {:?}",
        res_incoming
    );

    // Also test free function
    let res_fn = find_dependency_path(
        &index,
        "src/a.ts",
        "src/b.ts",
        PathDirection::Outgoing,
        true,
    );
    assert!(
        matches!(
            res_fn,
            DependencyPathResult::MissingEndpoint(_) | DependencyPathResult::NotFound
        ),
        "Expected MissingEndpoint or NotFound from find_dependency_path, got {:?}",
        res_fn
    );
}

/// DPE-01: Direct dependency: A -> B returns path [A, B] with 1 edge
#[test]
fn test_dpe_01_direct_dependency_path() {
    let nodes = vec![make_node("src/a.ts"), make_node("src/b.ts")];
    let edges = vec![make_edge("src/a.ts", "src/b.ts", false)];
    let index = make_index(nodes, edges);

    let result = index.find_path("src/a.ts", "src/b.ts", PathDirection::Outgoing, true);

    match result {
        DependencyPathResult::Found(path) => {
            assert_eq!(path.nodes, vec!["src/a.ts", "src/b.ts"]);
            assert_eq!(path.edges.len(), 1);
            assert_eq!(path.edges[0].source_file_id, "src/a.ts");
            assert_eq!(path.edges[0].target_file_id, "src/b.ts");
            assert_eq!(path.hops, 1);
            assert!(!path.is_type_only);
        }
        other => panic!("Expected DependencyPathResult::Found, got {:?}", other),
    }
}

/// DPE-01: Indirect dependency chain: A -> B -> C -> D returns path [A, B, C, D] with 3 edges
#[test]
fn test_dpe_01_indirect_dependency_chain() {
    let nodes = vec![
        make_node("src/a.ts"),
        make_node("src/b.ts"),
        make_node("src/c.ts"),
        make_node("src/d.ts"),
    ];
    let edges = vec![
        make_edge("src/a.ts", "src/b.ts", false),
        make_edge("src/b.ts", "src/c.ts", false),
        make_edge("src/c.ts", "src/d.ts", false),
    ];
    let index = make_index(nodes, edges);

    let result = index.find_path("src/a.ts", "src/d.ts", PathDirection::Outgoing, true);

    match result {
        DependencyPathResult::Found(path) => {
            assert_eq!(
                path.nodes,
                vec!["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]
            );
            assert_eq!(path.edges.len(), 3);
            assert_eq!(path.hops, 3);
            assert_eq!(path.edges[0].source_file_id, "src/a.ts");
            assert_eq!(path.edges[0].target_file_id, "src/b.ts");
            assert_eq!(path.edges[1].source_file_id, "src/b.ts");
            assert_eq!(path.edges[1].target_file_id, "src/c.ts");
            assert_eq!(path.edges[2].source_file_id, "src/c.ts");
            assert_eq!(path.edges[2].target_file_id, "src/d.ts");
        }
        other => panic!("Expected DependencyPathResult::Found, got {:?}", other),
    }
}

/// DPE-01: Direction "incoming" (used by): D is used by A -> returns [A, B, C, D]
#[test]
fn test_dpe_01_direction_incoming_used_by() {
    let nodes = vec![
        make_node("src/a.ts"),
        make_node("src/b.ts"),
        make_node("src/c.ts"),
        make_node("src/d.ts"),
    ];
    let edges = vec![
        make_edge("src/a.ts", "src/b.ts", false),
        make_edge("src/b.ts", "src/c.ts", false),
        make_edge("src/c.ts", "src/d.ts", false),
    ];
    let index = make_index(nodes, edges);

    // D is used by A: query from D to A with Incoming direction
    let result = index.find_path("src/d.ts", "src/a.ts", PathDirection::Incoming, true);

    match result {
        DependencyPathResult::Found(path) => {
            assert_eq!(
                path.nodes,
                vec!["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
                "Incoming query 'D is used by A' must return dependency path [A, B, C, D]"
            );
            assert_eq!(path.edges.len(), 3);
            assert_eq!(path.hops, 3);
            assert_eq!(path.edges[0].source_file_id, "src/a.ts");
            assert_eq!(path.edges[0].target_file_id, "src/b.ts");
            assert_eq!(path.edges[1].source_file_id, "src/b.ts");
            assert_eq!(path.edges[1].target_file_id, "src/c.ts");
            assert_eq!(path.edges[2].source_file_id, "src/c.ts");
            assert_eq!(path.edges[2].target_file_id, "src/d.ts");
        }
        other => panic!("Expected DependencyPathResult::Found, got {:?}", other),
    }
}

/// DPE-02: Shorter vs longer path: A -> B -> D (2 hops) and A -> C -> E -> D (3 hops).
/// BFS must return the shortest path (2 hops).
#[test]
fn test_dpe_02_bfs_returns_shortest_path() {
    let nodes = vec![
        make_node("src/a.ts"),
        make_node("src/b.ts"),
        make_node("src/c.ts"),
        make_node("src/d.ts"),
        make_node("src/e.ts"),
    ];
    let edges = vec![
        // Shorter path: A -> B -> D (2 hops)
        make_edge("src/a.ts", "src/b.ts", false),
        make_edge("src/b.ts", "src/d.ts", false),
        // Longer path: A -> C -> E -> D (3 hops)
        make_edge("src/a.ts", "src/c.ts", false),
        make_edge("src/c.ts", "src/e.ts", false),
        make_edge("src/e.ts", "src/d.ts", false),
    ];
    let index = make_index(nodes, edges);

    let result = index.find_path("src/a.ts", "src/d.ts", PathDirection::Outgoing, true);

    match result {
        DependencyPathResult::Found(path) => {
            assert_eq!(
                path.hops, 2,
                "BFS must return the shortest path with 2 hops, got {}",
                path.hops
            );
            assert_eq!(
                path.nodes,
                vec!["src/a.ts", "src/b.ts", "src/d.ts"],
                "Shortest path must traverse [A, B, D]"
            );
            assert_eq!(path.edges.len(), 2);
        }
        other => panic!("Expected DependencyPathResult::Found, got {:?}", other),
    }
}

/// DPE-02: Cycle safe: A -> B -> C -> A, and A -> D.
/// Path A -> D must succeed without infinite loop.
#[test]
fn test_dpe_02_cycle_safety_terminates_and_finds_path() {
    let nodes = vec![
        make_node("src/a.ts"),
        make_node("src/b.ts"),
        make_node("src/c.ts"),
        make_node("src/d.ts"),
    ];
    let edges = vec![
        // Cycle: A -> B -> C -> A
        make_edge("src/a.ts", "src/b.ts", false),
        make_edge("src/b.ts", "src/c.ts", false),
        make_edge("src/c.ts", "src/a.ts", false),
        // Branch to target: A -> D
        make_edge("src/a.ts", "src/d.ts", false),
    ];
    let index = make_index(nodes, edges);

    let result = index.find_path("src/a.ts", "src/d.ts", PathDirection::Outgoing, true);

    match result {
        DependencyPathResult::Found(path) => {
            assert_eq!(path.nodes, vec!["src/a.ts", "src/d.ts"]);
            assert_eq!(path.hops, 1);
            assert_eq!(path.edges.len(), 1);
        }
        other => panic!("Expected DependencyPathResult::Found, got {:?}", other),
    }

    // Path from C to D via cycle (C -> A -> D)
    let res_cycle = index.find_path("src/c.ts", "src/d.ts", PathDirection::Outgoing, true);
    match res_cycle {
        DependencyPathResult::Found(path) => {
            assert_eq!(path.nodes, vec!["src/c.ts", "src/a.ts", "src/d.ts"]);
            assert_eq!(path.hops, 2);
        }
        other => panic!("Expected DependencyPathResult::Found, got {:?}", other),
    }
}

/// DPE-02: Type-only filtering: A -> B (type-only) -> C.
/// With include_types = false, path from A to C is NotFound.
/// With include_types = true, path is Found.
#[test]
fn test_dpe_02_type_only_filtering() {
    let nodes = vec![
        make_node("src/a.ts"),
        make_node("src/b.ts"),
        make_node("src/c.ts"),
    ];
    let edges = vec![
        make_edge("src/a.ts", "src/b.ts", true),  // TypeOnly edge
        make_edge("src/b.ts", "src/c.ts", false), // Runtime Import edge
    ];
    let index = make_index(nodes, edges);

    // 1. With include_types = false: path must NOT be found
    let res_without_types = index.find_path("src/a.ts", "src/c.ts", PathDirection::Outgoing, false);
    assert_eq!(
        res_without_types,
        DependencyPathResult::NotFound,
        "With include_types = false, path across type-only edge must return NotFound"
    );

    // 2. With include_types = true: path must be found
    let res_with_types = index.find_path("src/a.ts", "src/c.ts", PathDirection::Outgoing, true);
    match res_with_types {
        DependencyPathResult::Found(path) => {
            assert_eq!(path.nodes, vec!["src/a.ts", "src/b.ts", "src/c.ts"]);
            assert_eq!(path.hops, 2);
            assert_eq!(path.edges.len(), 2);
        }
        other => panic!("Expected DependencyPathResult::Found, got {:?}", other),
    }
}

/// DPE-01: Same file: A to A returns SameFile with 0 hops
#[test]
fn test_dpe_01_same_file_returns_same_file_with_zero_hops() {
    let nodes = vec![make_node("src/a.ts")];
    let edges = vec![];
    let index = make_index(nodes, edges);

    let result = index.find_path("src/a.ts", "src/a.ts", PathDirection::Outgoing, true);

    match &result {
        DependencyPathResult::SameFile { file_id, hops } => {
            assert_eq!(file_id, "src/a.ts");
            assert_eq!(*hops, 0, "SameFile must have 0 hops");
        }
        other => panic!("Expected DependencyPathResult::SameFile, got {:?}", other),
    }
    assert_eq!(result.hops(), 0);
}

/// DPE-01: Disconnected components: A -> B and C -> D. Query A to D returns NotFound.
#[test]
fn test_dpe_01_disconnected_components_returns_not_found() {
    let nodes = vec![
        make_node("src/a.ts"),
        make_node("src/b.ts"),
        make_node("src/c.ts"),
        make_node("src/d.ts"),
    ];
    let edges = vec![
        make_edge("src/a.ts", "src/b.ts", false),
        make_edge("src/c.ts", "src/d.ts", false),
    ];
    let index = make_index(nodes, edges);

    let result = index.find_path("src/a.ts", "src/d.ts", PathDirection::Outgoing, true);
    assert_eq!(
        result,
        DependencyPathResult::NotFound,
        "Path between disconnected components must return NotFound"
    );

    let result_incoming = index.find_path("src/d.ts", "src/a.ts", PathDirection::Incoming, true);
    assert_eq!(
        result_incoming,
        DependencyPathResult::NotFound,
        "Incoming path between disconnected components must return NotFound"
    );
}

/// Additional behavioral coverage: Endpoint existence validation
#[test]
fn test_dpe_endpoint_not_in_graph_returns_missing_endpoint() {
    let nodes = vec![make_node("src/a.ts")];
    let edges = vec![];
    let index = make_index(nodes, edges);

    let res1 = index.find_path(
        "src/a.ts",
        "src/nonexistent.ts",
        PathDirection::Outgoing,
        true,
    );
    assert_eq!(
        res1,
        DependencyPathResult::MissingEndpoint("src/nonexistent.ts".to_string())
    );

    let res2 = index.find_path(
        "src/nonexistent.ts",
        "src/a.ts",
        PathDirection::Outgoing,
        true,
    );
    assert_eq!(
        res2,
        DependencyPathResult::MissingEndpoint("src/nonexistent.ts".to_string())
    );
}

use rand::seq::SliceRandom;
use rand::SeedableRng;
use std::collections::HashSet;

use prebase_core::model::{
    AnalysisCoverage, CycleClassification, DependencyEdge, FileKind, FileNode, GraphSnapshot,
    NodeAnalysisStatus, RelationshipKind, ResolutionStatus,
};
use prebase_core::{analyze_file_impact, detect_cycles, GraphIndex};

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

fn make_snapshot(nodes: Vec<FileNode>, edges: Vec<DependencyEdge>) -> GraphSnapshot {
    GraphSnapshot {
        schema_version: prebase_core::model::CURRENT_SCHEMA_VERSION.to_string(),
        repository_id: "test-repo".to_string(),
        revision: 1,
        nodes,
        edges,
        coverage: AnalysisCoverage::default(),
        issues: vec![],
        insights: None,
    }
}

// ---------------------------------------------------------------------------
// AI-01: Self-loop cycle classification
// ---------------------------------------------------------------------------

#[test]
fn test_ai_01_runtime_self_loop_classification() {
    let nodes = vec![make_node("src/self.ts")];
    let edges = vec![make_edge("src/self.ts", "src/self.ts", false)];

    let (cycles, total_files) = detect_cycles(&nodes, &edges);

    assert_eq!(
        cycles.len(),
        1,
        "Must detect exactly 1 cycle group for self-loop"
    );
    assert_eq!(total_files, 1, "Must count exactly 1 total cycle file");

    let cycle = &cycles[0];
    assert_eq!(
        cycle.files,
        vec!["src/self.ts"],
        "files must contain only the self-looping node"
    );
    assert_eq!(
        cycle.edge_count, 1,
        "Self-loop has exactly 1 edge inside the SCC"
    );
    assert!(
        !cycle.is_type_only,
        "Runtime self-loop must have is_type_only = false"
    );
    assert_eq!(
        cycle.classification,
        CycleClassification::RuntimeRelevant,
        "Runtime self-loop must be classified as RuntimeRelevant"
    );
    assert_eq!(
        cycle.example_cycle,
        vec!["src/self.ts", "src/self.ts"],
        "example_cycle must form a valid loop [src/self.ts, src/self.ts]"
    );
}

#[test]
fn test_ai_01_type_only_self_loop_classification() {
    let nodes = vec![make_node("src/type_self.ts")];
    let edges = vec![make_edge("src/type_self.ts", "src/type_self.ts", true)];

    let (cycles, total_files) = detect_cycles(&nodes, &edges);

    assert_eq!(
        cycles.len(),
        1,
        "Must detect exactly 1 cycle group for type self-loop"
    );
    assert_eq!(total_files, 1, "Must count exactly 1 total cycle file");

    let cycle = &cycles[0];
    assert_eq!(cycle.files, vec!["src/type_self.ts"]);
    assert_eq!(
        cycle.edge_count, 1,
        "Type-only self-loop has exactly 1 edge inside the SCC"
    );
    assert!(
        cycle.is_type_only,
        "Type-only self-loop must have is_type_only = true"
    );
    assert_eq!(
        cycle.classification,
        CycleClassification::TypeOnly,
        "Type-only self-loop must be classified as TypeOnly"
    );
    assert_eq!(
        cycle.example_cycle,
        vec!["src/type_self.ts", "src/type_self.ts"]
    );
}

// ---------------------------------------------------------------------------
// AI-02: Mixed runtime and type cycle classification
// ---------------------------------------------------------------------------

#[test]
fn test_ai_02_mixed_runtime_and_type_cycle_classified_as_mixed_structural() {
    // A imports B at runtime, B imports A only as a type.
    // There is NO runtime-only cycle because traversing only runtime edges dead-ends at B.
    // Classification must be MixedStructural, not RuntimeRelevant.
    let nodes = vec![make_node("src/a.ts"), make_node("src/b.ts")];
    let edges = vec![
        make_edge("src/a.ts", "src/b.ts", false), // runtime
        make_edge("src/b.ts", "src/a.ts", true),  // type-only
    ];

    let (cycles, total_files) = detect_cycles(&nodes, &edges);

    assert_eq!(cycles.len(), 1);
    assert_eq!(total_files, 2);

    let cycle = &cycles[0];
    assert_eq!(cycle.files, vec!["src/a.ts", "src/b.ts"]);
    assert_eq!(cycle.edge_count, 2);
    assert!(
        !cycle.is_type_only,
        "Cycle contains runtime edge, so is_type_only is false"
    );
    assert_eq!(
        cycle.classification,
        CycleClassification::MixedStructural,
        "SCC with no runtime-only subcycle must be classified as MixedStructural, not RuntimeRelevant"
    );
}

#[test]
fn test_ai_02_scc_with_runtime_cycle_and_auxiliary_type_edge_is_runtime_relevant() {
    // A -> B (runtime), B -> C (runtime), C -> A (runtime).
    // Plus an auxiliary type edge: A -> B (or C -> B type-only).
    // Because a pure runtime cycle (A -> B -> C -> A) exists, classification must be RuntimeRelevant.
    let nodes = vec![
        make_node("src/a.ts"),
        make_node("src/b.ts"),
        make_node("src/c.ts"),
    ];
    let edges = vec![
        make_edge("src/a.ts", "src/b.ts", false), // runtime
        make_edge("src/b.ts", "src/c.ts", false), // runtime
        make_edge("src/c.ts", "src/a.ts", false), // runtime
        make_edge("src/a.ts", "src/c.ts", true),  // type-only auxiliary
    ];

    let (cycles, total_files) = detect_cycles(&nodes, &edges);

    assert_eq!(cycles.len(), 1);
    assert_eq!(total_files, 3);

    let cycle = &cycles[0];
    assert_eq!(cycle.files, vec!["src/a.ts", "src/b.ts", "src/c.ts"]);
    assert!(!cycle.is_type_only);
    assert_eq!(
        cycle.classification,
        CycleClassification::RuntimeRelevant,
        "SCC containing a pure runtime cycle must be classified as RuntimeRelevant"
    );
}

// ---------------------------------------------------------------------------
// AI-03: Example cycle path validity
// ---------------------------------------------------------------------------

#[test]
fn test_ai_03_example_cycle_contains_only_real_directed_edges() {
    // In an SCC where sorted node order differs from actual edges:
    // Sorted: [A, B, C]
    // Actual directed edges: A -> C -> B -> A
    // (A -> B does NOT exist, B -> C does NOT exist)
    let nodes = vec![
        make_node("src/a.ts"),
        make_node("src/b.ts"),
        make_node("src/c.ts"),
    ];
    let edges = vec![
        make_edge("src/a.ts", "src/c.ts", false),
        make_edge("src/c.ts", "src/b.ts", false),
        make_edge("src/b.ts", "src/a.ts", false),
    ];

    let edge_set: HashSet<(&str, &str)> = edges
        .iter()
        .map(|e| (e.source_file_id.as_str(), e.target_file_id.as_str()))
        .collect();

    let (cycles, _) = detect_cycles(&nodes, &edges);
    assert_eq!(cycles.len(), 1);

    let example = &cycles[0].example_cycle;
    assert!(
        example.len() >= 2,
        "Example cycle must contain at least 2 nodes"
    );
    assert_eq!(
        example.first(),
        example.last(),
        "Example cycle must start and end on the same node"
    );

    // Verify EVERY consecutive pair is a canonical edge in the graph
    for window in example.windows(2) {
        let (u, v) = (window[0].as_str(), window[1].as_str());
        assert!(
            edge_set.contains(&(u, v)),
            "Fabricated edge detected in example_cycle: {u} -> {v} does not exist in graph!"
        );
    }
}

#[test]
fn test_ai_03_example_cycle_in_4_node_shuffled_directed_order() {
    // A -> D -> B -> C -> A
    // Lexicographical: A, B, C, D
    let nodes = vec![
        make_node("src/a.ts"),
        make_node("src/b.ts"),
        make_node("src/c.ts"),
        make_node("src/d.ts"),
    ];
    let edges = vec![
        make_edge("src/a.ts", "src/d.ts", false),
        make_edge("src/d.ts", "src/b.ts", false),
        make_edge("src/b.ts", "src/c.ts", false),
        make_edge("src/c.ts", "src/a.ts", false),
    ];

    let edge_set: HashSet<(&str, &str)> = edges
        .iter()
        .map(|e| (e.source_file_id.as_str(), e.target_file_id.as_str()))
        .collect();

    let (cycles, _) = detect_cycles(&nodes, &edges);
    assert_eq!(cycles.len(), 1);

    let example = &cycles[0].example_cycle;
    assert_eq!(example.first(), example.last());

    for window in example.windows(2) {
        let (u, v) = (window[0].as_str(), window[1].as_str());
        assert!(
            edge_set.contains(&(u, v)),
            "Fabricated edge in 4-node cycle: {u} -> {v}"
        );
    }
}

// ---------------------------------------------------------------------------
// AI-04: SCC determinism under edge and node shuffling
// ---------------------------------------------------------------------------

#[test]
fn test_ai_04_scc_determinism_under_edge_and_node_permutations() {
    // Construct a multi-SCC graph with branching cycles in an SCC:
    // SCC 1: cycle with branching paths:
    //   A -> B -> A and A -> C -> A (both are valid cycles involving A)
    // SCC 2: cycle D -> E -> F -> D
    // SCC 3: self-loop G -> G
    let nodes = vec![
        make_node("src/a.ts"),
        make_node("src/b.ts"),
        make_node("src/c.ts"),
        make_node("src/d.ts"),
        make_node("src/e.ts"),
        make_node("src/f.ts"),
        make_node("src/g.ts"),
    ];
    let edges = vec![
        make_edge("src/a.ts", "src/b.ts", false),
        make_edge("src/b.ts", "src/a.ts", false),
        make_edge("src/a.ts", "src/c.ts", false),
        make_edge("src/c.ts", "src/a.ts", false),
        make_edge("src/d.ts", "src/e.ts", false),
        make_edge("src/e.ts", "src/f.ts", false),
        make_edge("src/f.ts", "src/d.ts", false),
        make_edge("src/g.ts", "src/g.ts", false),
    ];

    let (baseline_cycles, baseline_total) = detect_cycles(&nodes, &edges);
    assert_eq!(baseline_cycles.len(), 3);

    // Test across 20 distinct pseudo-random shuffles of both nodes and edges
    for seed in 0..20u64 {
        let mut rng = rand::rngs::StdRng::seed_from_u64(seed + 42);

        let mut shuffled_nodes = nodes.clone();
        shuffled_nodes.shuffle(&mut rng);

        let mut shuffled_edges = edges.clone();
        shuffled_edges.shuffle(&mut rng);

        let (shuffled_cycles, shuffled_total) = detect_cycles(&shuffled_nodes, &shuffled_edges);

        assert_eq!(
            shuffled_total, baseline_total,
            "Total cycle file count must be invariant to shuffling (seed {seed})"
        );
        assert_eq!(
            shuffled_cycles.len(),
            baseline_cycles.len(),
            "Cycle group count must be invariant to shuffling (seed {seed})"
        );

        for (i, (shuffled, baseline)) in shuffled_cycles.iter().zip(&baseline_cycles).enumerate() {
            assert_eq!(
                shuffled.id, baseline.id,
                "Cycle group id at index {i} changed from {} to {} under seed {seed}",
                baseline.id, shuffled.id
            );
            assert_eq!(
                shuffled.files, baseline.files,
                "File list for group {} changed under seed {seed}",
                baseline.id
            );
            assert_eq!(
                shuffled.example_cycle, baseline.example_cycle,
                "Example cycle path for group {} changed from {:?} to {:?} under seed {seed}",
                baseline.id, baseline.example_cycle, shuffled.example_cycle
            );
            assert_eq!(
                shuffled.edge_count, baseline.edge_count,
                "Edge count for group {} changed under seed {seed}",
                baseline.id
            );
            assert_eq!(
                shuffled.is_type_only, baseline.is_type_only,
                "is_type_only for group {} changed under seed {seed}",
                baseline.id
            );
            assert_eq!(
                shuffled.classification, baseline.classification,
                "classification for group {} changed under seed {seed}",
                baseline.id
            );
        }
    }
}

// ---------------------------------------------------------------------------
// IMP-01 & IMP-02: Downstream impact analysis boundaries
// ---------------------------------------------------------------------------

#[test]
fn test_imp_01_dense_hub_impact_enforces_bounds_does_not_leak_all_dependents() {
    // Target file has 200 direct dependents.
    // When analyze_impact is called, impacted_files must NOT exceed the max limit (100).
    let target = make_node("src/target.ts");
    let mut nodes = vec![target.clone()];
    let mut edges = Vec::new();

    for i in 0..200 {
        let dep_id = format!("src/dep_{i}.ts");
        nodes.push(make_node(&dep_id));
        // dep_i imports target
        edges.push(make_edge(&dep_id, "src/target.ts", false));
    }

    // Test on GraphIndex
    let snapshot = make_snapshot(nodes.clone(), edges.clone());
    let index = GraphIndex::build(&snapshot);

    let index_impact = index
        .analyze_impact("src/target.ts", 5)
        .expect("Impact analysis on GraphIndex must succeed");

    assert_eq!(
        index_impact.direct_dependents_count, 200,
        "Direct dependents count reflects full incoming edges"
    );
    assert!(
        index_impact.impacted_files.len() <= 100,
        "impacted_files length ({}) must not exceed max bound of 100 for dense hub!",
        index_impact.impacted_files.len()
    );
    assert!(
        index_impact.total_impact_count <= 100,
        "total_impact_count ({}) must not exceed max bound of 100!",
        index_impact.total_impact_count
    );

    // Test on insights::analyze_file_impact with max_files = 100
    let insights_impact = analyze_file_impact("src/target.ts", &nodes, &edges, &[], 5, 100)
        .expect("analyze_file_impact must succeed");

    assert!(
        insights_impact.impacted_files.len() <= 100,
        "insights analyze_file_impact impacted_files ({}) must not exceed max_files (100)!",
        insights_impact.impacted_files.len()
    );
    assert!(
        insights_impact.total_impact_count <= 100,
        "insights analyze_file_impact total_impact_count ({}) must not exceed max_files (100)!",
        insights_impact.total_impact_count
    );
}

#[test]
fn test_imp_02_self_loop_impact_counts_zero_dependents() {
    // Target file imports itself and has no other dependents.
    // Self-import must NOT be counted as a dependent of itself.
    let target = make_node("src/solo.ts");
    let nodes = vec![target];
    let edges = vec![make_edge("src/solo.ts", "src/solo.ts", false)];

    let snapshot = make_snapshot(nodes.clone(), edges.clone());
    let index = GraphIndex::build(&snapshot);

    let index_impact = index
        .analyze_impact("src/solo.ts", 5)
        .expect("Impact analysis must succeed");

    assert_eq!(
        index_impact.direct_dependents_count, 0,
        "Self-loop must not count as direct dependent of itself"
    );
    assert_eq!(
        index_impact.transitive_dependents_count, 0,
        "Self-loop has 0 transitive dependents"
    );
    assert_eq!(
        index_impact.total_impact_count, 0,
        "Self-loop has 0 total impact count"
    );
    assert!(
        index_impact.impacted_files.is_empty(),
        "Self-loop impacted_files must be empty"
    );

    // Test on insights::analyze_file_impact
    let insights_impact = analyze_file_impact("src/solo.ts", &nodes, &edges, &[], 5, 100)
        .expect("analyze_file_impact must succeed");

    assert_eq!(
        insights_impact.direct_dependents_count, 0,
        "insights: Self-loop direct_dependents_count must be 0"
    );
    assert_eq!(
        insights_impact.total_impact_count, 0,
        "insights: Self-loop total_impact_count must be 0"
    );
    assert!(
        insights_impact.impacted_files.is_empty(),
        "insights: Self-loop impacted_files must be empty"
    );
}

// ---------------------------------------------------------------------------
// IMP-03: Diamond graph type classification
// ---------------------------------------------------------------------------

#[test]
fn test_imp_03_diamond_graph_with_independent_runtime_path_is_not_type_only() {
    // Target -> A (type-only), Target -> B (runtime)
    // C imports both A and B.
    // C has two paths from Target:
    //   Path 1: Target -> A (type) -> C (runtime) => type-only path
    //   Path 2: Target -> B (runtime) -> C (runtime) => runtime path
    // Since an independent runtime path exists, C must have is_type_only = false,
    // regardless of whether edge (A, C) or (B, C) is encountered first.
    let nodes = vec![
        make_node("src/target.ts"),
        make_node("src/a.ts"),
        make_node("src/b.ts"),
        make_node("src/c.ts"),
    ];

    // Case 1: A edge appears first in edge list, and A->C is type-only
    let edges_a_first = vec![
        make_edge("src/a.ts", "src/target.ts", true), // A imports Target (type-only)
        make_edge("src/b.ts", "src/target.ts", false), // B imports Target (runtime)
        make_edge("src/c.ts", "src/a.ts", true),      // C imports A (type-only)
        make_edge("src/c.ts", "src/b.ts", false),     // C imports B (runtime)
    ];

    let snap_a = make_snapshot(nodes.clone(), edges_a_first.clone());
    let idx_a = GraphIndex::build(&snap_a);
    let impact_a = idx_a
        .analyze_impact("src/target.ts", 5)
        .expect("analyze_impact must succeed");

    let c_item_a = impact_a
        .impacted_files
        .iter()
        .find(|item| item.file_id == "src/c.ts")
        .expect("c.ts must be impacted");

    assert!(
        !c_item_a.is_type_only,
        "c.ts must have is_type_only = false when A is processed first because runtime path Target->B->C exists"
    );

    // Case 2: B edge appears first in edge list
    let edges_b_first = vec![
        make_edge("src/b.ts", "src/target.ts", false), // B imports Target (runtime)
        make_edge("src/a.ts", "src/target.ts", true),  // A imports Target (type-only)
        make_edge("src/c.ts", "src/b.ts", false),      // C imports B (runtime)
        make_edge("src/c.ts", "src/a.ts", false),      // C imports A (runtime)
    ];

    let snap_b = make_snapshot(nodes.clone(), edges_b_first.clone());
    let idx_b = GraphIndex::build(&snap_b);
    let impact_b = idx_b
        .analyze_impact("src/target.ts", 5)
        .expect("analyze_impact must succeed");

    let c_item_b = impact_b
        .impacted_files
        .iter()
        .find(|item| item.file_id == "src/c.ts")
        .expect("c.ts must be impacted");

    assert!(
        !c_item_b.is_type_only,
        "c.ts must have is_type_only = false when B is processed first because runtime path Target->B->C exists"
    );
}

#[test]
fn test_imp_03_diamond_graph_all_type_paths_is_type_only() {
    // Target -> A (type-only), Target -> B (type-only)
    // C imports both A and B.
    // Every path from Target to C is type-only.
    // C must have is_type_only = true.
    let nodes = vec![
        make_node("src/target.ts"),
        make_node("src/a.ts"),
        make_node("src/b.ts"),
        make_node("src/c.ts"),
    ];

    let edges = vec![
        make_edge("src/a.ts", "src/target.ts", true), // A imports Target (type-only)
        make_edge("src/b.ts", "src/target.ts", true), // B imports Target (type-only)
        make_edge("src/c.ts", "src/a.ts", false),     // C imports A (runtime)
        make_edge("src/c.ts", "src/b.ts", false),     // C imports B (runtime)
    ];

    let snap = make_snapshot(nodes.clone(), edges.clone());
    let idx = GraphIndex::build(&snap);
    let impact = idx
        .analyze_impact("src/target.ts", 5)
        .expect("analyze_impact must succeed");

    let c_item = impact
        .impacted_files
        .iter()
        .find(|item| item.file_id == "src/c.ts")
        .expect("c.ts must be impacted");

    assert!(
        c_item.is_type_only,
        "c.ts must have is_type_only = true when all paths from Target are type-only"
    );
}

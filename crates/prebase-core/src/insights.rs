use std::collections::{HashMap, HashSet, VecDeque};

use crate::model::{
    AnalysisCoverage, AnalysisIssue, ArchitecturalInsights, AreaCoupling, ConnectedArea,
    CycleGroup, DependencyEdge, DiagnosticsSummary, FileImpactAnalysis, FileNode,
    HighlyDependedFile, ImpactItem, NodeAnalysisStatus, RelationshipKind, ResolutionStatus,
};

/// Resolves a relative path to its canonical architectural area identifier.
/// Keeps 100% parity with frontend `getAreaIdForPath` in `repositoryAreas.ts`.
pub fn get_area_id_for_path(relative_path: &str) -> String {
    let clean = relative_path.replace('\\', "/");
    let parts: Vec<&str> = clean.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() <= 1 {
        return "(root)".to_string();
    }

    let first = parts[0];

    // 1. Monorepo and workspace root packages (crates/*, packages/*, apps/*, libs/*, modules/*)
    if matches!(
        first,
        "crates" | "packages" | "apps" | "libs" | "services" | "modules"
    ) && parts.len() >= 3
    {
        return format!("{}/{}", parts[0], parts[1]);
    }

    // 2. Nested fullstack directories (frontend/src/*, backend/src/*, client/src/*, server/src/*)
    if matches!(first, "frontend" | "backend" | "client" | "server") && parts.len() >= 3 {
        if parts[1] == "src" && parts.len() >= 4 {
            return format!("{}/src/{}", parts[0], parts[2]);
        }
        return format!("{}/{}", parts[0], parts[1]);
    }

    // 3. Standard src/ nested directories (src/components/*, src/utils/*, src/routes/*)
    if first == "src" {
        if parts.len() >= 3 {
            return format!("src/{}", parts[1]);
        }
        return "src".to_string();
    }

    // 4. Test suites
    if matches!(first, "tests" | "test" | "e2e" | "__tests__") {
        return first.to_string();
    }

    // 5. Default 2-level directory grouping
    if parts.len() >= 3 {
        return format!("{}/{}", parts[0], parts[1]);
    }

    first.to_string()
}

/// Computes architectural insights for the canonical graph snapshot.
pub fn compute_architectural_insights(
    nodes: &[FileNode],
    edges: &[DependencyEdge],
    coverage: &AnalysisCoverage,
    issues: &[AnalysisIssue],
) -> ArchitecturalInsights {
    let (cycle_groups, total_cycle_files) = detect_cycles(nodes, edges);
    let highly_depended_files = compute_highly_depended_files(nodes, edges, 10);
    let area_couplings = compute_area_couplings(nodes, edges);
    let diagnostics_summary = compute_diagnostics_summary(nodes, issues, coverage);

    ArchitecturalInsights {
        cycle_groups,
        total_cycle_files,
        highly_depended_files,
        area_couplings,
        diagnostics_summary,
    }
}

/// Detects circular dependency groups using an iterative Tarjan's Strongly Connected Components (SCC) algorithm.
/// Bounded and immune to call-stack overflow on deep graphs.
pub fn detect_cycles(nodes: &[FileNode], edges: &[DependencyEdge]) -> (Vec<CycleGroup>, usize) {
    let internal_edges: Vec<&DependencyEdge> = edges
        .iter()
        .filter(|e| e.resolution_status == ResolutionStatus::ResolvedInternal)
        .collect();

    // Map file IDs to dense integer indices for Tarjan's
    let mut node_ids: Vec<String> = nodes.iter().map(|n| n.id.clone()).collect();
    node_ids.sort(); // Deterministic ordering
    let id_to_idx: HashMap<&str, usize> = node_ids
        .iter()
        .enumerate()
        .map(|(idx, id)| (id.as_str(), idx))
        .collect();

    let n = node_ids.len();
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut self_loops: HashSet<usize> = HashSet::new();

    for edge in &internal_edges {
        if let (Some(&u), Some(&v)) = (
            id_to_idx.get(edge.source_file_id.as_str()),
            id_to_idx.get(edge.target_file_id.as_str()),
        ) {
            if u == v {
                self_loops.insert(u);
            } else if !adj[u].contains(&v) {
                adj[u].push(v);
            }
        }
    }

    // Tarjan's SCC state
    let mut indices: Vec<Option<usize>> = vec![None; n];
    let mut lowlink: Vec<usize> = vec![0; n];
    let mut on_stack: Vec<bool> = vec![false; n];
    let mut stack: Vec<usize> = Vec::with_capacity(n);
    let mut current_index: usize = 0;
    let mut sccs: Vec<Vec<usize>> = Vec::new();

    // Explicit call stack for non-recursive Tarjan's
    for root_node in 0..n {
        if indices[root_node].is_some() {
            continue;
        }

        struct Frame {
            u: usize,
            edge_cursor: usize,
        }

        indices[root_node] = Some(current_index);
        lowlink[root_node] = current_index;
        current_index += 1;
        stack.push(root_node);
        on_stack[root_node] = true;

        let mut call_stack = vec![Frame {
            u: root_node,
            edge_cursor: 0,
        }];

        while let Some(top) = call_stack.last_mut() {
            let u = top.u;
            if top.edge_cursor < adj[u].len() {
                let v = adj[u][top.edge_cursor];
                top.edge_cursor += 1;

                if indices[v].is_none() {
                    // Forward tree edge
                    indices[v] = Some(current_index);
                    lowlink[v] = current_index;
                    current_index += 1;
                    stack.push(v);
                    on_stack[v] = true;
                    call_stack.push(Frame {
                        u: v,
                        edge_cursor: 0,
                    });
                } else if on_stack[v] {
                    // Back edge to an ancestor currently on the stack
                    let v_idx = indices[v].unwrap();
                    if v_idx < lowlink[u] {
                        lowlink[u] = v_idx;
                    }
                }
            } else {
                // Done processing node u
                let finished_u = u;
                call_stack.pop();

                if let Some(parent) = call_stack.last_mut() {
                    let p = parent.u;
                    if lowlink[finished_u] < lowlink[p] {
                        lowlink[p] = lowlink[finished_u];
                    }
                }

                // If finished_u is root of an SCC
                if lowlink[finished_u] == indices[finished_u].unwrap() {
                    let mut scc = Vec::new();
                    while let Some(node) = stack.pop() {
                        on_stack[node] = false;
                        scc.push(node);
                        if node == finished_u {
                            break;
                        }
                    }
                    if scc.len() > 1 || self_loops.contains(&finished_u) {
                        sccs.push(scc);
                    }
                }
            }
        }
    }

    let mut cycle_groups = Vec::new();
    let mut total_cycle_files = 0;

    // Edge lookup for evidence and type-only check: (source, target) -> edge
    let mut edge_map: HashMap<(&str, &str), &DependencyEdge> = HashMap::new();
    for edge in &internal_edges {
        edge_map.insert(
            (edge.source_file_id.as_str(), edge.target_file_id.as_str()),
            edge,
        );
    }

    for (group_idx, scc_indices) in sccs.into_iter().enumerate() {
        let mut files: Vec<String> = scc_indices
            .iter()
            .map(|&idx| node_ids[idx].clone())
            .collect();
        files.sort(); // Deterministic file ordering
        total_cycle_files += files.len();

        let scc_set: HashSet<usize> = scc_indices.iter().copied().collect();

        // Count internal edges inside this cycle group
        let mut group_edge_count = 0;
        let mut all_type_only = true;

        for &u in &scc_indices {
            for &v in &adj[u] {
                if scc_set.contains(&v) {
                    group_edge_count += 1;
                    let u_id = node_ids[u].as_str();
                    let v_id = node_ids[v].as_str();
                    if let Some(edge) = edge_map.get(&(u_id, v_id)) {
                        let is_type = edge.relationship_kind == RelationshipKind::TypeOnly
                            || (!edge.evidence.is_empty()
                                && edge.evidence.iter().all(|e| e.is_type_only));
                        if !is_type {
                            all_type_only = false;
                        }
                    }
                }
            }
        }

        // Extract a bounded, concrete example cycle path using BFS within the SCC subgraph
        let example_cycle = find_example_cycle(&scc_indices, &adj, &node_ids);

        cycle_groups.push(CycleGroup {
            id: format!("cycle-{}", group_idx + 1),
            files,
            example_cycle,
            is_type_only: all_type_only,
            edge_count: group_edge_count,
        });
    }

    // Sort cycle groups deterministically by first file path
    cycle_groups.sort_by(|a, b| a.files.first().cmp(&b.files.first()));

    (cycle_groups, total_cycle_files)
}

/// Finds a minimal example cycle within an SCC subgraph starting from the lexicographically first node.
fn find_example_cycle(
    scc_indices: &[usize],
    adj: &[Vec<usize>],
    node_ids: &[String],
) -> Vec<String> {
    if scc_indices.is_empty() {
        return Vec::new();
    }

    let scc_set: HashSet<usize> = scc_indices.iter().copied().collect();

    // Pick lexicographically smallest node as starting candidate
    let mut sorted_scc = scc_indices.to_vec();
    sorted_scc.sort_by_key(|&idx| &node_ids[idx]);
    let start_node = sorted_scc[0];

    // Check for self-loop first
    if adj[start_node].contains(&start_node) {
        return vec![node_ids[start_node].clone(), node_ids[start_node].clone()];
    }

    // BFS to find shortest path from any outgoing neighbor of start_node back to start_node
    let mut queue = VecDeque::new();
    let mut prev: HashMap<usize, usize> = HashMap::new();
    let mut visited: HashSet<usize> = HashSet::new();

    for &next in &adj[start_node] {
        if scc_set.contains(&next) {
            queue.push_back(next);
            prev.insert(next, start_node);
            visited.insert(next);
        }
    }

    let mut found = false;
    while let Some(curr) = queue.pop_front() {
        if curr == start_node {
            found = true;
            break;
        }

        for &next in &adj[curr] {
            if next == start_node {
                prev.insert(next, curr);
                found = true;
                break;
            }
            if scc_set.contains(&next) && visited.insert(next) {
                prev.insert(next, curr);
                queue.push_back(next);
            }
        }

        if found {
            break;
        }
    }

    if found {
        let mut path = vec![start_node];
        let mut curr = prev.get(&start_node).copied();
        while let Some(p) = curr {
            path.push(p);
            if p == start_node {
                break;
            }
            curr = prev.get(&p).copied();
        }
        path.reverse();
        path.iter().map(|&idx| node_ids[idx].clone()).collect()
    } else {
        // Fallback: list of nodes in SCC
        let mut path: Vec<String> = sorted_scc
            .iter()
            .map(|&idx| node_ids[idx].clone())
            .collect();
        if let Some(first) = path.first().cloned() {
            path.push(first);
        }
        path
    }
}

/// Identifies top files with the most incoming dependencies (dependents).
pub fn compute_highly_depended_files(
    nodes: &[FileNode],
    edges: &[DependencyEdge],
    limit: usize,
) -> Vec<HighlyDependedFile> {
    let mut dependent_counts: HashMap<&str, usize> = HashMap::new();
    let mut dependency_counts: HashMap<&str, usize> = HashMap::new();

    for edge in edges {
        if edge.resolution_status == ResolutionStatus::ResolvedInternal {
            *dependent_counts
                .entry(edge.target_file_id.as_str())
                .or_default() += 1;
            *dependency_counts
                .entry(edge.source_file_id.as_str())
                .or_default() += 1;
        }
    }

    let mut scored: Vec<HighlyDependedFile> = nodes
        .iter()
        .filter_map(|node| {
            let dep_count = dependent_counts.get(node.id.as_str()).copied().unwrap_or(0);
            if dep_count > 0 {
                Some(HighlyDependedFile {
                    file_id: node.id.clone(),
                    relative_path: node.relative_path.clone(),
                    dependent_count: dep_count,
                    dependency_count: dependency_counts
                        .get(node.id.as_str())
                        .copied()
                        .unwrap_or(0),
                })
            } else {
                None
            }
        })
        .collect();

    scored.sort_by(|a, b| {
        b.dependent_count
            .cmp(&a.dependent_count)
            .then_with(|| a.file_id.cmp(&b.file_id))
    });

    scored.truncate(limit);
    scored
}

/// Calculates architectural area coupling and cross-area communication metrics.
pub fn compute_area_couplings(nodes: &[FileNode], edges: &[DependencyEdge]) -> Vec<AreaCoupling> {
    let mut file_to_area: HashMap<&str, String> = HashMap::new();
    let mut area_nodes: HashMap<String, Vec<&FileNode>> = HashMap::new();

    for node in nodes {
        let area_id = get_area_id_for_path(&node.relative_path);
        file_to_area.insert(node.id.as_str(), area_id.clone());
        area_nodes.entry(area_id).or_default().push(node);
    }

    let mut internal_counts: HashMap<String, usize> = HashMap::new();
    let mut outbound_counts: HashMap<String, usize> = HashMap::new();
    let mut inbound_counts: HashMap<String, usize> = HashMap::new();
    let mut area_matrix: HashMap<(String, String), usize> = HashMap::new();

    for edge in edges {
        if edge.resolution_status == ResolutionStatus::ResolvedInternal {
            let src_area = file_to_area.get(edge.source_file_id.as_str());
            let tgt_area = file_to_area.get(edge.target_file_id.as_str());

            if let (Some(src), Some(tgt)) = (src_area, tgt_area) {
                if src == tgt {
                    *internal_counts.entry(src.clone()).or_default() += 1;
                } else {
                    *outbound_counts.entry(src.clone()).or_default() += 1;
                    *inbound_counts.entry(tgt.clone()).or_default() += 1;
                    *area_matrix.entry((src.clone(), tgt.clone())).or_default() += 1;
                }
            }
        }
    }

    let mut area_couplings = Vec::new();
    let mut all_areas: Vec<String> = area_nodes.keys().cloned().collect();
    all_areas.sort();

    for area_id in all_areas {
        let nodes_in_area = &area_nodes[&area_id];
        let file_count = nodes_in_area.len();
        let analyzed_file_count = nodes_in_area
            .iter()
            .filter(|n| {
                matches!(
                    n.analysis_status,
                    NodeAnalysisStatus::Analyzed | NodeAnalysisStatus::PartiallyAnalyzed
                )
            })
            .count();

        let mut connected_areas_map: HashMap<String, (usize, usize)> = HashMap::new();
        for ((s, t), &count) in &area_matrix {
            if s == &area_id {
                connected_areas_map.entry(t.clone()).or_default().0 += count;
            } else if t == &area_id {
                connected_areas_map.entry(s.clone()).or_default().1 += count;
            }
        }

        let mut connected_areas: Vec<ConnectedArea> = connected_areas_map
            .into_iter()
            .map(|(other_area, (out_c, in_c))| ConnectedArea {
                area_id: other_area,
                outbound_count: out_c,
                inbound_count: in_c,
            })
            .collect();

        // Sort by total inter-area communication descending
        connected_areas.sort_by(|a, b| {
            (b.outbound_count + b.inbound_count)
                .cmp(&(a.outbound_count + a.inbound_count))
                .then_with(|| a.area_id.cmp(&b.area_id))
        });

        area_couplings.push(AreaCoupling {
            area_id: area_id.clone(),
            file_count,
            analyzed_file_count,
            internal_edge_count: internal_counts.get(&area_id).copied().unwrap_or(0),
            outbound_edge_count: outbound_counts.get(&area_id).copied().unwrap_or(0),
            inbound_edge_count: inbound_counts.get(&area_id).copied().unwrap_or(0),
            connected_areas,
        });
    }

    // Sort by outbound communication descending
    area_couplings.sort_by(|a, b| {
        b.outbound_edge_count
            .cmp(&a.outbound_edge_count)
            .then_with(|| a.area_id.cmp(&b.area_id))
    });

    area_couplings
}

/// Summarizes diagnostic statistics across analysis issues and node statuses.
pub fn compute_diagnostics_summary(
    nodes: &[FileNode],
    issues: &[AnalysisIssue],
    coverage: &AnalysisCoverage,
) -> DiagnosticsSummary {
    let mut partially_analyzed = 0;
    let mut unsupported = 0;
    let mut failed = 0;

    for node in nodes {
        match node.analysis_status {
            NodeAnalysisStatus::PartiallyAnalyzed => partially_analyzed += 1,
            NodeAnalysisStatus::Unsupported => unsupported += 1,
            NodeAnalysisStatus::Failed => failed += 1,
            _ => {}
        }
    }

    let unresolved_imports = issues
        .iter()
        .filter(|i| {
            i.issue_kind == "UnresolvedImport" || i.issue_kind == "UnresolvedInternalTarget"
        })
        .count();

    DiagnosticsSummary {
        total_discovered: coverage.total_discovered,
        total_analyzed: coverage.total_analyzed,
        total_partially_analyzed: partially_analyzed,
        total_unsupported: unsupported,
        total_failed: failed,
        total_unresolved_imports: unresolved_imports,
        total_issues: issues.len(),
    }
}

/// Computes bounded transitive downstream impact for a file (who depends on this file directly and transitively).
pub fn analyze_file_impact(
    target_file_id: &str,
    nodes: &[FileNode],
    edges: &[DependencyEdge],
    cycle_groups: &[CycleGroup],
    max_depth: usize,
    max_files: usize,
) -> Option<FileImpactAnalysis> {
    let target_node = nodes.iter().find(|n| n.id == target_file_id)?;

    // Map file ID to relative path
    let id_to_path: HashMap<&str, &str> = nodes
        .iter()
        .map(|n| (n.id.as_str(), n.relative_path.as_str()))
        .collect();

    // Inverted adjacency: target -> [sources that import target]
    let mut dependents_adj: HashMap<&str, Vec<(&str, bool)>> = HashMap::new();
    for edge in edges {
        if edge.resolution_status == ResolutionStatus::ResolvedInternal {
            let is_type = edge.relationship_kind == RelationshipKind::TypeOnly
                || (!edge.evidence.is_empty() && edge.evidence.iter().all(|e| e.is_type_only));
            dependents_adj
                .entry(edge.target_file_id.as_str())
                .or_default()
                .push((edge.source_file_id.as_str(), is_type));
        }
    }

    let mut direct_dependents_count = 0;
    let mut visited: HashSet<&str> = HashSet::new();
    visited.insert(target_file_id);

    let mut queue: VecDeque<(&str, usize, bool)> = VecDeque::new();

    if let Some(direct_deps) = dependents_adj.get(target_file_id) {
        direct_dependents_count = direct_deps.len();
        for &(dep_id, is_type) in direct_deps {
            if visited.insert(dep_id) {
                queue.push_back((dep_id, 1, is_type));
            }
        }
    }

    let mut impacted_files = Vec::new();

    while let Some((curr_id, depth, is_type)) = queue.pop_front() {
        if let Some(&rel_path) = id_to_path.get(curr_id) {
            impacted_files.push(ImpactItem {
                file_id: curr_id.to_string(),
                relative_path: rel_path.to_string(),
                depth,
                is_type_only: is_type,
            });
        }

        if impacted_files.len() >= max_files || depth >= max_depth {
            continue;
        }

        if let Some(next_deps) = dependents_adj.get(curr_id) {
            for &(next_id, next_is_type) in next_deps {
                if visited.insert(next_id) {
                    queue.push_back((next_id, depth + 1, is_type && next_is_type));
                }
            }
        }
    }

    let transitive_count = if impacted_files.len() > direct_dependents_count {
        impacted_files.len() - direct_dependents_count
    } else {
        0
    };

    let (is_part_of_cycle, cycle_group_id) = cycle_groups
        .iter()
        .find(|g| g.files.iter().any(|f| f == target_file_id))
        .map(|g| (true, Some(g.id.clone())))
        .unwrap_or((false, None));

    Some(FileImpactAnalysis {
        file_id: target_node.id.clone(),
        direct_dependents_count,
        transitive_dependents_count: transitive_count,
        total_impact_count: impacted_files.len(),
        is_part_of_cycle,
        cycle_group_id,
        impacted_files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::FileKind;

    fn make_node(id: &str) -> FileNode {
        FileNode {
            id: id.to_string(),
            relative_path: id.to_string(),
            filename: id.split('/').next_back().unwrap().to_string(),
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
            id: format!("{src}->{tgt}"),
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

    #[test]
    fn test_acyclic_graph_has_zero_cycle_groups() {
        let nodes = vec![
            make_node("src/a.ts"),
            make_node("src/b.ts"),
            make_node("src/c.ts"),
        ];
        let edges = vec![
            make_edge("src/a.ts", "src/b.ts", false),
            make_edge("src/b.ts", "src/c.ts", false),
        ];
        let (cycles, total_files) = detect_cycles(&nodes, &edges);
        assert_eq!(cycles.len(), 0);
        assert_eq!(total_files, 0);
    }

    #[test]
    fn test_two_file_cycle_detection() {
        let nodes = vec![make_node("src/a.ts"), make_node("src/b.ts")];
        let edges = vec![
            make_edge("src/a.ts", "src/b.ts", false),
            make_edge("src/b.ts", "src/a.ts", false),
        ];
        let (cycles, total_files) = detect_cycles(&nodes, &edges);
        assert_eq!(cycles.len(), 1);
        assert_eq!(total_files, 2);
        assert_eq!(cycles[0].files, vec!["src/a.ts", "src/b.ts"]);
        assert_eq!(
            cycles[0].example_cycle,
            vec!["src/a.ts", "src/b.ts", "src/a.ts"]
        );
        assert!(!cycles[0].is_type_only);
    }

    #[test]
    fn test_three_file_cycle_and_example_path() {
        let nodes = vec![
            make_node("src/a.ts"),
            make_node("src/b.ts"),
            make_node("src/c.ts"),
        ];
        let edges = vec![
            make_edge("src/a.ts", "src/b.ts", false),
            make_edge("src/b.ts", "src/c.ts", false),
            make_edge("src/c.ts", "src/a.ts", false),
        ];
        let (cycles, total_files) = detect_cycles(&nodes, &edges);
        assert_eq!(cycles.len(), 1);
        assert_eq!(total_files, 3);
        assert_eq!(cycles[0].files, vec!["src/a.ts", "src/b.ts", "src/c.ts"]);
        assert_eq!(
            cycles[0].example_cycle,
            vec!["src/a.ts", "src/b.ts", "src/c.ts", "src/a.ts"]
        );
    }

    #[test]
    fn test_self_loop_cycle() {
        let nodes = vec![make_node("src/self.ts")];
        let edges = vec![make_edge("src/self.ts", "src/self.ts", false)];
        let (cycles, total_files) = detect_cycles(&nodes, &edges);
        assert_eq!(cycles.len(), 1);
        assert_eq!(total_files, 1);
        assert_eq!(cycles[0].files, vec!["src/self.ts"]);
        assert_eq!(cycles[0].example_cycle, vec!["src/self.ts", "src/self.ts"]);
    }

    #[test]
    fn test_type_only_cycle_distinction() {
        let nodes = vec![make_node("src/types_a.ts"), make_node("src/types_b.ts")];
        let edges = vec![
            make_edge("src/types_a.ts", "src/types_b.ts", true),
            make_edge("src/types_b.ts", "src/types_a.ts", true),
        ];
        let (cycles, _) = detect_cycles(&nodes, &edges);
        assert_eq!(cycles.len(), 1);
        assert!(
            cycles[0].is_type_only,
            "Cycle composed purely of type-only edges must have is_type_only = true"
        );
    }

    #[test]
    fn test_area_coupling_metrics() {
        let nodes = vec![
            make_node("src/components/Button.tsx"),
            make_node("src/components/Card.tsx"),
            make_node("src/utils/math.ts"),
            make_node("src/api/client.ts"),
        ];
        let edges = vec![
            // internal in src/components
            make_edge(
                "src/components/Card.tsx",
                "src/components/Button.tsx",
                false,
            ),
            // cross-area: components -> utils
            make_edge("src/components/Card.tsx", "src/utils/math.ts", false),
            // cross-area: api -> utils
            make_edge("src/api/client.ts", "src/utils/math.ts", false),
        ];

        let couplings = compute_area_couplings(&nodes, &edges);
        let components_area = couplings
            .iter()
            .find(|c| c.area_id == "src/components")
            .unwrap();
        assert_eq!(components_area.file_count, 2);
        assert_eq!(components_area.internal_edge_count, 1);
        assert_eq!(components_area.outbound_edge_count, 1);
        assert_eq!(components_area.inbound_edge_count, 0);

        let utils_area = couplings.iter().find(|c| c.area_id == "src/utils").unwrap();
        assert_eq!(utils_area.inbound_edge_count, 2);
    }

    #[test]
    fn test_transitive_impact_analysis() {
        // C imports B, B imports A. If A changes, B is directly impacted, C is transitively impacted.
        let nodes = vec![
            make_node("src/a.ts"),
            make_node("src/b.ts"),
            make_node("src/c.ts"),
        ];
        let edges = vec![
            make_edge("src/b.ts", "src/a.ts", false),
            make_edge("src/c.ts", "src/b.ts", false),
        ];

        let impact = analyze_file_impact("src/a.ts", &nodes, &edges, &[], 5, 50)
            .expect("Impact analysis must succeed");

        assert_eq!(impact.direct_dependents_count, 1);
        assert_eq!(impact.transitive_dependents_count, 1);
        assert_eq!(impact.total_impact_count, 2);

        let b_item = impact
            .impacted_files
            .iter()
            .find(|i| i.file_id == "src/b.ts")
            .unwrap();
        assert_eq!(b_item.depth, 1);

        let c_item = impact
            .impacted_files
            .iter()
            .find(|i| i.file_id == "src/c.ts")
            .unwrap();
        assert_eq!(c_item.depth, 2);
    }
}

use std::collections::{HashMap, HashSet, VecDeque};

use crate::model::{
    AnalysisCoverage, AnalysisIssue, ArchitecturalInsights, AreaCoupling, ConnectedArea,
    CycleClassification, CycleGroup, DependencyEdge, DiagnosticsSummary, FileImpactAnalysis,
    FileNode, HighlyDependedFile, ImpactItem, NodeAnalysisStatus, RelationshipKind,
    ResolutionStatus,
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

    // Track whether there is any runtime edge between (u, v)
    let mut runtime_edges: HashSet<(usize, usize)> = HashSet::new();

    for edge in &internal_edges {
        if let (Some(&u), Some(&v)) = (
            id_to_idx.get(edge.source_file_id.as_str()),
            id_to_idx.get(edge.target_file_id.as_str()),
        ) {
            if u == v {
                self_loops.insert(u);
            }
            adj[u].push(v);

            let is_type = edge.relationship_kind == RelationshipKind::TypeOnly
                || (!edge.evidence.is_empty() && edge.evidence.iter().all(|e| e.is_type_only));
            if !is_type {
                runtime_edges.insert((u, v));
            }
        }
    }

    // Sort and deduplicate adj[u] - O(deg log deg) fixing AI-05, also guarantees deterministic neighbor order
    for neighbors in &mut adj {
        neighbors.sort_unstable();
        neighbors.dedup();
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

    // Sort each SCC's internal indices deterministically
    for scc in &mut sccs {
        scc.sort_unstable();
    }

    // Sort SCCs deterministically by their first node ID before assigning cycle-1, cycle-2, etc.
    sccs.sort_by(|a, b| node_ids[a[0]].cmp(&node_ids[b[0]]));

    let mut cycle_groups = Vec::new();
    let mut total_cycle_files = 0;

    for (group_idx, scc_indices) in sccs.into_iter().enumerate() {
        let files: Vec<String> = scc_indices
            .iter()
            .map(|&idx| node_ids[idx].clone())
            .collect();
        total_cycle_files += files.len();

        let scc_set: HashSet<usize> = scc_indices.iter().copied().collect();

        // Count internal edges inside this cycle group and check if all are type-only
        let mut group_edge_count = 0;
        let mut all_type_only = true;

        for &u in &scc_indices {
            for &v in &adj[u] {
                if scc_set.contains(&v) {
                    group_edge_count += 1;
                    if runtime_edges.contains(&(u, v)) {
                        all_type_only = false;
                    }
                }
            }
        }

        let is_type_only = all_type_only;
        let classification = if all_type_only {
            CycleClassification::TypeOnly
        } else if has_runtime_cycle(&scc_indices, &adj, &runtime_edges) {
            CycleClassification::RuntimeRelevant
        } else {
            CycleClassification::MixedStructural
        };

        // Extract a bounded, concrete example cycle path using BFS within the SCC subgraph
        let example_cycle = find_example_cycle(&scc_indices, &adj, &node_ids);

        cycle_groups.push(CycleGroup {
            id: format!("cycle-{}", group_idx + 1),
            files,
            example_cycle,
            is_type_only,
            edge_count: group_edge_count,
            classification,
        });
    }

    (cycle_groups, total_cycle_files)
}

/// Checks if the runtime subgraph within an SCC contains a directed cycle (using Kahn's topological sort).
fn has_runtime_cycle(
    scc_indices: &[usize],
    adj: &[Vec<usize>],
    runtime_edges: &HashSet<(usize, usize)>,
) -> bool {
    let scc_set: HashSet<usize> = scc_indices.iter().copied().collect();

    // 1. Check for runtime self-loop
    for &u in scc_indices {
        if runtime_edges.contains(&(u, u)) {
            return true;
        }
    }

    // 2. Build runtime subgraph within this SCC
    let mut in_degree: HashMap<usize, usize> = HashMap::new();
    let mut runtime_adj: HashMap<usize, Vec<usize>> = HashMap::new();

    for &u in scc_indices {
        in_degree.insert(u, 0);
        runtime_adj.insert(u, Vec::new());
    }

    for &u in scc_indices {
        for &v in &adj[u] {
            if u != v && scc_set.contains(&v) && runtime_edges.contains(&(u, v)) {
                runtime_adj.entry(u).or_default().push(v);
                *in_degree.entry(v).or_insert(0) += 1;
            }
        }
    }

    // 3. Kahn's algorithm
    let mut queue = VecDeque::new();
    for &u in scc_indices {
        if in_degree.get(&u).copied().unwrap_or(0) == 0 {
            queue.push_back(u);
        }
    }

    let mut visited_count = 0;
    while let Some(u) = queue.pop_front() {
        visited_count += 1;
        if let Some(neighbors) = runtime_adj.get(&u) {
            for &v in neighbors {
                if let Some(deg) = in_degree.get_mut(&v) {
                    *deg -= 1;
                    if *deg == 0 {
                        queue.push_back(v);
                    }
                }
            }
        }
    }

    visited_count < scc_indices.len()
}

/// Finds a minimal example cycle within an SCC subgraph starting from candidate nodes in deterministic sorted order.
fn find_example_cycle(
    scc_indices: &[usize],
    adj: &[Vec<usize>],
    node_ids: &[String],
) -> Vec<String> {
    if scc_indices.is_empty() {
        return Vec::new();
    }

    let scc_set: HashSet<usize> = scc_indices.iter().copied().collect();

    let mut sorted_scc = scc_indices.to_vec();
    sorted_scc.sort_by_key(|&idx| &node_ids[idx]);

    // Handle single-node SCC (self-loop)
    if sorted_scc.len() == 1 {
        let u = sorted_scc[0];
        if adj[u].contains(&u) {
            return vec![node_ids[u].clone(), node_ids[u].clone()];
        }
        return Vec::new();
    }

    // Try finding a cycle of length >= 2 starting from candidate nodes in sorted order
    for &start_node in &sorted_scc {
        let mut queue = VecDeque::new();
        let mut prev: HashMap<usize, usize> = HashMap::new();
        let mut visited: HashSet<usize> = HashSet::new();

        for &next in &adj[start_node] {
            if next != start_node && scc_set.contains(&next) && visited.insert(next) {
                prev.insert(next, start_node);
                queue.push_back(next);
            }
        }

        let mut found = false;
        while let Some(curr) = queue.pop_front() {
            if adj[curr].contains(&start_node) {
                prev.insert(start_node, curr);
                found = true;
                break;
            }

            for &next in &adj[curr] {
                if next != start_node && scc_set.contains(&next) && visited.insert(next) {
                    prev.insert(next, curr);
                    queue.push_back(next);
                }
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
            return path.iter().map(|&idx| node_ids[idx].clone()).collect();
        } else if adj[start_node].contains(&start_node) {
            return vec![node_ids[start_node].clone(), node_ids[start_node].clone()];
        }
    }

    Vec::new()
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
    struct AreaAcc {
        area_id: String,
        file_count: usize,
        analyzed_file_count: usize,
        internal_edges: usize,
        outbound_edges: usize,
        inbound_edges: usize,
        connected: HashMap<usize, (usize, usize)>, // other_area_idx -> (outbound, inbound)
    }

    let mut area_to_idx: HashMap<String, usize> = HashMap::new();
    let mut areas: Vec<AreaAcc> = Vec::new();
    let mut file_to_area_idx: HashMap<&str, usize> = HashMap::with_capacity(nodes.len());

    for node in nodes {
        let area_id = get_area_id_for_path(&node.relative_path);
        let is_analyzed = matches!(
            node.analysis_status,
            NodeAnalysisStatus::Analyzed | NodeAnalysisStatus::PartiallyAnalyzed
        );

        let area_idx = match area_to_idx.get(&area_id) {
            Some(&idx) => idx,
            None => {
                let idx = areas.len();
                area_to_idx.insert(area_id.clone(), idx);
                areas.push(AreaAcc {
                    area_id,
                    file_count: 0,
                    analyzed_file_count: 0,
                    internal_edges: 0,
                    outbound_edges: 0,
                    inbound_edges: 0,
                    connected: HashMap::new(),
                });
                idx
            }
        };

        areas[area_idx].file_count += 1;
        if is_analyzed {
            areas[area_idx].analyzed_file_count += 1;
        }
        file_to_area_idx.insert(node.id.as_str(), area_idx);
    }

    for edge in edges {
        if edge.resolution_status == ResolutionStatus::ResolvedInternal {
            if let (Some(&src_idx), Some(&tgt_idx)) = (
                file_to_area_idx.get(edge.source_file_id.as_str()),
                file_to_area_idx.get(edge.target_file_id.as_str()),
            ) {
                if src_idx == tgt_idx {
                    areas[src_idx].internal_edges += 1;
                } else {
                    areas[src_idx].outbound_edges += 1;
                    areas[tgt_idx].inbound_edges += 1;
                    areas[src_idx].connected.entry(tgt_idx).or_default().0 += 1;
                    areas[tgt_idx].connected.entry(src_idx).or_default().1 += 1;
                }
            }
        }
    }

    let area_names: Vec<String> = areas.iter().map(|a| a.area_id.clone()).collect();
    let mut area_couplings: Vec<AreaCoupling> = areas
        .into_iter()
        .map(|acc| {
            let mut connected_areas: Vec<ConnectedArea> = acc
                .connected
                .into_iter()
                .map(|(other_idx, (out_c, in_c))| ConnectedArea {
                    area_id: area_names[other_idx].clone(),
                    outbound_count: out_c,
                    inbound_count: in_c,
                })
                .collect();

            // Sort by total inter-area communication descending, then area_id ascending
            connected_areas.sort_by(|a, b| {
                (b.outbound_count + b.inbound_count)
                    .cmp(&(a.outbound_count + a.inbound_count))
                    .then_with(|| a.area_id.cmp(&b.area_id))
            });

            AreaCoupling {
                area_id: acc.area_id,
                file_count: acc.file_count,
                analyzed_file_count: acc.analyzed_file_count,
                internal_edge_count: acc.internal_edges,
                outbound_edge_count: acc.outbound_edges,
                inbound_edge_count: acc.inbound_edges,
                connected_areas,
            }
        })
        .collect();

    // Sort by outbound communication descending, then area_id ascending
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
    let mut fully_analyzed = 0;
    let mut partially_analyzed = 0;
    let mut unsupported = 0;
    let mut failed = 0;

    for node in nodes {
        match node.analysis_status {
            NodeAnalysisStatus::Analyzed => fully_analyzed += 1,
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
        total_fully_analyzed: fully_analyzed,
        total_partially_analyzed: partially_analyzed,
        total_unsupported: unsupported,
        total_failed: failed,
        total_unresolved_imports: unresolved_imports,
        total_issues: issues.len(),
    }
}

/// Authoritative implementation of downstream impact analysis.
pub fn compute_impact_authoritative<FRelPath, FDependents>(
    target_file_id: &str,
    max_depth: usize,
    max_files: usize,
    cycle_groups: &[CycleGroup],
    target_exists: bool,
    get_relative_path: FRelPath,
    get_dependents: FDependents,
) -> Option<FileImpactAnalysis>
where
    FRelPath: Fn(&str) -> Option<String>,
    FDependents: Fn(&str) -> Vec<(String, bool)>,
{
    if !target_exists {
        return None;
    }

    let clamped_depth = max_depth.clamp(1, 20);
    let bound_files = max_files;

    let (is_part_of_cycle, cycle_group_id) = cycle_groups
        .iter()
        .find(|g| g.files.iter().any(|f| f == target_file_id))
        .map(|g| (true, Some(g.id.clone())))
        .unwrap_or((false, None));

    if bound_files == 0 {
        return Some(FileImpactAnalysis {
            file_id: target_file_id.to_string(),
            direct_dependents_count: 0,
            transitive_dependents_count: 0,
            total_impact_count: 0,
            is_part_of_cycle,
            cycle_group_id,
            impacted_files: Vec::new(),
        });
    }

    let direct_deps = get_dependents(target_file_id);
    let direct_dependents_count = direct_deps.len();

    // Cache get_dependents results to avoid recomputation across BFS traversals
    let mut deps_cache: HashMap<String, Vec<(String, bool)>> = HashMap::new();
    deps_cache.insert(target_file_id.to_string(), direct_deps.clone());

    let mut get_cached_deps = |id: &str| -> Vec<(String, bool)> {
        if let Some(cached) = deps_cache.get(id) {
            return cached.clone();
        }
        let deps = get_dependents(id);
        deps_cache.insert(id.to_string(), deps.clone());
        deps
    };

    // 1. Runtime reachability: BFS starting from target_file_id following pure runtime edges up to clamped_depth
    let mut runtime_reachable: HashSet<String> = HashSet::new();
    let mut runtime_queue: VecDeque<(String, usize)> = VecDeque::new();
    let mut runtime_visited: HashSet<String> = HashSet::new();

    runtime_visited.insert(target_file_id.to_string());
    runtime_queue.push_back((target_file_id.to_string(), 0));

    while let Some((curr, depth)) = runtime_queue.pop_front() {
        if depth < clamped_depth {
            let deps = get_cached_deps(&curr);
            for (dep_id, is_type) in deps {
                if !is_type && runtime_visited.insert(dep_id.clone()) {
                    runtime_reachable.insert(dep_id.clone());
                    runtime_queue.push_back((dep_id, depth + 1));
                }
            }
        }
    }

    // 2. General BFS: collect impacted files up to bound_files and clamped_depth
    let mut impacted_files: Vec<ImpactItem> = Vec::new();
    let mut visited: HashSet<String> = HashSet::new();
    visited.insert(target_file_id.to_string());

    let mut queue: VecDeque<(String, usize)> = VecDeque::new();
    for (dep_id, _) in direct_deps {
        if visited.insert(dep_id.clone()) {
            queue.push_back((dep_id, 1));
        }
    }

    while let Some((curr_id, depth)) = queue.pop_front() {
        if impacted_files.len() >= bound_files {
            break;
        }

        if let Some(rel_path) = get_relative_path(&curr_id) {
            let is_type_only = !runtime_reachable.contains(&curr_id);
            impacted_files.push(ImpactItem {
                file_id: curr_id.clone(),
                relative_path: rel_path,
                depth,
                is_type_only,
            });
        }

        if impacted_files.len() >= bound_files {
            break;
        }

        if depth < clamped_depth {
            let next_deps = get_cached_deps(&curr_id);
            for (next_id, _) in next_deps {
                if visited.insert(next_id.clone()) {
                    queue.push_back((next_id, depth + 1));
                }
            }
        }
    }

    let transitive_dependents_count = impacted_files.iter().filter(|i| i.depth > 1).count();
    let total_impact_count = impacted_files.len();

    Some(FileImpactAnalysis {
        file_id: target_file_id.to_string(),
        direct_dependents_count,
        transitive_dependents_count,
        total_impact_count,
        is_part_of_cycle,
        cycle_group_id,
        impacted_files,
    })
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
    let target_exists = nodes.iter().any(|n| n.id == target_file_id);
    if !target_exists {
        return None;
    }

    let id_to_path: HashMap<&str, &str> = nodes
        .iter()
        .map(|n| (n.id.as_str(), n.relative_path.as_str()))
        .collect();

    // Inverted adjacency: target -> [sources that import target]
    let mut dependents_adj: HashMap<&str, HashMap<&str, bool>> = HashMap::new();
    for edge in edges {
        if edge.resolution_status == ResolutionStatus::ResolvedInternal {
            let src = edge.source_file_id.as_str();
            let tgt = edge.target_file_id.as_str();
            if src != tgt {
                let is_type = edge.relationship_kind == RelationshipKind::TypeOnly
                    || (!edge.evidence.is_empty() && edge.evidence.iter().all(|e| e.is_type_only));
                dependents_adj
                    .entry(tgt)
                    .or_default()
                    .entry(src)
                    .and_modify(|t| *t = *t && is_type)
                    .or_insert(is_type);
            }
        }
    }

    let mut sorted_dependents: HashMap<&str, Vec<(String, bool)>> = HashMap::new();
    for (&tgt, deps) in &dependents_adj {
        let mut list: Vec<(String, bool)> =
            deps.iter().map(|(&s, &t)| (s.to_string(), t)).collect();
        list.sort_by(|a, b| a.0.cmp(&b.0));
        sorted_dependents.insert(tgt, list);
    }

    let get_rel_path = |id: &str| id_to_path.get(id).map(|s| s.to_string());
    let get_deps = |id: &str| -> Vec<(String, bool)> {
        sorted_dependents.get(id).cloned().unwrap_or_default()
    };

    compute_impact_authoritative(
        target_file_id,
        max_depth,
        max_files,
        cycle_groups,
        target_exists,
        get_rel_path,
        get_deps,
    )
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

    #[test]
    fn test_diagnostics_summary_counts_fully_analyzed() {
        let mut n1 = make_node("src/a.ts");
        n1.analysis_status = NodeAnalysisStatus::Analyzed;
        let mut n2 = make_node("src/b.ts");
        n2.analysis_status = NodeAnalysisStatus::PartiallyAnalyzed;
        let mut n3 = make_node("src/c.ts");
        n3.analysis_status = NodeAnalysisStatus::Unsupported;
        let mut n4 = make_node("src/d.ts");
        n4.analysis_status = NodeAnalysisStatus::Failed;
        let mut n5 = make_node("src/e.ts");
        n5.analysis_status = NodeAnalysisStatus::Analyzed;

        let nodes = vec![n1, n2, n3, n4, n5];
        let coverage = AnalysisCoverage {
            total_discovered: 5,
            total_analyzed: 3,
            total_excluded: 0,
            total_issues: 0,
            is_complete: true,
        };

        let summary = compute_diagnostics_summary(&nodes, &[], &coverage);
        assert_eq!(summary.total_discovered, 5);
        assert_eq!(summary.total_analyzed, 3);
        assert_eq!(summary.total_fully_analyzed, 2);
        assert_eq!(summary.total_partially_analyzed, 1);
        assert_eq!(summary.total_unsupported, 1);
        assert_eq!(summary.total_failed, 1);
        assert_eq!(summary.total_issues, 0);
    }
}

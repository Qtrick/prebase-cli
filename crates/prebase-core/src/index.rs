use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::model::{
    ArchitecturalInsights, DependencyEdge, FileImpactAnalysis, FileNode, GraphSnapshot,
    ResolutionStatus,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInspection {
    pub file: FileNode,
    pub dependencies: Vec<FileNode>,
    pub dependents: Vec<FileNode>,
    pub outgoing_edges: Vec<DependencyEdge>,
    pub incoming_edges: Vec<DependencyEdge>,
}

#[derive(Debug, Clone)]
pub struct GraphIndex {
    nodes_by_id: HashMap<String, FileNode>,
    nodes_by_path: HashMap<String, String>, // path -> id
    edges_by_id: HashMap<String, DependencyEdge>,
    outgoing_by_source: HashMap<String, Vec<String>>, // source_id -> [edge_id]
    incoming_by_target: HashMap<String, Vec<String>>, // target_id -> [edge_id]
    all_node_ids: Vec<String>,
    insights: ArchitecturalInsights,
}

impl GraphIndex {
    pub fn build(snapshot: &GraphSnapshot) -> Self {
        let mut nodes_by_id = HashMap::with_capacity(snapshot.nodes.len());
        let mut nodes_by_path = HashMap::with_capacity(snapshot.nodes.len());
        let mut edges_by_id = HashMap::with_capacity(snapshot.edges.len());
        let mut outgoing_by_source: HashMap<String, Vec<String>> = HashMap::new();
        let mut incoming_by_target: HashMap<String, Vec<String>> = HashMap::new();
        let mut all_node_ids = Vec::with_capacity(snapshot.nodes.len());

        for node in &snapshot.nodes {
            nodes_by_id.insert(node.id.clone(), node.clone());
            nodes_by_path.insert(node.relative_path.clone(), node.id.clone());
            all_node_ids.push(node.id.clone());
        }

        for edge in &snapshot.edges {
            if edge.resolution_status == ResolutionStatus::ResolvedInternal {
                edges_by_id.insert(edge.id.clone(), edge.clone());
                outgoing_by_source
                    .entry(edge.source_file_id.clone())
                    .or_default()
                    .push(edge.id.clone());
                incoming_by_target
                    .entry(edge.target_file_id.clone())
                    .or_default()
                    .push(edge.id.clone());
            }
        }

        let insights = match &snapshot.insights {
            Some(i) => i.clone(),
            None => crate::insights::compute_architectural_insights(
                &snapshot.nodes,
                &snapshot.edges,
                &snapshot.coverage,
                &snapshot.issues,
            ),
        };

        Self {
            nodes_by_id,
            nodes_by_path,
            edges_by_id,
            outgoing_by_source,
            incoming_by_target,
            all_node_ids,
            insights,
        }
    }

    pub fn get_file(&self, id: &str) -> Option<&FileNode> {
        self.nodes_by_id.get(id)
    }

    pub fn get_file_by_path(&self, path: &str) -> Option<&FileNode> {
        self.nodes_by_path
            .get(path)
            .and_then(|id| self.nodes_by_id.get(id))
    }

    pub fn get_edge(&self, edge_id: &str) -> Option<&DependencyEdge> {
        self.edges_by_id.get(edge_id)
    }

    pub fn get_outgoing_edges(&self, source_id: &str) -> Vec<&DependencyEdge> {
        self.outgoing_by_source
            .get(source_id)
            .map(|edge_ids| {
                edge_ids
                    .iter()
                    .filter_map(|eid| self.edges_by_id.get(eid))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn get_incoming_edges(&self, target_id: &str) -> Vec<&DependencyEdge> {
        self.incoming_by_target
            .get(target_id)
            .map(|edge_ids| {
                edge_ids
                    .iter()
                    .filter_map(|eid| self.edges_by_id.get(eid))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn get_dependencies(&self, source_id: &str) -> Vec<FileNode> {
        self.get_outgoing_edges(source_id)
            .into_iter()
            .filter_map(|e| self.nodes_by_id.get(&e.target_file_id).cloned())
            .collect()
    }

    pub fn get_dependents(&self, target_id: &str) -> Vec<FileNode> {
        self.get_incoming_edges(target_id)
            .into_iter()
            .filter_map(|e| self.nodes_by_id.get(&e.source_file_id).cloned())
            .collect()
    }

    pub fn inspect_file(&self, id: &str) -> Option<FileInspection> {
        let file = self.get_file(id)?.clone();
        let dependencies = self.get_dependencies(id);
        let dependents = self.get_dependents(id);
        let outgoing_edges = self.get_outgoing_edges(id).into_iter().cloned().collect();
        let incoming_edges = self.get_incoming_edges(id).into_iter().cloned().collect();

        Some(FileInspection {
            file,
            dependencies,
            dependents,
            outgoing_edges,
            incoming_edges,
        })
    }

    pub fn search_files(&self, query: &str, limit: usize) -> Vec<FileNode> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return self
                .all_node_ids
                .iter()
                .take(limit)
                .filter_map(|id| self.nodes_by_id.get(id).cloned())
                .collect();
        }

        // Rank by exact match, prefix match on filename, prefix match on path, then substring
        let mut scored: Vec<(u32, &FileNode)> = self
            .nodes_by_id
            .values()
            .filter_map(|node| {
                let fname_lower = node.filename.to_lowercase();
                let path_lower = node.relative_path.to_lowercase();

                let score = if fname_lower == q {
                    100
                } else if fname_lower.starts_with(&q) {
                    80
                } else if path_lower.starts_with(&q) {
                    60
                } else if fname_lower.contains(&q) {
                    40
                } else if path_lower.contains(&q) {
                    20
                } else {
                    return None;
                };

                Some((score, node))
            })
            .collect();

        scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.id.cmp(&b.1.id)));

        scored
            .into_iter()
            .take(limit)
            .map(|(_, node)| node.clone())
            .collect()
    }

    pub fn get_insights(&self) -> &ArchitecturalInsights {
        &self.insights
    }

    pub fn analyze_impact(&self, file_id: &str, max_depth: usize) -> Option<FileImpactAnalysis> {
        let target_node = self.nodes_by_id.get(file_id)?;

        let mut queue = std::collections::VecDeque::new();
        let mut visited = std::collections::HashSet::new();
        visited.insert(file_id);

        let direct_edges = self.incoming_by_target.get(file_id);
        let direct_dependents_count = direct_edges.map(|e| e.len()).unwrap_or(0);

        if let Some(edge_ids) = direct_edges {
            for eid in edge_ids {
                if let Some(edge) = self.edges_by_id.get(eid) {
                    if edge.resolution_status == ResolutionStatus::ResolvedInternal {
                        let is_type = edge.relationship_kind
                            == crate::model::RelationshipKind::TypeOnly
                            || (!edge.evidence.is_empty()
                                && edge.evidence.iter().all(|ev| ev.is_type_only));
                        let src_id = edge.source_file_id.as_str();
                        if visited.insert(src_id) {
                            queue.push_back((src_id, 1, is_type));
                        }
                    }
                }
            }
        }

        let mut impacted_files = Vec::new();
        let max_files = 100;
        let clamped_depth = max_depth.clamp(1, 20);

        while let Some((curr_id, depth, is_type)) = queue.pop_front() {
            if let Some(node) = self.nodes_by_id.get(curr_id) {
                impacted_files.push(crate::model::ImpactItem {
                    file_id: curr_id.to_string(),
                    relative_path: node.relative_path.clone(),
                    depth,
                    is_type_only: is_type,
                });
            }

            if impacted_files.len() >= max_files || depth >= clamped_depth {
                continue;
            }

            if let Some(edge_ids) = self.incoming_by_target.get(curr_id) {
                for eid in edge_ids {
                    if let Some(edge) = self.edges_by_id.get(eid) {
                        if edge.resolution_status == ResolutionStatus::ResolvedInternal {
                            let next_is_type = edge.relationship_kind
                                == crate::model::RelationshipKind::TypeOnly
                                || (!edge.evidence.is_empty()
                                    && edge.evidence.iter().all(|ev| ev.is_type_only));
                            let src_id = edge.source_file_id.as_str();
                            if visited.insert(src_id) {
                                queue.push_back((src_id, depth + 1, is_type && next_is_type));
                            }
                        }
                    }
                }
            }
        }

        let transitive_count = if impacted_files.len() > direct_dependents_count {
            impacted_files.len() - direct_dependents_count
        } else {
            0
        };

        let (is_part_of_cycle, cycle_group_id) = self
            .insights
            .cycle_groups
            .iter()
            .find(|g| g.files.iter().any(|f| f == file_id))
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
}

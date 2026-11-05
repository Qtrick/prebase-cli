use std::collections::{BTreeMap, HashMap};

use crate::model::{
    AnalysisCoverage, AnalysisIssue, DependencyEdge, DependencyEvidence, FileNode, GraphSnapshot,
    RelationshipKind, ResolutionStatus, CURRENT_SCHEMA_VERSION,
};

#[derive(Debug, Clone, Default)]
pub struct CanonicalGraph {
    nodes: BTreeMap<String, FileNode>,
    // Keyed by "source->target" for deterministic deduplication
    edges: BTreeMap<String, DependencyEdge>,
    issues: Vec<AnalysisIssue>,
}

impl CanonicalGraph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    pub fn add_node(&mut self, mut node: FileNode) {
        node.id = node.relative_path.clone();
        self.nodes.insert(node.id.clone(), node);
    }

    pub fn get_node(&self, id: &str) -> Option<&FileNode> {
        self.nodes.get(id)
    }

    pub fn get_node_mut(&mut self, id: &str) -> Option<&mut FileNode> {
        self.nodes.get_mut(id)
    }

    pub fn has_node(&self, id: &str) -> bool {
        self.nodes.contains_key(id)
    }

    pub fn add_edge(&mut self, edge: DependencyEdge) {
        // Enforce both endpoints exist in confirmed internal edges
        if edge.resolution_status == ResolutionStatus::ResolvedInternal
            && (!self.has_node(&edge.source_file_id) || !self.has_node(&edge.target_file_id))
        {
            return;
        }

        let edge_id = DependencyEdge::make_edge_id(&edge.source_file_id, &edge.target_file_id);
        if let Some(existing) = self.edges.get_mut(&edge_id) {
            // Deduplicate evidence
            for ev in edge.evidence {
                if !existing.evidence.iter().any(|e| {
                    e.line == ev.line
                        && e.column == ev.column
                        && e.import_specifier == ev.import_specifier
                }) {
                    existing.evidence.push(ev);
                }
            }
        } else {
            let mut new_edge = edge;
            new_edge.id = edge_id.clone();
            self.edges.insert(edge_id, new_edge);
        }
    }

    pub fn add_evidence_or_edge(
        &mut self,
        source_id: &str,
        target_id: &str,
        evidence: DependencyEvidence,
        relationship_kind: RelationshipKind,
        resolution_status: ResolutionStatus,
    ) {
        if resolution_status == ResolutionStatus::ResolvedInternal
            && (!self.has_node(source_id) || !self.has_node(target_id))
        {
            return;
        }

        let edge_id = DependencyEdge::make_edge_id(source_id, target_id);
        if let Some(existing) = self.edges.get_mut(&edge_id) {
            if !existing.evidence.iter().any(|e| {
                e.line == evidence.line
                    && e.column == evidence.column
                    && e.import_specifier == evidence.import_specifier
            }) {
                existing.evidence.push(evidence);
            }
        } else {
            let new_edge = DependencyEdge {
                id: edge_id.clone(),
                source_file_id: source_id.to_string(),
                target_file_id: target_id.to_string(),
                relationship_kind,
                resolution_status,
                evidence: vec![evidence],
            };
            self.edges.insert(edge_id, new_edge);
        }
    }

    pub fn add_issue(&mut self, issue: AnalysisIssue) {
        self.issues.push(issue);
    }

    pub fn build_snapshot(
        &self,
        repository_id: &str,
        revision: u64,
        coverage: AnalysisCoverage,
    ) -> GraphSnapshot {
        // Compute degree metrics
        let mut dep_counts: HashMap<String, usize> = HashMap::new();
        let mut dependent_counts: HashMap<String, usize> = HashMap::new();

        for edge in self.edges.values() {
            if edge.resolution_status == ResolutionStatus::ResolvedInternal {
                *dep_counts.entry(edge.source_file_id.clone()).or_default() += 1;
                *dependent_counts
                    .entry(edge.target_file_id.clone())
                    .or_default() += 1;
            }
        }

        let mut nodes: Vec<FileNode> = self
            .nodes
            .values()
            .cloned()
            .map(|mut n| {
                n.direct_dependency_count = dep_counts.get(&n.id).copied().unwrap_or(0);
                n.direct_dependent_count = dependent_counts.get(&n.id).copied().unwrap_or(0);
                n
            })
            .collect();

        // Deterministic sorting
        nodes.sort_by(|a, b| a.id.cmp(&b.id));

        let mut edges: Vec<DependencyEdge> = self.edges.values().cloned().collect();
        edges.sort_by(|a, b| a.id.cmp(&b.id));

        GraphSnapshot {
            schema_version: CURRENT_SCHEMA_VERSION.to_string(),
            repository_id: repository_id.to_string(),
            revision,
            nodes,
            edges,
            coverage,
            issues: self.issues.clone(),
        }
    }
}

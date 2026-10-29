use crate::model::CommitSummary;
use std::collections::HashMap;

/// Assigns topological lanes (columns) to a list of commits in topological order (newest to oldest).
/// This allows the graphical Temporal renderer to draw non-overlapping commit tracks and branch curves.
pub fn assign_topological_lanes(commits: &mut [CommitSummary]) {
    if commits.is_empty() {
        return;
    }

    // active_lanes holds the commit hash that is expected to occupy each lane.
    // If a lane is None, it is currently empty and can be reused.
    let mut active_lanes: Vec<Option<String>> = Vec::new();
    let mut commit_lanes: HashMap<String, usize> = HashMap::new();

    for commit in commits.iter_mut() {
        // 1. Determine lane for current commit
        let lane = if let Some(&assigned) = commit_lanes.get(&commit.hash) {
            assigned
        } else {
            // Find first available slot in active_lanes
            let free_idx = active_lanes.iter().position(|slot| slot.is_none());
            match free_idx {
                Some(idx) => {
                    active_lanes[idx] = Some(commit.hash.clone());
                    idx
                }
                None => {
                    let idx = active_lanes.len();
                    active_lanes.push(Some(commit.hash.clone()));
                    idx
                }
            }
        };

        commit.lane = lane;

        // 2. Clear current commit from active_lanes
        if lane < active_lanes.len() && active_lanes[lane].as_deref() == Some(&commit.hash) {
            active_lanes[lane] = None;
        }

        // 3. Propagate to parents
        for (p_idx, parent_hash) in commit.parent_hashes.iter().enumerate() {
            if let Some(&existing_lane) = commit_lanes.get(parent_hash) {
                // If the parent already has a lane, but current commit is on a lower lane (e.g. main trunk)
                // and parent is its primary first parent, prefer the lower lane!
                if p_idx == 0 && lane < existing_lane {
                    commit_lanes.insert(parent_hash.clone(), lane);
                    if existing_lane < active_lanes.len()
                        && active_lanes[existing_lane].as_deref() == Some(parent_hash)
                    {
                        active_lanes[existing_lane] = None;
                    }
                    if lane < active_lanes.len() && active_lanes[lane].is_none() {
                        active_lanes[lane] = Some(parent_hash.clone());
                    }
                }
            } else if p_idx == 0 && lane < active_lanes.len() && active_lanes[lane].is_none() {
                // First parent can inherit the current commit's lane
                active_lanes[lane] = Some(parent_hash.clone());
                commit_lanes.insert(parent_hash.clone(), lane);
            } else {
                // Subsequent parent or lane was occupied: find or allocate a free lane
                let next_free = active_lanes.iter().position(|slot| slot.is_none());
                let p_lane = match next_free {
                    Some(slot) => {
                        active_lanes[slot] = Some(parent_hash.clone());
                        slot
                    }
                    None => {
                        let slot = active_lanes.len();
                        active_lanes.push(Some(parent_hash.clone()));
                        slot
                    }
                };
                commit_lanes.insert(parent_hash.clone(), p_lane);
            }
        }

        // Trim trailing empty lanes
        while let Some(last) = active_lanes.last() {
            if last.is_none() {
                active_lanes.pop();
            } else {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_linear_branch_single_lane() {
        let mut commits = vec![
            CommitSummary {
                hash: "c3".into(),
                short_hash: "c3".into(),
                parent_hashes: vec!["c2".into()],
                author_name: "A".into(),
                author_email: "a@a.com".into(),
                author_timestamp: 3,
                summary: "Third".into(),
                lane: 0,
            },
            CommitSummary {
                hash: "c2".into(),
                short_hash: "c2".into(),
                parent_hashes: vec!["c1".into()],
                author_name: "A".into(),
                author_email: "a@a.com".into(),
                author_timestamp: 2,
                summary: "Second".into(),
                lane: 0,
            },
            CommitSummary {
                hash: "c1".into(),
                short_hash: "c1".into(),
                parent_hashes: vec![],
                author_name: "A".into(),
                author_email: "a@a.com".into(),
                author_timestamp: 1,
                summary: "First".into(),
                lane: 0,
            },
        ];

        assign_topological_lanes(&mut commits);
        assert_eq!(commits[0].lane, 0);
        assert_eq!(commits[1].lane, 0);
        assert_eq!(commits[2].lane, 0);
    }

    #[test]
    fn test_branch_and_merge_lanes() {
        // Merge commit m1 with parents c2 and b1
        let mut commits = vec![
            CommitSummary {
                hash: "m1".into(),
                short_hash: "m1".into(),
                parent_hashes: vec!["c2".into(), "b1".into()],
                author_name: "A".into(),
                author_email: "a@a.com".into(),
                author_timestamp: 4,
                summary: "Merge".into(),
                lane: 0,
            },
            CommitSummary {
                hash: "b1".into(),
                short_hash: "b1".into(),
                parent_hashes: vec!["c1".into()],
                author_name: "B".into(),
                author_email: "b@b.com".into(),
                author_timestamp: 3,
                summary: "Branch commit".into(),
                lane: 0,
            },
            CommitSummary {
                hash: "c2".into(),
                short_hash: "c2".into(),
                parent_hashes: vec!["c1".into()],
                author_name: "A".into(),
                author_email: "a@a.com".into(),
                author_timestamp: 2,
                summary: "Main commit".into(),
                lane: 0,
            },
            CommitSummary {
                hash: "c1".into(),
                short_hash: "c1".into(),
                parent_hashes: vec![],
                author_name: "A".into(),
                author_email: "a@a.com".into(),
                author_timestamp: 1,
                summary: "Root commit".into(),
                lane: 0,
            },
        ];

        assign_topological_lanes(&mut commits);
        assert_eq!(commits[0].lane, 0); // m1 is on lane 0
        assert_eq!(commits[1].lane, 1); // b1 branch is on lane 1
        assert_eq!(commits[2].lane, 0); // c2 inherited lane 0 from m1
        assert_eq!(commits[3].lane, 0); // c1 trunk is on lane 0
    }
}

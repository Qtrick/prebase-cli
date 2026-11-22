/**
 * Computes concise, unique, and human-readable monograms for architectural repository areas.
 * Guarantees that no two areas in the same repository receive identical monograms,
 * resolving collisions like 'tests' vs 'testing' into distinct descriptors (e.g. 'TS' vs 'TG').
 */

export interface AreaIdentifier {
  id: string;
  name: string;
}

/**
 * Normalizes an area name into clean alphanumeric word tokens.
 */
function tokenizeAreaName(name: string): string[] {
  // Strip common wrapper characters like '(root)' -> 'root'
  const cleaned = name.replace(/^[([<{]+|[)\]>}]+$/g, '').trim();
  // Split on directory slashes, hyphens, underscores, or spaces
  const parts = cleaned.split(/[-_/ ]+/).filter(Boolean);
  return parts.length > 0 ? parts : [cleaned || 'A'];
}

/**
 * Generates an ordered list of candidate monograms for an area name in descending preference.
 */
function generateCandidateMonograms(name: string): string[] {
  const tokens = tokenizeAreaName(name);
  const candidates: string[] = [];

  const addCandidate = (c: string) => {
    const upper = c.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (upper && !candidates.includes(upper)) {
      candidates.push(upper);
    }
  };

  if (tokens.length >= 2) {
    // 1. First letter of first two tokens (e.g. 'frontend-ui' -> 'FU')
    addCandidate(tokens[0][0] + tokens[1][0]);

    // 2. First letter of token 0 + second letter of token 1 (e.g. 'frontend-ui' -> 'FI')
    if (tokens[1].length > 1) {
      addCandidate(tokens[0][0] + tokens[1][1]);
    }

    // 3. First two letters of token 0 (e.g. 'frontend-ui' -> 'FR')
    if (tokens[0].length >= 2) {
      addCandidate(tokens[0].slice(0, 2));
    }

    // 4. Three-letter multi-token acronym (e.g. 'frontend-ui-core' -> 'FUC' or 'FU1')
    if (tokens.length >= 3) {
      addCandidate(tokens[0][0] + tokens[1][0] + tokens[2][0]);
    } else {
      addCandidate(tokens[0][0] + tokens[1].slice(0, 2));
    }
  } else {
    const token = tokens[0].replace(/[^A-Za-z0-9]/g, '');
    if (token.length === 0) {
      addCandidate('AR');
    } else if (token.length === 1) {
      addCandidate(token + '1');
      addCandidate(token);
    } else {
      // 1. First two characters (e.g. 'core' -> 'CO', 'tests' -> 'TE')
      addCandidate(token.slice(0, 2));

      // 2. First and last character (e.g. 'tests' -> 'TS', 'testing' -> 'TG')
      addCandidate(token[0] + token[token.length - 1]);

      // 3. First and third character (e.g. 'temporal' -> 'TM', 'network' -> 'NT')
      if (token.length >= 3) {
        addCandidate(token[0] + token[2]);
      }

      // 4. First and fourth character
      if (token.length >= 4) {
        addCandidate(token[0] + token[3]);
      }

      // 5. Three character prefix
      if (token.length >= 3) {
        addCandidate(token.slice(0, 3));
      }
    }
  }

  return candidates;
}

/**
 * Computes deterministic, guaranteed-unique monograms for all areas in a repository.
 *
 * @param areas List of repository areas with id and name.
 * @returns Map from area.id to its unique uppercase monogram.
 */
export function computeAreaMonograms(areas: readonly AreaIdentifier[]): Map<string, string> {
  const result = new Map<string, string>();
  if (areas.length === 0) {
    return result;
  }

  // Sort areas deterministically by ID so assignment order is strictly reproducible
  const sorted = [...areas].sort((a, b) => a.id.localeCompare(b.id));
  const assigned = new Set<string>();

  // Pass 1: Try primary candidates for non-colliding names
  // Group areas by their top candidate
  const candidateLists = new Map<string, string[]>();
  for (const area of sorted) {
    candidateLists.set(area.id, generateCandidateMonograms(area.name));
  }

  // Check which areas have collisions on their first choice
  const firstChoiceCount = new Map<string, number>();
  for (const area of sorted) {
    const list = candidateLists.get(area.id)!;
    const top = list[0] || 'AR';
    firstChoiceCount.set(top, (firstChoiceCount.get(top) || 0) + 1);
  }

  // Assign areas with unique first choices immediately
  const remaining: AreaIdentifier[] = [];
  for (const area of sorted) {
    const list = candidateLists.get(area.id)!;
    const top = list[0] || 'AR';
    if (firstChoiceCount.get(top) === 1) {
      result.set(area.id, top);
      assigned.add(top);
    } else {
      remaining.push(area);
    }
  }

  // Pass 2: Disambiguate remaining areas with conflicting first choices
  for (const area of remaining) {
    const candidates = candidateLists.get(area.id)!;
    const top = candidates[0];
    let chosen: string | null = null;

    // First try alternative candidates (skipping collided top candidate)
    for (let i = 1; i < candidates.length; i++) {
      const cand = candidates[i];
      if (!assigned.has(cand)) {
        chosen = cand;
        break;
      }
    }

    // If no alternative candidate was free, allow using the top candidate if still unassigned
    if (!chosen && top && !assigned.has(top)) {
      chosen = top;
    }

    // Fallback: If all heuristics conflict, append alphanumeric discriminator
    if (!chosen) {
      const base = top || 'AR';
      let suffix = 2;
      while (assigned.has(`${base}${suffix}`)) {
        suffix++;
      }
      chosen = `${base}${suffix}`;
    }

    result.set(area.id, chosen);
    assigned.add(chosen);
  }

  return result;
}

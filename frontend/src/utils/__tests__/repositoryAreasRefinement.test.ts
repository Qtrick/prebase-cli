import { describe, it, expect } from 'vitest';
import { deriveRepositoryStructure } from '../repositoryAreas';
import { FileNode, DependencyEdge } from '../../types/graph';

describe('repositoryAreas refinement — truthful relationship wording', () => {
  const nodeSrc: FileNode = {
    id: 'src/components/Button.tsx',
    filename: 'Button.tsx',
    relative_path: 'src/components/Button.tsx',
    language: 'TypeScript',
    size_bytes: 500,
    file_kind: 'Source',
    analysis_status: 'Analyzed',
    direct_dependency_count: 1,
    direct_dependent_count: 0,
  };

  const nodeTgt: FileNode = {
    id: 'src/utils/format.ts',
    filename: 'format.ts',
    relative_path: 'src/utils/format.ts',
    language: 'TypeScript',
    size_bytes: 300,
    file_kind: 'Source',
    analysis_status: 'Analyzed',
    direct_dependency_count: 0,
    direct_dependent_count: 1,
  };

  function createEdge(
    id: string,
    src: string,
    tgt: string,
    kind: 'Import' | 'Export' | 'DynamicImport' | 'TypeOnly'
  ): DependencyEdge {
    return {
      id,
      source_file_id: src,
      target_file_id: tgt,
      relationship_kind: kind,
      resolution_status: 'ResolvedInternal',
      evidence: [
        {
          source_file_id: src,
          import_specifier: tgt,
          line: 1,
          column: 1,
          relationship_kind: kind,
          is_type_only: kind === 'TypeOnly',
        },
      ],
    };
  }

  it('uses standard import wording when all connections are Import', () => {
    const edges = [createEdge('e1', nodeSrc.id, nodeTgt.id, 'Import')];
    const structure = deriveRepositoryStructure([nodeSrc, nodeTgt], edges);
    const areaEdge = structure.areaEdges[0];
    expect(areaEdge).toBeDefined();
    expect(areaEdge.summarySentence).toMatch(/1 file in components import 1 file in utils across 1 connection\./);
  });

  it('uses re-export wording when all connections are Export', () => {
    const edges = [createEdge('e1', nodeSrc.id, nodeTgt.id, 'Export')];
    const structure = deriveRepositoryStructure([nodeSrc, nodeTgt], edges);
    const areaEdge = structure.areaEdges[0];
    expect(areaEdge).toBeDefined();
    expect(areaEdge.summarySentence).toMatch(/1 file in components re-export from 1 file in utils across 1 connection\./);
  });

  it('uses dynamically import wording when all connections are DynamicImport', () => {
    const edges = [createEdge('e1', nodeSrc.id, nodeTgt.id, 'DynamicImport')];
    const structure = deriveRepositoryStructure([nodeSrc, nodeTgt], edges);
    const areaEdge = structure.areaEdges[0];
    expect(areaEdge).toBeDefined();
    expect(areaEdge.summarySentence).toMatch(/1 file in components dynamically import 1 file in utils across 1 connection\./);
  });

  it('uses type definitions wording when all connections are TypeOnly', () => {
    const edges = [createEdge('e1', nodeSrc.id, nodeTgt.id, 'TypeOnly')];
    const structure = deriveRepositoryStructure([nodeSrc, nodeTgt], edges);
    const areaEdge = structure.areaEdges[0];
    expect(areaEdge).toBeDefined();
    expect(areaEdge.summarySentence).toMatch(/1 file in components import type definitions from 1 file in utils across 1 connection\./);
  });

  it('uses general confirmed source relationship wording when connection kinds are mixed', () => {
    const nodeSrc2: FileNode = {
      ...nodeSrc,
      id: 'src/components/Card.tsx',
      filename: 'Card.tsx',
      relative_path: 'src/components/Card.tsx',
    };
    const edges = [
      createEdge('e1', nodeSrc.id, nodeTgt.id, 'Import'),
      createEdge('e2', nodeSrc2.id, nodeTgt.id, 'TypeOnly'),
    ];
    const structure = deriveRepositoryStructure([nodeSrc, nodeSrc2, nodeTgt], edges);
    const areaEdge = structure.areaEdges[0];
    expect(areaEdge).toBeDefined();
    expect(areaEdge.summarySentence).toMatch(
      /2 files in components have confirmed source relationships with 1 file in utils across 2 connections\./
    );
  });
});

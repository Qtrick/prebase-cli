import { describe, it, expect } from 'vitest';
import { computeDisambiguatedLabels } from '../pathDisambiguation';

describe('computeDisambiguatedLabels', () => {
  it('returns plain filename for unique files', () => {
    const nodes = [
      { id: 'src/app.ts', relative_path: 'src/app.ts', filename: 'app.ts' },
      { id: 'src/util.ts', relative_path: 'src/util.ts', filename: 'util.ts' },
    ];
    const labels = computeDisambiguatedLabels(nodes);
    expect(labels.get('src/app.ts')).toBe('app.ts');
    expect(labels.get('src/util.ts')).toBe('util.ts');
  });

  it('disambiguates duplicate filenames with immediate parent if parent is distinct', () => {
    const nodes = [
      { id: 'src/components/Header/index.ts', relative_path: 'src/components/Header/index.ts', filename: 'index.ts' },
      { id: 'src/components/Card/index.ts', relative_path: 'src/components/Card/index.ts', filename: 'index.ts' },
    ];
    const labels = computeDisambiguatedLabels(nodes);
    expect(labels.get('src/components/Header/index.ts')).toBe('Header/index.ts');
    expect(labels.get('src/components/Card/index.ts')).toBe('Card/index.ts');
  });

  it('disambiguates identical parent directories using higher ancestor (web vs admin)', () => {
    const nodes = [
      { id: 'apps/web/src/components/index.ts', relative_path: 'apps/web/src/components/index.ts', filename: 'index.ts' },
      { id: 'apps/admin/src/components/index.ts', relative_path: 'apps/admin/src/components/index.ts', filename: 'index.ts' },
    ];
    const labels = computeDisambiguatedLabels(nodes);
    // Depth is 4 ("web" vs "admin") -> uses "web/.../index.ts" vs "admin/.../index.ts"
    expect(labels.get('apps/web/src/components/index.ts')).toBe('web/.../index.ts');
    expect(labels.get('apps/admin/src/components/index.ts')).toBe('admin/.../index.ts');
    expect(labels.get('apps/web/src/components/index.ts')).not.toBe(labels.get('apps/admin/src/components/index.ts'));
  });

  it('handles root-level files and nested files sharing names', () => {
    const nodes = [
      { id: 'index.ts', relative_path: 'index.ts', filename: 'index.ts' },
      { id: 'src/index.ts', relative_path: 'src/index.ts', filename: 'index.ts' },
    ];
    const labels = computeDisambiguatedLabels(nodes);
    expect(labels.get('index.ts')).toBe('index.ts');
    expect(labels.get('src/index.ts')).toBe('src/index.ts');
  });
});


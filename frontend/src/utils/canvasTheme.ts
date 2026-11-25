export type CanvasThemeMode = 'dark' | 'light';

export interface CanvasThemeTokens {
  surfaceBg: string;
  cardBg: string;
  cardBorder: string;
  cardBorderHover: string;
  cardBorderSelected: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accentBrand: string;
  accentSky: string;
  accentTeal: string;
  accentAmber: string;
  accentRose: string;
  accentViolet: string;
  areaEdgeDefault: string;
  fileEdgeDefault: string;
  fileEdgeMuted: string;
}

const DARK_CANVAS_TOKENS: CanvasThemeTokens = {
  surfaceBg: '#0b0d11',
  cardBg: 'rgba(16, 19, 25, 0.90)',
  cardBorder: 'rgba(255, 255, 255, 0.10)',
  cardBorderHover: '#38bdf8',
  cardBorderSelected: '#5e6ad2',
  textPrimary: '#f0f2f5',
  textSecondary: '#9aa3b2',
  textMuted: '#687385',
  accentBrand: '#5e6ad2',
  accentSky: '#38bdf8',
  accentTeal: '#2dd4bf',
  accentAmber: '#f59e0b',
  accentRose: '#f472b6',
  accentViolet: '#a78bfa',
  areaEdgeDefault: 'rgba(148, 163, 184, 0.36)',
  fileEdgeDefault: 'rgba(148, 163, 184, 0.42)',
  fileEdgeMuted: 'rgba(148, 163, 184, 0.06)',
};

const LIGHT_CANVAS_TOKENS: CanvasThemeTokens = {
  surfaceBg: '#f8f9fb',
  cardBg: 'rgba(255, 255, 255, 0.94)',
  cardBorder: 'rgba(15, 23, 42, 0.10)',
  cardBorderHover: '#0284c7',
  cardBorderSelected: '#4f46e5',
  textPrimary: '#111827',
  textSecondary: '#4b5563',
  textMuted: '#6b7280',
  accentBrand: '#4f46e5',
  accentSky: '#0284c7',
  accentTeal: '#0d9488',
  accentAmber: '#d97706',
  accentRose: '#db2777',
  accentViolet: '#7c3aed',
  areaEdgeDefault: 'rgba(100, 116, 139, 0.34)',
  fileEdgeDefault: 'rgba(71, 85, 105, 0.40)',
  fileEdgeMuted: 'rgba(100, 116, 139, 0.08)',
};

/**
 * Returns pre-resolved, cached canvas theme tokens without per-frame DOM reads.
 */
export function getCanvasThemeTokens(theme: CanvasThemeMode = 'dark'): CanvasThemeTokens {
  return theme === 'light' ? LIGHT_CANVAS_TOKENS : DARK_CANVAS_TOKENS;
}

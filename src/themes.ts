import type { Settings, ThemePresetId } from './types';

export interface ThemePresetDef {
  id: ThemePresetId;
  name: string;
  category: 'Dark' | 'Light' | 'Ambient';
  mode: 'dark' | 'light';
  accent: string;
  previewSwatches: [string, string, string]; // [canvas, surface, accent]
  description: string;
}

export const THEME_PRESETS: ThemePresetDef[] = [
  {
    id: 'graphite',
    name: 'System Terminal',
    category: 'Dark',
    mode: 'dark',
    accent: '#FF3E00',
    previewSwatches: ['#080808', '#0F0F10', '#FF3E00'],
    description: 'Pure pitch-black terminal grid with Geist Mono and signal orange'
  },
  {
    id: 'braun-chalk',
    name: 'Braun Chalk',
    category: 'Light',
    mode: 'light',
    accent: '#E84A1A',
    previewSwatches: ['#ECEAE4', '#F6F5F0', '#E84A1A'],
    description: 'Warm industrial chalk with Braun orange keycaps'
  },
  {
    id: 'paper-swiss',
    name: 'Paper Swiss',
    category: 'Light',
    mode: 'light',
    accent: '#1D4ED8',
    previewSwatches: ['#F7F7F5', '#FFFFFF', '#1D4ED8'],
    description: 'Crisp Swiss studio white with cobalt accent'
  },
  {
    id: 'obsidian',
    name: 'Obsidian Mono',
    category: 'Dark',
    mode: 'dark',
    accent: '#22C55E',
    previewSwatches: ['#0C0D0E', '#151719', '#22C55E'],
    description: 'Deep monochrome instrument slate with emerald'
  },
  {
    id: 'field-olive',
    name: 'Field Olive',
    category: 'Ambient',
    mode: 'dark',
    accent: '#E59A38',
    previewSwatches: ['#161A17', '#1E241F', '#E59A38'],
    description: 'Muted field olive aluminum with warm amber'
  },
  {
    id: 'dusk-slate',
    name: 'Dusk Slate',
    category: 'Ambient',
    mode: 'dark',
    accent: '#38BDF8',
    previewSwatches: ['#12161E', '#1A202C', '#38BDF8'],
    description: 'Cool evening slate chassis with sky instrument blue'
  },
  {
    id: 'warm-travertine',
    name: 'Warm Travertine',
    category: 'Ambient',
    mode: 'light',
    accent: '#C84B24',
    previewSwatches: ['#E6DFD3', '#F2ECE1', '#C84B24'],
    description: 'Sunlit stone neutral with burnt sienna controls'
  }
];

export function getThemePreset(id: string | undefined): ThemePresetDef {
  return THEME_PRESETS.find((p) => p.id === id) ?? THEME_PRESETS[0];
}

export function applyTheme(settings: Settings): void {
  const preset = getThemePreset(settings.appearance.themePreset);
  const root = document.documentElement;
  root.dataset.theme = preset.id;
  root.dataset.colorScheme = preset.mode;
  root.dataset.clockScale = settings.appearance.clockScale || 'standard';
  root.dataset.density = settings.appearance.density || 'standard';
  delete root.dataset.surfaceGrid;

  if (settings.general.showDailyFocus === false) {
    root.dataset.hideFocus = 'true';
  } else {
    delete root.dataset.hideFocus;
  }

  if (settings.appearance.showBookmarkHosts === false) {
    root.dataset.hideHosts = 'true';
  } else {
    delete root.dataset.hideHosts;
  }

  if (settings.appearance.showBookmarkIndices === false) {
    root.dataset.hideIndices = 'true';
  } else {
    delete root.dataset.hideIndices;
  }

  const customAccent = settings.appearance.customAccent?.trim();
  if (customAccent && /^#[0-9a-fA-F]{6}$/.test(customAccent)) {
    root.style.setProperty('--accent', customAccent);
    root.style.setProperty('--accent-soft', hexToRgba(customAccent, preset.mode === 'light' ? 0.14 : 0.18));
    root.style.setProperty('--accent-border', hexToRgba(customAccent, 0.45));
  } else {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-soft');
    root.style.removeProperty('--accent-border');
  }

  const customBg = settings.appearance.customBg?.trim();
  if (customBg && /^#[0-9a-fA-F]{6}$/.test(customBg)) {
    root.style.setProperty('--bg-canvas', customBg);
  } else {
    root.style.removeProperty('--bg-canvas');
  }
}

export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

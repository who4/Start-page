// Modular Workspace Deck — registry, drag-and-drop layout persistence, presets.

import { storage } from './storage';

export interface WidgetSize {
  colSpan: number; // 1–4 cols
  rowSpan: number; // 1–2 rows
}

export interface WidgetDef {
  id: string;
  title: string;
  defaultSize: WidgetSize;
  render: (container: HTMLElement) => void | Promise<void>;
  cleanup?: () => void;
}

export interface WidgetEntry {
  id: string;
  enabled: boolean;
  colSpan: number;
  rowSpan: number;
}

export interface LayoutData {
  presetId: string;
  widgets: WidgetEntry[];
  updatedAt: number;
}

const LAYOUT_KEY = 'bentoLayoutV2';
const COLS = 4;

const DEFAULT_WIDGETS: WidgetEntry[] = [
  { id: 'finance', enabled: true, colSpan: 2, rowSpan: 1 },
  { id: 'weather', enabled: true, colSpan: 2, rowSpan: 1 },
  { id: 'calendar', enabled: true, colSpan: 2, rowSpan: 2 },
  { id: 'rss', enabled: true, colSpan: 2, rowSpan: 2 }
];

const DEFAULT_LAYOUT: LayoutData = {
  presetId: 'balanced',
  widgets: DEFAULT_WIDGETS.map((w) => ({ ...w })),
  updatedAt: 0
};

export interface LayoutPreset {
  id: string;
  name: string;
  spans: Array<{ colSpan: number; rowSpan: number }>;
}

export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: 'balanced',
    name: 'Balanced',
    spans: [
      { colSpan: 2, rowSpan: 1 },
      { colSpan: 2, rowSpan: 1 },
      { colSpan: 2, rowSpan: 2 },
      { colSpan: 2, rowSpan: 2 }
    ]
  },
  {
    id: 'compact',
    name: 'Compact',
    spans: [
      { colSpan: 2, rowSpan: 1 },
      { colSpan: 2, rowSpan: 1 },
      { colSpan: 2, rowSpan: 1 },
      { colSpan: 2, rowSpan: 1 }
    ]
  },
  {
    id: 'wide',
    name: 'Wide',
    spans: [
      { colSpan: 4, rowSpan: 1 },
      { colSpan: 2, rowSpan: 2 },
      { colSpan: 2, rowSpan: 2 },
      { colSpan: 4, rowSpan: 1 }
    ]
  }
];

// --- Registry ---

class WidgetRegistry {
  private widgets = new Map<string, WidgetDef>();

  register(def: WidgetDef): void {
    this.widgets.set(def.id, def);
  }

  get(id: string): WidgetDef | undefined {
    return this.widgets.get(id);
  }

  getAll(): WidgetDef[] {
    return Array.from(this.widgets.values());
  }
}

export const registry = new WidgetRegistry();

// --- Layout persistence ---

export async function loadLayout(): Promise<LayoutData> {
  const raw = await storage.get<LayoutData | undefined>(LAYOUT_KEY);
  if (!raw || !Array.isArray(raw.widgets) || raw.widgets.length === 0) {
    return {
      presetId: DEFAULT_LAYOUT.presetId,
      widgets: DEFAULT_LAYOUT.widgets.map((w) => ({ ...w })),
      updatedAt: 0
    };
  }

  // Ensure any newly registered widgets are represented
  const knownIds = new Set(raw.widgets.map((w) => w.id));
  const merged = raw.widgets.map((w) => ({ ...w }));
  for (const def of registry.getAll()) {
    if (!knownIds.has(def.id)) {
      merged.push({
        id: def.id,
        enabled: true,
        colSpan: def.defaultSize.colSpan,
        rowSpan: def.defaultSize.rowSpan
      });
    }
  }
  return {
    presetId: raw.presetId || 'balanced',
    widgets: merged,
    updatedAt: raw.updatedAt || 0
  };
}

export async function saveLayout(layout: LayoutData): Promise<void> {
  layout.updatedAt = Date.now();
  await storage.set(LAYOUT_KEY, layout);
}

export async function isWidgetEnabled(id: string): Promise<boolean> {
  const layout = await loadLayout();
  const entry = layout.widgets.find((w) => w.id === id);
  return entry?.enabled ?? false;
}

export async function setWidgetEnabled(id: string, enabled: boolean): Promise<void> {
  const layout = await loadLayout();
  const entry = layout.widgets.find((w) => w.id === id);
  if (entry) {
    entry.enabled = enabled;
  } else {
    const def = registry.get(id);
    layout.widgets.push({
      id,
      enabled,
      colSpan: def?.defaultSize.colSpan ?? 2,
      rowSpan: def?.defaultSize.rowSpan ?? 1
    });
  }
  await saveLayout(layout);
}

export async function applyLayoutPreset(presetId: string): Promise<void> {
  const preset = LAYOUT_PRESETS.find((p) => p.id === presetId);
  if (!preset) return;
  const layout = await loadLayout();
  layout.presetId = presetId;
  const enabled = layout.widgets.filter((w) => w.enabled);
  enabled.forEach((w, idx) => {
    const span = preset.spans[idx % preset.spans.length];
    w.colSpan = span.colSpan;
    w.rowSpan = span.rowSpan;
  });
  await saveLayout(layout);
}

export async function getCurrentPresetId(): Promise<string> {
  const layout = await loadLayout();
  return layout.presetId || 'balanced';
}

// --- Grid Renderer ---

export interface GridOptions {
  container: HTMLElement;
  shelfContainer?: HTMLElement | null;
  onCustomizeToggle?: (active: boolean) => void;
  onLayoutChange?: () => void;
}

export class BentoGrid {
  private layout: LayoutData = DEFAULT_LAYOUT;
  private activeWidgets = new Map<string, { def: WidgetDef; container: HTMLElement }>();
  private customizeMode = false;
  private gridEl!: HTMLElement;
  private dragWidgetId: string | null = null;

  constructor(private options: GridOptions) {}

  async init(): Promise<void> {
    this.layout = await loadLayout();
    this.renderGridShell();
    await this.mountActiveWidgets();
    this.renderShelf();
  }

  get isCustomizing(): boolean {
    return this.customizeMode;
  }

  private renderGridShell(): void {
    this.options.container.replaceChildren();
    this.gridEl = document.createElement('div');
    this.gridEl.className = 'deck-grid';
    this.options.container.appendChild(this.gridEl);
  }

  private async mountActiveWidgets(): Promise<void> {
    const enabled = this.layout.widgets.filter((w) => w.enabled && Boolean(registry.get(w.id)));

    if (enabled.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'deck-empty';
      empty.textContent = 'All modules are hidden. Enable modules from the shelf above or Preferences.';
      this.gridEl.appendChild(empty);
      return;
    }

    for (const entry of enabled) {
      const def = registry.get(entry.id);
      if (!def) continue;

      const slot = document.createElement('section');
      slot.className = 'deck-module';
      slot.dataset.widgetId = entry.id;
      slot.dataset.colSpan = String(Math.max(1, Math.min(COLS, entry.colSpan)));
      slot.dataset.rowSpan = String(Math.max(1, Math.min(2, entry.rowSpan)));
      slot.setAttribute('aria-label', def.title);

      const body = document.createElement('div');
      body.className = 'deck-module-body';
      slot.appendChild(body);

      if (this.customizeMode) {
        slot.classList.add('deck-module--editing');
        slot.draggable = true;
        this.attachCustomizeControls(slot, entry, def);
        this.attachDragHandlers(slot, entry.id);
      }

      this.gridEl.appendChild(slot);
      this.activeWidgets.set(entry.id, { def, container: body });

      try {
        await def.render(body);
      } catch (e) {
        console.warn(`Widget "${entry.id}" render error:`, e);
      }
    }
  }

  private attachCustomizeControls(slot: HTMLElement, entry: WidgetEntry, def: WidgetDef): void {
    const bar = document.createElement('div');
    bar.className = 'deck-edit-bar';

    const label = document.createElement('span');
    label.className = 'deck-edit-title';
    label.textContent = `⋮⋮ ${def.title}`;

    const actions = document.createElement('div');
    actions.className = 'deck-edit-actions';

    const sizeBtn = document.createElement('button');
    sizeBtn.type = 'button';
    sizeBtn.className = 'deck-edit-btn';
    sizeBtn.textContent = `${entry.colSpan}×${entry.rowSpan}`;
    sizeBtn.title = 'Cycle module size';
    sizeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.cycleSize(entry.id);
    });

    const hideBtn = document.createElement('button');
    hideBtn.type = 'button';
    hideBtn.className = 'deck-edit-btn deck-edit-btn--danger';
    hideBtn.textContent = 'Hide';
    hideBtn.title = `Hide ${def.title}`;
    hideBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      entry.enabled = false;
      await saveLayout(this.layout);
      await this.refresh();
    });

    actions.append(sizeBtn, hideBtn);
    bar.append(label, actions);
    slot.insertBefore(bar, slot.firstChild);
  }

  private attachDragHandlers(slot: HTMLElement, widgetId: string): void {
    slot.addEventListener('dragstart', (e) => {
      this.dragWidgetId = widgetId;
      slot.classList.add('deck-module--dragging');
      e.dataTransfer?.setData('text/plain', widgetId);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });

    slot.addEventListener('dragend', () => {
      this.dragWidgetId = null;
      slot.classList.remove('deck-module--dragging');
      this.gridEl.querySelectorAll('.deck-module--drop-target').forEach((el) => {
        el.classList.remove('deck-module--drop-target');
      });
    });

    slot.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (this.dragWidgetId && this.dragWidgetId !== widgetId) {
        slot.classList.add('deck-module--drop-target');
      }
    });

    slot.addEventListener('dragleave', () => {
      slot.classList.remove('deck-module--drop-target');
    });

    slot.addEventListener('drop', (e) => {
      e.preventDefault();
      slot.classList.remove('deck-module--drop-target');
      const fromId = this.dragWidgetId;
      if (!fromId || fromId === widgetId) return;
      void this.reorderWidgets(fromId, widgetId);
    });
  }

  private async reorderWidgets(fromId: string, toId: string): Promise<void> {
    const fromIdx = this.layout.widgets.findIndex((w) => w.id === fromId);
    const toIdx = this.layout.widgets.findIndex((w) => w.id === toId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;

    const [moved] = this.layout.widgets.splice(fromIdx, 1);
    this.layout.widgets.splice(toIdx, 0, moved);
    this.layout.presetId = 'custom';
    await saveLayout(this.layout);
    await this.refresh();
  }

  private async cycleSize(widgetId: string): Promise<void> {
    const entry = this.layout.widgets.find((w) => w.id === widgetId);
    if (!entry) return;

    const sizes: Array<[number, number]> = [
      [1, 1],
      [2, 1],
      [2, 2],
      [4, 1],
      [4, 2]
    ];
    const currentIdx = sizes.findIndex(([c, r]) => c === entry.colSpan && r === entry.rowSpan);
    const [nextCol, nextRow] = sizes[(currentIdx + 1) % sizes.length];
    entry.colSpan = nextCol;
    entry.rowSpan = nextRow;
    this.layout.presetId = 'custom';
    await saveLayout(this.layout);
    await this.refresh();
  }

  private renderShelf(): void {
    const shelf = this.options.shelfContainer;
    if (!shelf) return;
    shelf.replaceChildren();
    shelf.hidden = !this.customizeMode;
    if (!this.customizeMode) return;

    const label = document.createElement('span');
    label.className = 'deck-shelf-label';
    label.textContent = 'Modules · Drag cards to reorder:';
    shelf.appendChild(label);

    for (const def of registry.getAll()) {
      const entry = this.layout.widgets.find((w) => w.id === def.id);
      const isEnabled = entry?.enabled ?? false;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'deck-shelf-btn' + (isEnabled ? ' is-active' : '');
      btn.textContent = `${isEnabled ? '✓' : '+'} ${def.title}`;
      btn.addEventListener('click', async () => {
        await setWidgetEnabled(def.id, !isEnabled);
        await this.refresh();
      });
      shelf.appendChild(btn);
    }
  }

  toggleCustomize(force?: boolean): boolean {
    this.customizeMode = force !== undefined ? force : !this.customizeMode;
    this.options.container.classList.toggle('deck-customize-active', this.customizeMode);
    this.options.onCustomizeToggle?.(this.customizeMode);
    void this.refresh();
    return this.customizeMode;
  }

  async applyPreset(presetId: string): Promise<void> {
    await applyLayoutPreset(presetId);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    for (const { def } of this.activeWidgets.values()) {
      def.cleanup?.();
    }
    this.activeWidgets.clear();
    this.gridEl.replaceChildren();

    this.layout = await loadLayout();
    await this.mountActiveWidgets();
    this.renderShelf();
    this.options.onLayoutChange?.();
  }

  destroy(): void {
    for (const [, { def }] of this.activeWidgets) {
      def.cleanup?.();
    }
    this.activeWidgets.clear();
    this.options.container.replaceChildren();
  }
}

// Type guard extension for clarity
declare global {
  interface Map<K, V> {
    has(key: K): boolean;
  }
}

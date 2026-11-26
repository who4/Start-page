// Spatial Scratchpad — floating tactile index cards + slide-over Scratchpad Tray.
import { storage } from './storage';
import type { NoteData } from './types';

type SwatchId = NonNullable<NoteData['swatch']>;

const SWATCHES: Array<{ id: SwatchId; label: string }> = [
  { id: 'surface', label: 'Default' },
  { id: 'orange', label: 'Signal' },
  { id: 'cobalt', label: 'Cobalt' },
  { id: 'sage', label: 'Sage' },
  { id: 'ochre', label: 'Ochre' },
  { id: 'graphite', label: 'Deep' }
];

export interface ScratchpadDeps {
  canvasEl: HTMLElement;
  trayEl: HTMLElement;
  onToast: (message: string, undo?: () => void) => void;
  onCountChange?: (count: number) => void;
}

export class SpatialScratchpad {
  private notes: NoteData[] = [];
  private visible = true;
  private trayOpen = false;
  private searchFilter = '';
  private zCounter = 10;

  constructor(private deps: ScratchpadDeps) {}

  async init(): Promise<void> {
    this.notes = await storage.getNotes();
    this.visible = await storage.getNotesVisible();
    this.applyVisibility();
    this.renderAllCards();
    this.renderTray();
    this.deps.onCountChange?.(this.notes.length);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes['stickyNotes']) return;
      const incoming = (changes['stickyNotes'].newValue as NoteData[] | undefined) || [];
      this.reconcileExternal(incoming);
    });
  }

  get isTrayOpen(): boolean {
    return this.trayOpen;
  }

  get allNotes(): NoteData[] {
    return this.notes;
  }

  toggleTray(force?: boolean): boolean {
    this.trayOpen = force !== undefined ? force : !this.trayOpen;
    this.deps.trayEl.classList.toggle('is-open', this.trayOpen);
    this.deps.trayEl.setAttribute('aria-hidden', String(!this.trayOpen));
    if (this.trayOpen) this.renderTray();
    return this.trayOpen;
  }

  async setCanvasVisible(show: boolean): Promise<void> {
    this.visible = show;
    await storage.setNotesVisible(show);
    this.applyVisibility();
    this.renderTray();
  }

  private applyVisibility(): void {
    this.deps.canvasEl.classList.toggle('is-hidden', !this.visible);
  }

  async createNote(initialTitle = ''): Promise<NoteData> {
    if (!this.visible) {
      await this.setCanvasVisible(true);
    }
    const idx = this.notes.length;
    const pos = this.clampPosition(48 + (idx % 6) * 28, 44 + (idx % 5) * 26);
    const note: NoteData = {
      id: Date.now(),
      title: initialTitle,
      x: pos.x,
      y: pos.y,
      width: 260,
      text: '',
      swatch: 'surface',
      checklist: false,
      pinned: false,
      collapsed: false,
      updatedAt: Date.now()
    };
    this.notes.push(note);
    this.mountCard(note, true);
    await this.persist();
    this.renderTray();
    return note;
  }

  exportMarkdown(): void {
    if (this.notes.length === 0) {
      this.deps.onToast('No notes to export');
      return;
    }
    const md = this.notes
      .map((n) => {
        const heading = n.title?.trim() ? `## ${n.title.trim()}\n\n` : '';
        const body = n.checklist
          ? n.text
              .split('\n')
              .filter(Boolean)
              .map((l) => (l.startsWith('✓ ') ? `- [x] ${l.slice(2)}` : `- [ ] ${l}`))
              .join('\n')
          : n.text;
        return `${heading}${body}\n`;
      })
      .join('\n---\n\n');
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `start-scratchpad-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
    this.deps.onToast('Exported scratchpad as Markdown');
  }

  private async persist(): Promise<void> {
    this.deps.onCountChange?.(this.notes.length);
    await storage.setNotes(this.notes);
  }

  private reconcileExternal(incoming: NoteData[]): void {
    this.notes
      .filter((n) => !incoming.some((r) => r.id === n.id))
      .forEach((n) => {
        this.deps.canvasEl.querySelector(`[data-note-id="${n.id}"]`)?.remove();
      });

    incoming.forEach((remote) => {
      const local = this.notes.find((n) => n.id === remote.id);
      if (!local) {
        this.mountCard(remote, false);
      } else {
        const el = this.deps.canvasEl.querySelector(`[data-note-id="${remote.id}"]`) as HTMLElement | null;
        if (el) {
          const activeInside = el.contains(document.activeElement);
          if (!activeInside) {
            el.style.left = `${remote.x}px`;
            el.style.top = `${remote.y}px`;
            const ta = el.querySelector<HTMLTextAreaElement>('textarea.note-content');
            if (ta && ta.value !== remote.text) {
              ta.value = remote.text;
              this.autoResize(ta);
            }
          }
        }
      }
    });

    this.notes = incoming.map((n) => ({ ...n }));
    this.deps.onCountChange?.(this.notes.length);
    if (this.trayOpen) this.renderTray();
  }

  private clampPosition(x: number, y: number): { x: number; y: number } {
    const margin = 48;
    const maxX = Math.max(margin, window.innerWidth - 160);
    const maxY = Math.max(24, window.innerHeight - 96);
    return {
      x: Math.min(Math.max(x, 12), maxX),
      y: Math.min(Math.max(y, 16), maxY)
    };
  }

  private autoResize(ta: HTMLTextAreaElement): void {
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(68, ta.scrollHeight)}px`;
  }

  private renderAllCards(): void {
    this.deps.canvasEl.replaceChildren();
    for (const note of this.notes) {
      this.mountCard(note, false);
    }
  }

  private focusNote(id: number): void {
    const el = this.deps.canvasEl.querySelector(`[data-note-id="${id}"]`) as HTMLElement | null;
    if (!el) return;
    el.style.zIndex = String(++this.zCounter);
    const input = el.querySelector<HTMLElement>('textarea.note-content, input.note-check-add, input.note-title-input');
    input?.focus();
  }

  private mountCard(note: NoteData, isNew: boolean): void {
    const card = document.createElement('article');
    card.className = 'scratch-card';
    card.dataset.noteId = String(note.id);
    card.dataset.swatch = note.swatch || 'surface';
    if (note.collapsed) card.classList.add('is-collapsed');

    const pos = this.clampPosition(note.x, note.y);
    card.style.left = `${pos.x}px`;
    card.style.top = `${pos.y}px`;
    card.style.width = `${Math.max(220, Math.min(460, note.width || 260))}px`;
    card.style.zIndex = note.pinned ? '900' : String(++this.zCounter);

    card.addEventListener('mousedown', () => {
      if (!note.pinned) card.style.zIndex = String(++this.zCounter);
    });

    // Header
    const header = document.createElement('div');
    header.className = 'scratch-header';

    const grip = document.createElement('span');
    grip.className = 'scratch-grip';
    grip.textContent = '⋮⋮';
    grip.title = 'Drag note';

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'note-title-input';
    titleInput.placeholder = 'Untitled note';
    titleInput.value = note.title || '';
    titleInput.addEventListener('mousedown', (e) => e.stopPropagation());
    titleInput.addEventListener('input', () => {
      note.title = titleInput.value;
      note.updatedAt = Date.now();
      void this.persist();
      if (this.trayOpen) this.renderTray();
    });

    const tools = document.createElement('div');
    tools.className = 'scratch-tools';

    const checklistIconSvg = (active: boolean): string =>
      active
        ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 7 2 2 4-4"/><path d="m3 17 2 2 4-4"/><path d="M13 7h8"/><path d="M13 17h8"/></svg>'
        : '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="5" height="5" rx="0.5"/><rect x="3" y="14.5" width="5" height="5" rx="0.5"/><path d="M12 7h9"/><path d="M12 17h9"/></svg>';

    const pinIconSvg = (active: boolean): string =>
      active
        ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';

    const checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.className = 'scratch-tool-btn' + (note.checklist ? ' is-active' : '');
    checkBtn.innerHTML = checklistIconSvg(Boolean(note.checklist));
    checkBtn.title = 'Toggle checklist mode';
    checkBtn.setAttribute('aria-label', 'Toggle checklist mode');
    checkBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    checkBtn.addEventListener('click', () => {
      note.checklist = !note.checklist;
      note.updatedAt = Date.now();
      checkBtn.innerHTML = checklistIconSvg(note.checklist);
      checkBtn.classList.toggle('is-active', note.checklist);
      this.rebuildBody(bodyWrap, note);
      void this.persist();
    });

    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'scratch-tool-btn' + (note.pinned ? ' is-active' : '');
    pinBtn.innerHTML = pinIconSvg(Boolean(note.pinned));
    pinBtn.title = note.pinned ? 'Unpin from top' : 'Pin to top';
    pinBtn.setAttribute('aria-label', note.pinned ? 'Unpin from top' : 'Pin to top');
    pinBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    pinBtn.addEventListener('click', () => {
      note.pinned = !note.pinned;
      card.style.zIndex = note.pinned ? '900' : String(++this.zCounter);
      pinBtn.innerHTML = pinIconSvg(note.pinned);
      pinBtn.title = note.pinned ? 'Unpin from top' : 'Pin to top';
      pinBtn.setAttribute('aria-label', note.pinned ? 'Unpin from top' : 'Pin to top');
      pinBtn.classList.toggle('is-active', note.pinned);
      void this.persist();
    });

    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'scratch-tool-btn';
    collapseBtn.textContent = note.collapsed ? '+' : '−';
    collapseBtn.title = note.collapsed ? 'Expand note' : 'Collapse note';
    collapseBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    collapseBtn.addEventListener('click', () => {
      note.collapsed = !note.collapsed;
      card.classList.toggle('is-collapsed', note.collapsed);
      collapseBtn.textContent = note.collapsed ? '+' : '−';
      void this.persist();
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'scratch-tool-btn scratch-tool-btn--danger';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Delete note');
    closeBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    closeBtn.addEventListener('click', () => {
      const removed = { ...note };
      const removedIdx = this.notes.findIndex((n) => n.id === note.id);
      this.notes = this.notes.filter((n) => n.id !== note.id);
      card.remove();
      void this.persist();
      if (this.trayOpen) this.renderTray();
      this.deps.onToast(`Deleted "${removed.title?.trim() || 'note'}"`, () => {
        this.notes.splice(Math.min(removedIdx, this.notes.length), 0, removed);
        this.mountCard(removed, false);
        void this.persist();
        if (this.trayOpen) this.renderTray();
      });
    });

    tools.append(checkBtn, pinBtn, collapseBtn, closeBtn);
    header.append(grip, titleInput, tools);

    // Body
    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'scratch-body';
    this.rebuildBody(bodyWrap, note);

    // Footer: swatch dots + copy + resize corner
    const footer = document.createElement('div');
    footer.className = 'scratch-footer';

    const swatches = document.createElement('div');
    swatches.className = 'scratch-swatches';
    for (const sw of SWATCHES) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'scratch-swatch' + ((note.swatch || 'surface') === sw.id ? ' is-selected' : '');
      dot.dataset.swatch = sw.id;
      dot.title = `${sw.label} surface`;
      dot.addEventListener('click', () => {
        note.swatch = sw.id;
        card.dataset.swatch = sw.id;
        swatches.querySelectorAll('.scratch-swatch').forEach((b) => {
          b.classList.toggle('is-selected', (b as HTMLElement).dataset.swatch === sw.id);
        });
        void this.persist();
      });
      swatches.appendChild(dot);
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'scratch-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      const full = [note.title?.trim(), note.text].filter(Boolean).join('\n');
      try {
        await navigator.clipboard.writeText(full);
        this.deps.onToast('Note copied to clipboard');
      } catch {
        // ignore
      }
    });

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'scratch-resize';
    resizeHandle.title = 'Drag to resize';
    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = card.offsetWidth;
      const onMove = (ev: MouseEvent): void => {
        const nextW = Math.max(220, Math.min(460, startW + (ev.clientX - startX)));
        card.style.width = `${nextW}px`;
      };
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        note.width = card.offsetWidth;
        void this.persist();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    footer.append(swatches, copyBtn, resizeHandle);
    card.append(header, bodyWrap, footer);
    this.deps.canvasEl.appendChild(card);

    // Drag header
    header.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = card.offsetLeft;
      const startTop = card.offsetTop;

      const onMove = (ev: MouseEvent): void => {
        const next = this.clampPosition(startLeft + (ev.clientX - startX), startTop + (ev.clientY - startY));
        card.style.left = `${next.x}px`;
        card.style.top = `${next.y}px`;
      };

      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        note.x = parseInt(card.style.left, 10) || pos.x;
        note.y = parseInt(card.style.top, 10) || pos.y;
        void this.persist();
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    if (isNew) {
      const target = card.querySelector<HTMLElement>('textarea.note-content, input.note-check-add');
      target?.focus();
    }
  }

  private rebuildBody(container: HTMLElement, note: NoteData): void {
    container.replaceChildren();

    if (note.checklist) {
      const list = document.createElement('div');
      list.className = 'scratch-checklist';
      const lines = note.text ? note.text.split('\n') : [];

      lines.forEach((line, i) => {
        const isChecked = line.startsWith('✓ ');
        const row = document.createElement('label');
        row.className = 'scratch-check-row' + (isChecked ? ' is-done' : '');

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = isChecked;
        cb.addEventListener('change', () => {
          lines[i] = cb.checked ? `✓ ${lines[i].replace(/^✓ /, '')}` : lines[i].replace(/^✓ /, '');
          note.text = lines.join('\n');
          note.updatedAt = Date.now();
          row.classList.toggle('is-done', cb.checked);
          void this.persist();
        });

        const text = document.createElement('span');
        text.textContent = isChecked ? line.slice(2) : line;

        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'scratch-check-del';
        rm.textContent = '×';
        rm.addEventListener('click', (e) => {
          e.preventDefault();
          lines.splice(i, 1);
          note.text = lines.join('\n');
          note.updatedAt = Date.now();
          this.rebuildBody(container, note);
          void this.persist();
        });

        row.append(cb, text, rm);
        list.appendChild(row);
      });

      const addInput = document.createElement('input');
      addInput.type = 'text';
      addInput.className = 'note-check-add';
      addInput.placeholder = '+ Add checklist item (Enter)';
      addInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && addInput.value.trim()) {
          lines.push(addInput.value.trim());
          note.text = lines.join('\n');
          note.updatedAt = Date.now();
          addInput.value = '';
          this.rebuildBody(container, note);
          const nextInput = container.querySelector<HTMLInputElement>('input.note-check-add');
          nextInput?.focus();
          void this.persist();
        }
      });

      list.appendChild(addInput);
      container.appendChild(list);
    } else {
      const ta = document.createElement('textarea');
      ta.className = 'note-content';
      ta.placeholder = 'Write quick thoughts, snippets, or links...';
      ta.value = note.text;
      ta.addEventListener('input', () => {
        this.autoResize(ta);
        note.text = ta.value;
        note.updatedAt = Date.now();
        void this.persist();
      });
      container.appendChild(ta);
      requestAnimationFrame(() => this.autoResize(ta));
    }
  }

  private renderTray(): void {
    const tray = this.deps.trayEl;
    tray.replaceChildren();

    const header = document.createElement('div');
    header.className = 'tray-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'tray-title-wrap';
    const title = document.createElement('h2');
    title.className = 'tray-title';
    title.textContent = 'Scratchpad';
    const count = document.createElement('span');
    count.className = 'mod-meta';
    count.textContent = `${this.notes.length} ${this.notes.length === 1 ? 'note' : 'notes'}`;
    titleWrap.append(title, count);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'hw-mini-btn';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Close scratchpad tray');
    closeBtn.addEventListener('click', () => this.toggleTray(false));

    header.append(titleWrap, closeBtn);

    // Controls strip
    const toolbar = document.createElement('div');
    toolbar.className = 'tray-toolbar';

    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'hw-btn hw-btn--accent';
    newBtn.textContent = '+ New Note';
    newBtn.addEventListener('click', () => void this.createNote());

    const visBtn = document.createElement('button');
    visBtn.type = 'button';
    visBtn.className = 'hw-btn' + (this.visible ? ' is-active' : '');
    visBtn.textContent = this.visible ? 'Canvas: On' : 'Canvas: Off';
    visBtn.addEventListener('click', () => void this.setCanvasVisible(!this.visible));

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'hw-btn';
    exportBtn.textContent = 'Export .md';
    exportBtn.addEventListener('click', () => this.exportMarkdown());

    toolbar.append(newBtn, visBtn, exportBtn);

    // Filter input
    const filterWrap = document.createElement('div');
    filterWrap.className = 'tray-search-wrap';
    const filterInput = document.createElement('input');
    filterInput.type = 'text';
    filterInput.className = 'hw-input-sm';
    filterInput.placeholder = 'Filter notes...';
    filterInput.value = this.searchFilter;
    filterInput.addEventListener('input', () => {
      this.searchFilter = filterInput.value;
      renderList();
    });
    filterWrap.appendChild(filterInput);

    // List
    const list = document.createElement('div');
    list.className = 'tray-list';

    const renderList = (): void => {
      list.replaceChildren();
      const q = this.searchFilter.trim().toLowerCase();
      const filtered = this.notes.filter((n) => {
        if (!q) return true;
        return (n.title || '').toLowerCase().includes(q) || n.text.toLowerCase().includes(q);
      });

      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'mod-empty';
        empty.textContent = this.notes.length === 0 ? 'No notes yet. Create one to start your spatial scratchpad.' : 'No notes match your filter.';
        list.appendChild(empty);
        return;
      }

      for (const n of [...filtered].reverse()) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'tray-note-item';
        item.dataset.swatch = n.swatch || 'surface';

        const top = document.createElement('div');
        top.className = 'tray-note-title';
        top.textContent = n.title?.trim() || 'Untitled note';

        const preview = document.createElement('div');
        preview.className = 'tray-note-preview';
        preview.textContent = n.text.trim() ? n.text.trim().slice(0, 96) : 'Empty note';

        item.append(top, preview);
        item.addEventListener('click', async () => {
          if (!this.visible) await this.setCanvasVisible(true);
          this.focusNote(n.id);
        });
        list.appendChild(item);
      }
    };

    renderList();
    tray.append(header, toolbar, filterWrap, list);
  }
}

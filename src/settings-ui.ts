import { clearClipboardHistory } from './chrome-providers';
import { BUILT_IN_BANGS, deleteCustomBang, getCustomBangs, saveCustomBang } from './commandbar';
import { FINANCE_ASSETS, getNewsSource, NEWS_SOURCES, type FinanceAssetId } from './constants';
import { isWidgetEnabled, registry, setWidgetEnabled } from './grid';
import { t } from './i18n';
import { DEFAULT_SETTINGS, storage } from './storage';
import { THEME_PRESETS } from './themes';
import type {
  AccentName,
  BookmarkIconStyle,
  ClockScale,
  LayoutDensity,
  ScrollbarStyle,
  Settings,
  TempUnit
} from './types';
import { createCitySearchControl } from './widget-weather';

export interface AccentDef {
  name: Exclude<AccentName, 'random'>;
  color: string;
  text: string;
}

// Preserved export for compatibility
export const ACCENTS: AccentDef[] = [
  { name: 'orange', color: 'rgba(255, 85, 0, 0.16)', text: '#FF5500' },
  { name: 'blue', color: 'rgba(29, 78, 216, 0.16)', text: '#3B82F6' },
  { name: 'teal', color: 'rgba(20, 184, 166, 0.16)', text: '#14B8A6' },
  { name: 'gold', color: 'rgba(229, 154, 56, 0.16)', text: '#E59A38' },
  { name: 'lime', color: 'rgba(34, 197, 94, 0.16)', text: '#22C55E' },
  { name: 'rose', color: 'rgba(239, 68, 68, 0.16)', text: '#EF4444' }
];

type SectionId = 'general' | 'appearance' | 'commands' | 'modules' | 'privacy';

interface Section {
  id: SectionId;
  label: string;
}

const SECTIONS: Section[] = [
  { id: 'general', label: 'General & Feeds' },
  { id: 'appearance', label: 'Themes & Layout' },
  { id: 'modules', label: 'Widgets & Modules' },
  { id: 'commands', label: 'Commands & Bangs' },
  { id: 'privacy', label: 'Privacy & Backup' }
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  textContent?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
}

export interface SettingsUICallbacks {
  onChange: (settings: Settings) => Promise<void> | void;
  onModulesChange?: () => Promise<void> | void;
  onToast?: (message: string) => void;
}

export class SettingsUI {
  private settings: Settings;
  private modal: HTMLElement;
  private contentArea!: HTMLElement;
  private navButtons = new Map<SectionId, HTMLElement>();
  private activeSection: SectionId = 'general';

  constructor(settings: Settings, private callbacks: SettingsUICallbacks) {
    this.settings = structuredClone(settings);

    const shell = document.getElementById('settings-modal')!;
    shell.replaceChildren();
    this.modal = shell;

    this.buildShell();
  }

  syncExternal(settings: Settings): void {
    this.settings = structuredClone(settings);
    if (this.isOpen) void this.render();
  }

  async open(section?: SectionId): Promise<void> {
    if (section) this.activeSection = section;
    this.modal.style.display = 'flex';
    await this.render();
  }

  close(): void {
    this.modal.style.display = 'none';
  }

  get isOpen(): boolean {
    return this.modal.style.display !== 'none' && this.modal.style.display !== '';
  }

  private buildShell(): void {
    const content = el('div', 'modal-content settings-content');
    const header = el('div', 'modal-header');
    header.appendChild(el('h2', undefined, t('settings')));
    const closeBtn = el('button', 'close-btn');
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Close preferences');
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);
    content.appendChild(header);

    const body = el('div', 'settings-body');
    const sidebar = el('nav', 'settings-sidebar');
    sidebar.setAttribute('aria-label', t('settings'));

    for (const section of SECTIONS) {
      const btn = el('button', 'settings-nav-item', section.label);
      btn.type = 'button';
      btn.dataset.section = section.id;
      btn.addEventListener('click', () => {
        this.activeSection = section.id;
        void this.render();
      });
      this.navButtons.set(section.id, btn);
      sidebar.appendChild(btn);
    }

    this.contentArea = el('div', 'settings-panel');
    body.append(sidebar, this.contentArea);
    content.appendChild(body);
    this.modal.appendChild(content);

    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });
  }

  private async render(): Promise<void> {
    this.navButtons.forEach((btn, id) => {
      btn.classList.toggle('active', id === this.activeSection);
    });
    this.contentArea.replaceChildren();

    switch (this.activeSection) {
      case 'general':
        this.renderGeneral();
        break;
      case 'appearance':
        this.renderAppearance();
        break;
      case 'commands':
        await this.renderCommands();
        break;
      case 'modules':
        await this.renderModules();
        break;
      case 'privacy':
        this.renderPrivacy();
        break;
    }
  }

  private async update(partial: (s: Settings) => void): Promise<void> {
    partial(this.settings);
    await this.callbacks.onChange(structuredClone(this.settings));
    await this.render();
  }

  private buildToggle(labelText: string, value: boolean, onToggle: () => void): HTMLElement {
    const group = el('div', 'form-group widget-toggle-group');
    const row = el('div', 'widget-toggle-row');
    row.appendChild(el('span', 'widget-toggle-label', labelText));

    const track = el('button', 'toggle-track' + (value ? ' on' : ''));
    track.type = 'button';
    track.setAttribute('role', 'switch');
    track.setAttribute('aria-checked', String(value));
    track.appendChild(el('span', 'toggle-knob'));
    track.addEventListener('click', onToggle);

    row.appendChild(track);
    group.appendChild(row);
    return group;
  }

  private buildSegGroup<T extends string>(
    labelText: string,
    currentValue: T,
    options: ReadonlyArray<readonly [T, string]>,
    onPick: (val: T) => void
  ): HTMLElement {
    const group = el('div', 'form-group');
    group.appendChild(el('label', undefined, labelText));
    const row = el('div', 'seg-row');
    for (const [value, text] of options) {
      const btn = el('button', 'seg-btn' + (currentValue === value ? ' active' : ''), text);
      btn.type = 'button';
      btn.addEventListener('click', () => onPick(value));
      row.appendChild(btn);
    }
    group.appendChild(row);
    return group;
  }

  // --- Tab 1: General & Weather ---
  private renderGeneral(): void {
    // Weather location (any city worldwide + GPS)
    const weatherGroup = el('div', 'form-group');
    weatherGroup.appendChild(el('label', undefined, 'Weather city (worldwide)'));

    const loc = this.settings.weather;
    const cityPicker = createCitySearchControl({
      currentLocation: loc,
      compact: false,
      onSelect: async (nextLoc) => {
        await this.update((s) => {
          s.weather = { ...nextLoc, unit: s.weather.unit ?? 'c' };
        });
        this.callbacks.onToast?.(
          nextLoc.useGeolocation ? 'Weather set to Local GPS' : `Weather city set to ${nextLoc.city}`
        );
      }
    });

    const locMeta = el(
      'div',
      'settings-note',
      loc.useGeolocation
        ? 'Active: Local GPS coordinates'
        : `Active: ${loc.city}${loc.country ? `, ${loc.country}` : ''} (${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)})`
    );

    weatherGroup.append(cityPicker, locMeta);

    const unitGroup = this.buildSegGroup<TempUnit>(
      'Temperature & wind unit',
      this.settings.weather.unit ?? 'c',
      [
        ['c', 'Celsius (°C · km/h)'],
        ['f', 'Fahrenheit (°F · mph)']
      ],
      (unit) =>
        void this.update((s) => {
          s.weather.unit = unit;
        })
    );

    // Live Wire News Source selector (includes www.iranmonitor.org + custom RSS/site)
    const newsGroup = el('div', 'form-group');
    newsGroup.appendChild(el('label', undefined, 'News source (Live Wire)'));
    const activeSourceId = this.settings.news?.sourceId || 'bbc-world';

    const newsRow = el('div', 'seg-row');
    for (const src of NEWS_SOURCES) {
      const btn = el(
        'button',
        'seg-btn' + (activeSourceId === src.id ? ' active' : ''),
        src.name
      );
      btn.type = 'button';
      btn.title = src.domain;
      btn.addEventListener('click', () => {
        void this.update((s) => {
          s.news = {
            sourceId: src.id,
            customUrl: s.news?.customUrl ?? '',
            keywords: s.news?.keywords ?? []
          };
        });
        this.callbacks.onToast?.(`News source set to ${src.name} (${src.domain})`);
      });
      newsRow.appendChild(btn);
    }

    const customNewsBtn = el(
      'button',
      'seg-btn' + (activeSourceId === 'custom' ? ' active' : ''),
      'Custom URL'
    );
    customNewsBtn.type = 'button';
    customNewsBtn.addEventListener('click', () =>
      void this.update((s) => {
        s.news = {
          sourceId: 'custom',
          customUrl: s.news?.customUrl ?? '',
          keywords: s.news?.keywords ?? []
        };
      })
    );
    newsRow.appendChild(customNewsBtn);
    newsGroup.appendChild(newsRow);

    if (activeSourceId === 'custom') {
      const customForm = el('form', 'news-custom-row');
      const customIn = el('input', 'hw-input-sm');
      customIn.type = 'text';
      customIn.placeholder = 'https://www.iranmonitor.org or RSS feed URL...';
      customIn.value = this.settings.news?.customUrl ?? '';

      const applyBtn = el('button', 'hw-mini-btn is-accent', 'Apply');
      applyBtn.type = 'submit';
      customForm.append(customIn, applyBtn);

      customForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const val = customIn.value.trim();
        if (!val) return;
        void this.update((s) => {
          s.news = {
            sourceId: 'custom',
            customUrl: val,
            keywords: s.news?.keywords ?? []
          };
        });
        this.callbacks.onToast?.(`Custom news source set to ${val}`);
      });
      newsGroup.appendChild(customForm);
    }

    const activeNewsDef = getNewsSource(activeSourceId);
    const newsMeta = el(
      'div',
      'settings-note',
      activeSourceId === 'custom'
        ? this.settings.news?.customUrl
          ? `Active custom source: ${this.settings.news.customUrl}`
          : 'Enter any RSS/Atom URL or website domain above.'
        : `Active: ${activeNewsDef.name} (${activeNewsDef.domain})`
    );
    newsGroup.appendChild(newsMeta);

    // News keyword filter (only show headlines containing at least one keyword)
    const keywordGroup = el('div', 'form-group');
    keywordGroup.appendChild(el('label', undefined, 'News keyword filter'));

    const kwForm = el('form', 'news-custom-row');
    const kwInput = el('input', 'hw-input-sm');
    kwInput.type = 'text';
    kwInput.placeholder = 'Add keyword (e.g. Iran, AI, protest) — comma-separated supported';

    const kwAddBtn = el('button', 'hw-mini-btn is-accent', '+ Add');
    kwAddBtn.type = 'submit';
    kwForm.append(kwInput, kwAddBtn);

    kwForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const parts = kwInput.value
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      if (parts.length === 0) return;

      const existing = this.settings.news?.keywords ?? [];
      const existingLower = new Set(existing.map((k) => k.toLowerCase()));
      const additions = parts.filter((p) => !existingLower.has(p.toLowerCase()));
      if (additions.length === 0) {
        kwInput.value = '';
        return;
      }

      void this.update((s) => {
        s.news = {
          sourceId: s.news?.sourceId || 'bbc-world',
          customUrl: s.news?.customUrl ?? '',
          keywords: [...(s.news?.keywords ?? []), ...additions]
        };
      });
      this.callbacks.onToast?.(`Added keyword filter: ${additions.join(', ')}`);
    });

    keywordGroup.appendChild(kwForm);

    const activeKeywords = this.settings.news?.keywords ?? [];
    if (activeKeywords.length > 0) {
      const chipList = el('div', 'keyword-chip-list');
      for (const kw of activeKeywords) {
        const chip = el('span', 'keyword-chip');
        chip.appendChild(el('span', 'keyword-chip-text', kw));
        const rmBtn = el('button', 'keyword-chip-rm', '×');
        rmBtn.type = 'button';
        rmBtn.setAttribute('aria-label', `Remove keyword ${kw}`);
        rmBtn.addEventListener('click', () => {
          void this.update((s) => {
            s.news = {
              sourceId: s.news?.sourceId || 'bbc-world',
              customUrl: s.news?.customUrl ?? '',
              keywords: (s.news?.keywords ?? []).filter((k) => k !== kw)
            };
          });
        });
        chip.appendChild(rmBtn);
        chipList.appendChild(chip);
      }

      if (activeKeywords.length > 1) {
        const clearBtn = el('button', 'hw-link-btn keyword-clear-btn', 'Clear all');
        clearBtn.type = 'button';
        clearBtn.addEventListener('click', () => {
          void this.update((s) => {
            s.news = {
              sourceId: s.news?.sourceId || 'bbc-world',
              customUrl: s.news?.customUrl ?? '',
              keywords: []
            };
          });
          this.callbacks.onToast?.('Cleared all news keyword filters');
        });
        chipList.appendChild(clearBtn);
      }

      keywordGroup.appendChild(chipList);
    }

    keywordGroup.appendChild(
      el(
        'div',
        'settings-note',
        activeKeywords.length > 0
          ? 'Live Wire will only display stories containing one of these keywords.'
          : 'Leave empty to show the latest headline from your selected source.'
      )
    );

    const calGroup = this.buildSegGroup(
      t('calendar'),
      this.settings.general.calendar,
      [
        ['gregorian', t('gregorian')],
        ['jalali', t('jalali')]
      ] as const,
      (value) =>
        void this.update((s) => {
          s.general.calendar = value;
        })
    );

    const clockGroup = el('div', 'form-group');
    clockGroup.appendChild(el('label', undefined, t('clockFormat')));
    const clockRow = el('div', 'seg-row');
    for (const [is24, key] of [
      [true, 'clock24h'],
      [false, 'clock12h']
    ] as const) {
      const btn = el('button', 'seg-btn' + (this.settings.general.clock24h === is24 ? ' active' : ''), t(key));
      btn.type = 'button';
      btn.addEventListener('click', () =>
        void this.update((s) => {
          s.general.clock24h = is24;
        })
      );
      clockRow.appendChild(btn);
    }
    clockGroup.appendChild(clockRow);

    const secondsToggle = this.buildToggle(t('showSeconds'), this.settings.general.showSeconds, () =>
      void this.update((s) => {
        s.general.showSeconds = !s.general.showSeconds;
      })
    );

    const dualDateToggle = this.buildToggle(t('showDualDate'), this.settings.general.showDualDate, () =>
      void this.update((s) => {
        s.general.showDualDate = !s.general.showDualDate;
      })
    );

    const focusToggle = this.buildToggle(
      'Show Daily Focus input in left pane',
      this.settings.general.showDailyFocus ?? true,
      () =>
        void this.update((s) => {
          s.general.showDailyFocus = !(s.general.showDailyFocus ?? true);
        })
    );

    const rememberDrawerToggle = this.buildToggle(
      t('rememberDrawer'),
      this.settings.general.rememberDrawerState,
      () =>
        void this.update((s) => {
          s.general.rememberDrawerState = !s.general.rememberDrawerState;
        })
    );

    this.contentArea.append(
      weatherGroup,
      unitGroup,
      newsGroup,
      keywordGroup,
      calGroup,
      clockGroup,
      secondsToggle,
      dualDateToggle,
      focusToggle,
      rememberDrawerToggle
    );
  }

  // --- Tab 2: Themes & Layout ---
  private renderAppearance(): void {
    const presetGroup = el('div', 'form-group');
    presetGroup.appendChild(el('label', undefined, t('themePreset')));

    const grid = el('div', 'theme-preset-grid');
    for (const preset of THEME_PRESETS) {
      const card = el(
        'button',
        'theme-preset-card' + (this.settings.appearance.themePreset === preset.id ? ' is-selected' : '')
      );
      card.type = 'button';

      const swatchStrip = el('div', 'theme-swatch-strip');
      for (const hex of preset.previewSwatches) {
        const chip = el('span', 'theme-swatch-chip');
        chip.style.background = hex;
        swatchStrip.appendChild(chip);
      }

      const info = el('div', 'theme-preset-info');
      info.appendChild(el('div', 'theme-preset-name', preset.name));
      info.appendChild(el('div', 'theme-preset-meta', `${preset.category} · ${preset.description}`));

      card.append(swatchStrip, info);
      card.addEventListener('click', () =>
        void this.update((s) => {
          s.appearance.themePreset = preset.id;
        })
      );
      grid.appendChild(card);
    }
    presetGroup.appendChild(grid);

    // Custom accent override
    const accentGroup = el('div', 'form-group');
    accentGroup.appendChild(el('label', undefined, t('accentColor')));

    const accentRow = el('div', 'accent-override-row');
    const picker = el('input', 'hw-color-picker');
    picker.type = 'color';
    picker.value = this.settings.appearance.customAccent || '#FF3E00';
    picker.addEventListener('change', () =>
      void this.update((s) => {
        s.appearance.customAccent = picker.value;
      })
    );

    const statusText = el(
      'span',
      'settings-note',
      this.settings.appearance.customAccent ? this.settings.appearance.customAccent.toUpperCase() : 'Using theme default'
    );

    const resetBtn = el('button', 'hw-mini-btn', 'Reset');
    resetBtn.type = 'button';
    resetBtn.disabled = !this.settings.appearance.customAccent;
    resetBtn.addEventListener('click', () =>
      void this.update((s) => {
        s.appearance.customAccent = '';
      })
    );

    accentRow.append(picker, statusText, resetBtn);
    accentGroup.appendChild(accentRow);

    // Custom canvas background override
    const bgGroup = el('div', 'form-group');
    bgGroup.appendChild(el('label', undefined, 'Custom canvas background'));

    const bgRow = el('div', 'accent-override-row');
    const bgPicker = el('input', 'hw-color-picker');
    bgPicker.type = 'color';
    bgPicker.value = this.settings.appearance.customBg || '#080808';
    bgPicker.addEventListener('change', () =>
      void this.update((s) => {
        s.appearance.customBg = bgPicker.value;
      })
    );

    const bgStatus = el(
      'span',
      'settings-note',
      this.settings.appearance.customBg ? this.settings.appearance.customBg.toUpperCase() : 'Using theme default'
    );

    const bgReset = el('button', 'hw-mini-btn', 'Reset');
    bgReset.type = 'button';
    bgReset.disabled = !this.settings.appearance.customBg;
    bgReset.addEventListener('click', () =>
      void this.update((s) => {
        s.appearance.customBg = '';
      })
    );

    bgRow.append(bgPicker, bgStatus, bgReset);
    bgGroup.appendChild(bgRow);

    // Clock scale
    const clockScaleGroup = this.buildSegGroup<ClockScale>(
      'Clock size',
      this.settings.appearance.clockScale || 'standard',
      [
        ['compact', 'Compact'],
        ['standard', 'Standard'],
        ['large', 'Large']
      ],
      (scale) =>
        void this.update((s) => {
          s.appearance.clockScale = scale;
        })
    );

    // Layout density
    const densityGroup = this.buildSegGroup<LayoutDensity>(
      'Interface density',
      this.settings.appearance.density || 'standard',
      [
        ['compact', 'Compact'],
        ['standard', 'Standard'],
        ['spacious', 'Spacious']
      ],
      (density) =>
        void this.update((s) => {
          s.appearance.density = density;
        })
    );

    // Bookmark icon style
    const iconGroup = this.buildSegGroup<BookmarkIconStyle>(
      'Bookmark favicons',
      this.settings.appearance.bookmarkIconStyle || 'dithered',
      [
        ['dithered', 'Dithered'],
        ['solid', 'Solid Tint'],
        ['original', 'Original'],
        ['monochrome', 'Mono Dither'],
        ['off', 'Hidden']
      ],
      (style) =>
        void this.update((s) => {
          s.appearance.bookmarkIconStyle = style;
        })
    );

    // Custom scrollbar appearance
    const scrollbarGroup = this.buildSegGroup<ScrollbarStyle>(
      'Scrollbar style',
      this.settings.appearance.scrollbarStyle || 'thin',
      [
        ['thin', 'Minimal Thin'],
        ['accent', 'Accent Tint'],
        ['hidden', 'Hidden']
      ],
      (style) =>
        void this.update((s) => {
          s.appearance.scrollbarStyle = style;
        })
    );

    const hostsToggle = this.buildToggle(
      'Show bookmark domain subtitles',
      this.settings.appearance.showBookmarkHosts ?? true,
      () =>
        void this.update((s) => {
          s.appearance.showBookmarkHosts = !(s.appearance.showBookmarkHosts ?? true);
        })
    );

    const indicesToggle = this.buildToggle(
      'Show bookmark index numbers (01, 02...)',
      this.settings.appearance.showBookmarkIndices ?? true,
      () =>
        void this.update((s) => {
          s.appearance.showBookmarkIndices = !(s.appearance.showBookmarkIndices ?? true);
        })
    );

    this.contentArea.append(
      presetGroup,
      accentGroup,
      bgGroup,
      clockScaleGroup,
      densityGroup,
      iconGroup,
      scrollbarGroup,
      hostsToggle,
      indicesToggle
    );
  }

  // --- Tab 3: Commands & Custom Bangs ---
  private async renderCommands(): Promise<void> {
    const customBangs = await getCustomBangs();

    const addGroup = el('div', 'form-group');
    addGroup.appendChild(el('label', undefined, 'Add custom !bang shortcut'));

    const form = el('form', 'bang-form');
    const shortIn = el('input', 'hw-input-sm');
    shortIn.placeholder = 'mdn';
    shortIn.maxLength = 12;
    shortIn.required = true;

    const nameIn = el('input', 'hw-input-sm');
    nameIn.placeholder = 'MDN Docs';
    nameIn.required = true;

    const urlIn = el('input', 'hw-input-sm bang-url-input');
    urlIn.placeholder = 'https://developer.mozilla.org/en-US/search?q=%s';
    urlIn.required = true;

    const submit = el('button', 'hw-mini-btn is-accent', 'Add');
    submit.type = 'submit';

    form.append(shortIn, nameIn, urlIn, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveCustomBang({
        short: shortIn.value,
        name: nameIn.value,
        urlTemplate: urlIn.value
      });
      this.callbacks.onToast?.(`Saved !${shortIn.value.replace(/^!+/, '').trim()} bang`);
      await this.render();
    });
    addGroup.appendChild(form);

    // Custom bangs list
    const customGroup = el('div', 'form-group');
    customGroup.appendChild(el('label', undefined, 'Custom bangs'));
    if (customBangs.length === 0) {
      customGroup.appendChild(el('div', 'settings-note', 'No custom bangs yet. Use %s where the search query goes.'));
    } else {
      const list = el('div', 'bang-list');
      for (const b of customBangs) {
        const row = el('div', 'bang-row');
        row.appendChild(el('span', 'bang-code', `!${b.short}`));
        row.appendChild(el('span', 'bang-name', `${b.name} · ${b.urlTemplate}`));
        const del = el('button', 'hw-mini-btn', '×');
        del.type = 'button';
        del.addEventListener('click', async () => {
          await deleteCustomBang(b.short);
          await this.render();
        });
        row.appendChild(del);
        list.appendChild(row);
      }
      customGroup.appendChild(list);
    }

    // Built-in bangs reference
    const builtInGroup = el('div', 'form-group');
    builtInGroup.appendChild(el('label', undefined, 'Built-in bangs'));
    const refList = el('div', 'bang-list');
    for (const b of BUILT_IN_BANGS) {
      const row = el('div', 'bang-row');
      row.appendChild(el('span', 'bang-code', `!${b.short}`));
      row.appendChild(el('span', 'bang-name', b.name));
      refList.appendChild(row);
    }
    builtInGroup.appendChild(refList);

    this.contentArea.append(addGroup, customGroup, builtInGroup);
  }

  // --- Tab 4: Widgets & Modules ---
  private async renderModules(): Promise<void> {
    const rightPaneGroup = el('div', 'form-group');
    rightPaneGroup.appendChild(el('label', undefined, 'Right pane live telemetry'));
    rightPaneGroup.appendChild(
      this.buildToggle('Atmosphere (Weather & AQI)', this.settings.widgets.weather ?? true, () =>
        void this.update((s) => {
          s.widgets.weather = !(s.widgets.weather ?? true);
        })
      )
    );
    rightPaneGroup.appendChild(
      this.buildToggle('Market Volatility (USD & Gold)', this.settings.widgets.priceTicker, () =>
        void this.update((s) => {
          s.widgets.priceTicker = !s.widgets.priceTicker;
        })
      )
    );
    rightPaneGroup.appendChild(
      this.buildToggle('Live Wire (Breaking News)', this.settings.widgets.newsWidget, () =>
        void this.update((s) => {
          s.widgets.newsWidget = !s.widgets.newsWidget;
        })
      )
    );

    const rackGroup = el('div', 'form-group');
    rackGroup.appendChild(el('label', undefined, 'Workspace Deck modules'));
    for (const def of registry.getAll()) {
      const enabled = await isWidgetEnabled(def.id);
      rackGroup.appendChild(
        this.buildToggle(def.title, enabled, async () => {
          await setWidgetEnabled(def.id, !enabled);
          await this.callbacks.onModulesChange?.();
          await this.render();
        })
      );
    }

    const assetsGroup = el('div', 'form-group');
    assetsGroup.appendChild(el('label', undefined, t('financeAssets')));
    const assetRow = el('div', 'seg-row');
    for (const assetId of Object.keys(FINANCE_ASSETS) as FinanceAssetId[]) {
      const active = this.settings.finance.assets.includes(assetId);
      const btn = el('button', 'seg-btn' + (active ? ' active' : ''), FINANCE_ASSETS[assetId].name);
      btn.type = 'button';
      btn.addEventListener('click', () =>
        void this.update((s) => {
          const exists = s.finance.assets.includes(assetId);
          if (exists && s.finance.assets.length > 1) {
            s.finance.assets = s.finance.assets.filter((id) => id !== assetId);
          } else if (!exists) {
            s.finance.assets = [...s.finance.assets, assetId];
          }
        })
      );
      assetRow.appendChild(btn);
    }
    assetsGroup.appendChild(assetRow);

    this.contentArea.append(rightPaneGroup, rackGroup, assetsGroup);
  }

  // --- Tab 5: Privacy, Backup & Reset ---
  private renderPrivacy(): void {
    const histToggle = this.buildToggle(t('historySearch'), this.settings.privacy.historySearch, () =>
      void this.update((s) => {
        s.privacy.historySearch = !s.privacy.historySearch;
      })
    );

    const clipToggle = this.buildToggle(t('clipboardHistory'), this.settings.privacy.clipboardHistory, () =>
      void this.update((s) => {
        s.privacy.clipboardHistory = !s.privacy.clipboardHistory;
      })
    );

    this.contentArea.append(histToggle, clipToggle);

    if (this.settings.privacy.clipboardHistory) {
      this.contentArea.appendChild(el('div', 'settings-note', t('clipboardNote')));
      const clearClipBtn = el('button', 'hw-btn', 'Clear captured clipboard');
      clearClipBtn.type = 'button';
      clearClipBtn.addEventListener('click', async () => {
        await clearClipboardHistory();
        this.callbacks.onToast?.('Clipboard history cleared');
      });
      this.contentArea.appendChild(clearClipBtn);
    }

    // Backup & Restore
    const backupGroup = el('div', 'form-group');
    backupGroup.appendChild(el('label', undefined, 'Configuration backup'));
    const backupRow = el('div', 'seg-row');

    const exportBtn = el('button', 'hw-btn', 'Export JSON');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', async () => {
      const config = {
        version: 2,
        exportedAt: new Date().toISOString(),
        settings: await storage.getSettings(),
        shortcuts: await storage.getShortcuts(),
        notes: await storage.getNotes(),
        customBangs: await getCustomBangs()
      };
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `start-config-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      this.callbacks.onToast?.('Exported configuration backup');
    });

    const importBtn = el('button', 'hw-btn', 'Import JSON');
    importBtn.type = 'button';
    importBtn.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const config = JSON.parse(await file.text());
          if (config.settings) await storage.saveSettings(config.settings);
          if (Array.isArray(config.shortcuts)) await storage.setShortcuts(config.shortcuts);
          if (Array.isArray(config.notes)) await storage.setNotes(config.notes);
          if (Array.isArray(config.customBangs)) {
            for (const b of config.customBangs) await saveCustomBang(b);
          }
          window.location.reload();
        } catch {
          this.callbacks.onToast?.('Invalid JSON configuration file');
        }
      });
      input.click();
    });

    const resetAllBtn = el('button', 'hw-btn', 'Reset Defaults');
    resetAllBtn.type = 'button';
    resetAllBtn.addEventListener('click', async () => {
      this.settings = structuredClone(DEFAULT_SETTINGS);
      await this.callbacks.onChange(structuredClone(this.settings));
      await this.render();
      this.callbacks.onToast?.('Settings restored to defaults');
    });

    backupRow.append(exportBtn, importBtn, resetAllBtn);
    backupGroup.appendChild(backupRow);

    // About & Version
    const manifest = chrome.runtime.getManifest();
    const aboutGroup = el('div', 'form-group');
    aboutGroup.appendChild(el('label', undefined, `${t('versionLabel')} ${manifest.version}`));
    aboutGroup.appendChild(el('div', 'settings-note', t('dataSources')));

    const reloadBtn = el('button', 'hw-btn', t('reloadExtension'));
    reloadBtn.type = 'button';
    reloadBtn.addEventListener('click', () => chrome.runtime.reload());

    this.contentArea.append(backupGroup, aboutGroup, reloadBtn);
  }

  static async init(callbacks: SettingsUICallbacks): Promise<SettingsUI> {
    const settings = await storage.getSettings();
    return new SettingsUI(settings, callbacks);
  }
}

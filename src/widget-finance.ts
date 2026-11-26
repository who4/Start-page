// Market Pulse module — live USD/Gold/EUR prices, interactive HiDPI sparklines, threshold alerts.
import { ApiClient, type PriceData } from './api';
import { FINANCE_ASSETS, PRICE_HISTORY_KEY, PRICE_HISTORY_MAX, type FinanceAssetId } from './constants';
import { storage } from './storage';
import type { PriceAlert, Settings } from './types';
import type { WidgetDef } from './grid';

export interface PriceHistoryPoint {
  t: number; // timestamp ms
  p: number; // price in Rial
  trend: 'up' | 'down' | 'flat';
}

interface PriceHistoryStore {
  [assetId: string]: PriceHistoryPoint[];
}

export async function appendPricePoint(
  asset: FinanceAssetId,
  price: number,
  trend: PriceData['trend']
): Promise<PriceHistoryPoint[]> {
  const store = await storage.get<PriceHistoryStore>(PRICE_HISTORY_KEY, {});
  const arr = store[asset] || [];
  const last = arr[arr.length - 1];
  const now = Date.now();
  // Avoid redundant identical duplicates within 60s
  if (!last || now - last.t > 60_000 || last.p !== price) {
    arr.push({ t: now, p: price, trend });
    if (arr.length > PRICE_HISTORY_MAX) arr.splice(0, arr.length - PRICE_HISTORY_MAX);
    store[asset] = arr;
    await storage.set(PRICE_HISTORY_KEY, store);
  }
  return arr;
}

async function getHistory(asset: FinanceAssetId): Promise<PriceHistoryPoint[]> {
  const store = await storage.get<PriceHistoryStore>(PRICE_HISTORY_KEY, {});
  return store[asset] || [];
}

function getCssVar(name: string, fallback: string): string {
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
}

function drawInteractiveSparkline(
  canvas: HTMLCanvasElement,
  history: PriceHistoryPoint[],
  trend: PriceData['trend'],
  hoverIndex: number | null
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = Math.max(canvas.clientWidth || 180, 120);
  const h = Math.max(canvas.clientHeight || 44, 36);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const upColor = getCssVar('--status-up', '#22C55E');
  const downColor = getCssVar('--status-down', '#EF4444');
  const accentColor = getCssVar('--accent', '#FF5500');
  const gridColor = getCssVar('--border-hairline', 'rgba(255,255,255,0.12)');
  const textMuted = getCssVar('--text-muted', '#8E929B');

  // Subtle horizontal midline reference
  ctx.save();
  ctx.strokeStyle = gridColor;
  ctx.setLineDash([2, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(h / 2) + 0.5);
  ctx.lineTo(w, Math.round(h / 2) + 0.5);
  ctx.stroke();
  ctx.restore();

  if (history.length < 2) {
    // Honest single-point baseline
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(4, Math.round(h / 2));
    ctx.lineTo(w - 6, Math.round(h / 2));
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(w - 6, Math.round(h / 2), 3, 0, Math.PI * 2);
    ctx.fillStyle = accentColor;
    ctx.fill();

    ctx.fillStyle = textMuted;
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillText(history.length === 1 ? '1st reading logged' : 'Awaiting live feed', 4, h - 4);
    return;
  }

  const points = history.map((pt) => pt.p / 10);
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const padY = 6;
  const plotH = h - padY * 2;
  const padX = 4;
  const plotW = w - padX * 2;
  const step = plotW / (points.length - 1);

  const first = points[0];
  const last = points[points.length - 1];
  const strokeColor =
    last > first ? upColor : last < first ? downColor : trend === 'up' ? upColor : trend === 'down' ? downColor : accentColor;

  const coord = (i: number): [number, number] => [
    padX + i * step,
    padY + plotH - ((points[i] - min) / range) * plotH
  ];

  // Fill area
  const grad = ctx.createLinearGradient(0, padY, 0, h);
  grad.addColorStop(0, strokeColor + '28');
  grad.addColorStop(1, strokeColor + '00');

  ctx.beginPath();
  const [x0, y0] = coord(0);
  ctx.moveTo(x0, y0);
  for (let i = 1; i < points.length; i++) {
    const [x, y] = coord(i);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(padX + plotW, h);
  ctx.lineTo(padX, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Stroke line
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  for (let i = 1; i < points.length; i++) {
    const [x, y] = coord(i);
    ctx.lineTo(x, y);
  }
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.75;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Active point (hover or latest)
  const focusIdx = hoverIndex !== null && hoverIndex >= 0 && hoverIndex < points.length ? hoverIndex : points.length - 1;
  const [fx, fy] = coord(focusIdx);

  if (hoverIndex !== null) {
    ctx.save();
    ctx.strokeStyle = textMuted;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(fx, 2);
    ctx.lineTo(fx, h - 2);
    ctx.stroke();
    ctx.restore();
  }

  ctx.beginPath();
  ctx.arc(fx, fy, hoverIndex !== null ? 3.5 : 2.8, 0, Math.PI * 2);
  ctx.fillStyle = strokeColor;
  ctx.fill();
}

export interface FinanceWidgetDeps {
  getSettings: () => Settings;
  onUpdateAlerts: (alerts: PriceAlert[]) => Promise<void>;
}

export function createFinanceWidget(deps: FinanceWidgetDeps): WidgetDef {
  let showAlertForm = false;

  return {
    id: 'finance',
    title: 'Market Pulse',
    defaultSize: { colSpan: 2, rowSpan: 1 },
    async render(container) {
      container.replaceChildren();
      const settings = deps.getSettings();
      const assetIds = settings.finance.assets.length > 0 ? settings.finance.assets : (['usd', 'gold'] as FinanceAssetId[]);
      const alerts = settings.finance.alerts || [];

      // Header
      const header = document.createElement('div');
      header.className = 'mod-header';

      const titleWrap = document.createElement('div');
      titleWrap.className = 'mod-title-group';
      const title = document.createElement('h3');
      title.className = 'mod-title';
      title.textContent = 'Market Pulse';
      const meta = document.createElement('span');
      meta.className = 'mod-meta';
      meta.textContent = 'Toman · Live';
      titleWrap.append(title, meta);

      const controls = document.createElement('div');
      controls.className = 'mod-controls';

      const alertToggleBtn = document.createElement('button');
      alertToggleBtn.type = 'button';
      alertToggleBtn.className = 'hw-mini-btn' + (showAlertForm ? ' is-active' : '');
      alertToggleBtn.textContent = alerts.length > 0 ? `Alerts (${alerts.filter((a) => a.enabled).length})` : '+ Alert';
      alertToggleBtn.addEventListener('click', () => {
        showAlertForm = !showAlertForm;
        void this.render(container);
      });

      const refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.className = 'hw-mini-btn';
      refreshBtn.textContent = '↻';
      refreshBtn.title = 'Refresh live prices';
      refreshBtn.setAttribute('aria-label', 'Refresh live prices');
      refreshBtn.addEventListener('click', () => {
        ApiClient.clearPriceCache();
        void this.render(container);
      });

      controls.append(alertToggleBtn, refreshBtn);
      header.append(titleWrap, controls);
      container.appendChild(header);

      // Asset rows
      const grid = document.createElement('div');
      grid.className = 'market-grid';
      container.appendChild(grid);

      const liveTomans = new Map<FinanceAssetId, number>();

      for (const assetId of assetIds) {
        const def = FINANCE_ASSETS[assetId];
        if (!def) continue;

        const row = document.createElement('div');
        row.className = 'market-card';

        const top = document.createElement('div');
        top.className = 'market-card-top';

        const label = document.createElement('span');
        label.className = 'market-code';
        label.textContent = `${def.code} · ${def.name}`;

        const trendEl = document.createElement('span');
        trendEl.className = 'market-trend';
        trendEl.textContent = '—';

        top.append(label, trendEl);

        const valRow = document.createElement('div');
        valRow.className = 'market-value-row';

        const priceEl = document.createElement('span');
        priceEl.className = 'market-price';
        priceEl.textContent = 'Loading...';

        const inspectEl = document.createElement('span');
        inspectEl.className = 'market-inspect';

        valRow.append(priceEl, inspectEl);

        const canvas = document.createElement('canvas');
        canvas.className = 'market-sparkline';
        canvas.height = 44;

        const alertStatusEl = document.createElement('div');
        alertStatusEl.className = 'market-alert-hit';
        alertStatusEl.hidden = true;

        row.append(top, valRow, canvas, alertStatusEl);
        grid.appendChild(row);

        void hydrateAsset(assetId, alerts, priceEl, trendEl, inspectEl, canvas, alertStatusEl, liveTomans);
      }

      // Collapsible Alerts Drawer inside module
      if (showAlertForm) {
        const panel = document.createElement('div');
        panel.className = 'market-alerts-panel';

        const form = document.createElement('form');
        form.className = 'market-alert-form';

        const assetSel = document.createElement('select');
        assetSel.className = 'hw-select';
        for (const id of Object.keys(FINANCE_ASSETS) as FinanceAssetId[]) {
          const opt = document.createElement('option');
          opt.value = id;
          opt.textContent = FINANCE_ASSETS[id].code;
          assetSel.appendChild(opt);
        }

        const dirSel = document.createElement('select');
        dirSel.className = 'hw-select';
        dirSel.innerHTML = '<option value="above">Above ≥</option><option value="below">Below ≤</option>';

        const valInput = document.createElement('input');
        valInput.type = 'number';
        valInput.min = '1';
        valInput.step = 'any';
        valInput.placeholder = 'Toman target';
        valInput.className = 'hw-input-sm';

        const addBtn = document.createElement('button');
        addBtn.type = 'submit';
        addBtn.className = 'hw-mini-btn is-accent';
        addBtn.textContent = 'Set';

        form.append(assetSel, dirSel, valInput, addBtn);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const num = Number(valInput.value);
          if (!Number.isFinite(num) || num <= 0) return;
          const next: PriceAlert[] = [
            ...alerts,
            {
              id: `al-${Date.now()}`,
              asset: assetSel.value as FinanceAssetId,
              above: dirSel.value === 'above' ? num : undefined,
              below: dirSel.value === 'below' ? num : undefined,
              enabled: true
            }
          ];
          await deps.onUpdateAlerts(next);
          void this.render(container);
        });

        panel.appendChild(form);

        if (alerts.length > 0) {
          const list = document.createElement('div');
          list.className = 'market-alert-list';
          for (const al of alerts) {
            const item = document.createElement('div');
            item.className = 'market-alert-row';
            const desc = document.createElement('span');
            desc.className = 'market-alert-desc';
            const cond = al.above !== undefined ? `≥ ${al.above.toLocaleString('en-US')}` : `≤ ${(al.below ?? 0).toLocaleString('en-US')}`;
            desc.textContent = `${FINANCE_ASSETS[al.asset]?.code ?? al.asset.toUpperCase()} ${cond} Toman`;

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'hw-mini-btn' + (al.enabled ? ' is-active' : '');
            toggle.textContent = al.enabled ? 'On' : 'Off';
            toggle.addEventListener('click', async () => {
              const next = alerts.map((x) => (x.id === al.id ? { ...x, enabled: !x.enabled } : x));
              await deps.onUpdateAlerts(next);
              void this.render(container);
            });

            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'hw-mini-btn';
            del.textContent = '×';
            del.setAttribute('aria-label', 'Remove alert');
            del.addEventListener('click', async () => {
              const next = alerts.filter((x) => x.id !== al.id);
              await deps.onUpdateAlerts(next);
              void this.render(container);
            });

            item.append(desc, toggle, del);
            list.appendChild(item);
          }
          panel.appendChild(list);
        }

        container.appendChild(panel);
      }
    }
  };
}

async function hydrateAsset(
  assetId: FinanceAssetId,
  alerts: PriceAlert[],
  priceEl: HTMLElement,
  trendEl: HTMLElement,
  inspectEl: HTMLElement,
  canvas: HTMLCanvasElement,
  alertStatusEl: HTMLElement,
  liveTomans: Map<FinanceAssetId, number>
): Promise<void> {
  const data = await ApiClient.fetchAssetPrice(assetId);
  let history = await getHistory(assetId);

  if (data.price === 'Error') {
    priceEl.textContent = 'Unavailable';
    trendEl.textContent = 'Offline';
    trendEl.className = 'market-trend';
    drawInteractiveSparkline(canvas, history.slice(-48), 'flat', null);
    return;
  }

  const rialNum = parseInt(data.price.replace(/,/g, ''), 10);
  const toman = Number.isFinite(rialNum) ? rialNum / 10 : NaN;
  if (Number.isFinite(rialNum) && rialNum > 0) {
    history = await appendPricePoint(assetId, rialNum, data.trend);
    liveTomans.set(assetId, toman);
  }

  priceEl.textContent = Number.isFinite(toman) ? toman.toLocaleString('en-US') : data.price;

  // Calculate session delta if history has >= 2 points
  const slice = history.slice(-48);
  let deltaText = '';
  if (slice.length >= 2) {
    const first = slice[0].p;
    const latest = slice[slice.length - 1].p;
    if (first > 0) {
      const pct = ((latest - first) / first) * 100;
      if (Math.abs(pct) >= 0.01) {
        deltaText = ` ${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
      }
    }
  }

  trendEl.textContent =
    data.trend === 'up' ? `▲ Up${deltaText}` : data.trend === 'down' ? `▼ Down${deltaText}` : `— Flat${deltaText}`;
  trendEl.className =
    'market-trend ' + (data.trend === 'up' ? 'is-up' : data.trend === 'down' ? 'is-down' : 'is-flat');

  // Check active threshold alerts
  if (Number.isFinite(toman)) {
    const triggered = alerts.find(
      (a) =>
        a.enabled &&
        a.asset === assetId &&
        ((a.above !== undefined && toman >= a.above) || (a.below !== undefined && toman <= a.below))
    );
    if (triggered) {
      alertStatusEl.hidden = false;
      alertStatusEl.textContent =
        triggered.above !== undefined && toman >= triggered.above
          ? `ALERT · Reached ≥ ${triggered.above.toLocaleString('en-US')}`
          : `ALERT · Reached ≤ ${(triggered.below ?? 0).toLocaleString('en-US')}`;
    }
  }

  requestAnimationFrame(() => {
    drawInteractiveSparkline(canvas, slice, data.trend, null);
  });

  // Pointer hover inspection
  if (slice.length >= 2) {
    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const rel = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(rect.width, 1)));
      const idx = Math.round(rel * (slice.length - 1));
      const pt = slice[idx];
      if (!pt) return;
      const timeStr = new Date(pt.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      inspectEl.textContent = `${(pt.p / 10).toLocaleString('en-US')} · ${timeStr}`;
      drawInteractiveSparkline(canvas, slice, data.trend, idx);
    });
    canvas.addEventListener('pointerleave', () => {
      inspectEl.textContent = '';
      drawInteractiveSparkline(canvas, slice, data.trend, null);
    });
  }
}

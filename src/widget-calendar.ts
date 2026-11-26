// Dual Calendar module — interactive Gregorian & Jalali month navigation, holidays, dual date inspector.
import { JALALI_MONTHS_EN, toGregorian, toJalali } from './jalali';
import type { WidgetDef } from './grid';
import type { CalendarType, Settings } from './types';

const GREG_WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sat'];
const JALALI_WEEKDAYS = ['Sa', 'Su', 'Mo', 'Tu', 'We', 'Th', 'Fr'];
const GREG_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// Notable Iranian calendar holidays (Gregorian YYYY-MM-DD keys for 2025–2027)
const HOLIDAYS: Record<string, string> = {
  '2026-03-21': 'Nowruz Day 1',
  '2026-03-22': 'Nowruz Day 2',
  '2026-03-23': 'Nowruz Day 3',
  '2026-03-24': 'Nowruz Day 4',
  '2026-04-01': 'Islamic Republic Day',
  '2026-04-02': 'Sizdah Be-dar',
  '2026-06-05': 'Public Holiday',
  '2026-11-25': 'Holiday',
  '2027-03-21': 'Nowruz Day 1',
  '2027-03-22': 'Nowruz Day 2',
  '2027-03-23': 'Nowruz Day 3',
  '2027-03-24': 'Nowruz Day 4',
  '2027-04-01': 'Islamic Republic Day',
  '2027-04-02': 'Sizdah Be-dar'
};

function gregorianKey(y: number, mZeroBased: number, d: number): string {
  return `${y}-${String(mZeroBased + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInGregMonth(year: number, monthZero: number): number {
  return new Date(year, monthZero + 1, 0).getDate();
}

function daysInJalaliMonth(jy: number, jm: number): number {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  // Esfand: test whether day 30 converts back to Esfand 30
  const g30 = toGregorian(jy, 12, 30);
  const back = toJalali(g30.gy, g30.gm, g30.gd);
  return back.jy === jy && back.jm === 12 && back.jd === 30 ? 30 : 29;
}

export interface CalendarWidgetDeps {
  getSettings: () => Settings;
}

export function createCalendarWidget(deps: CalendarWidgetDeps): WidgetDef {
  let modeOverride: CalendarType | null = null;
  const nowInit = new Date();
  let viewGregYear = nowInit.getFullYear();
  let viewGregMonth = nowInit.getMonth();
  const jInit = toJalali(nowInit.getFullYear(), nowInit.getMonth() + 1, nowInit.getDate());
  let viewJalaliYear = jInit.jy;
  let viewJalaliMonth = jInit.jm;
  let selectedDate = new Date(nowInit.getFullYear(), nowInit.getMonth(), nowInit.getDate());

  return {
    id: 'calendar',
    title: 'Dual Calendar',
    defaultSize: { colSpan: 2, rowSpan: 2 },
    render(container) {
      const renderCalendar = (): void => {
        container.replaceChildren();
        const activeMode: CalendarType = modeOverride ?? deps.getSettings().general.calendar;
        const today = new Date();
        const todayKey = gregorianKey(today.getFullYear(), today.getMonth(), today.getDate());
        const selectedKey = gregorianKey(
          selectedDate.getFullYear(),
          selectedDate.getMonth(),
          selectedDate.getDate()
        );

        // Header
        const header = document.createElement('div');
        header.className = 'mod-header';

        const titleWrap = document.createElement('div');
        titleWrap.className = 'mod-title-group';
        const heading = document.createElement('h3');
        heading.className = 'mod-title';
        heading.textContent =
          activeMode === 'jalali'
            ? `${JALALI_MONTHS_EN[viewJalaliMonth - 1]} ${viewJalaliYear}`
            : `${GREG_MONTHS[viewGregMonth]} ${viewGregYear}`;

        const sub = document.createElement('span');
        sub.className = 'mod-meta';
        if (activeMode === 'jalali') {
          const gFirst = toGregorian(viewJalaliYear, viewJalaliMonth, 1);
          const gLast = toGregorian(viewJalaliYear, viewJalaliMonth, daysInJalaliMonth(viewJalaliYear, viewJalaliMonth));
          sub.textContent = `${GREG_MONTHS[gFirst.gm - 1].slice(0, 3)}–${GREG_MONTHS[gLast.gm - 1].slice(0, 3)} ${gLast.gy}`;
        } else {
          const jFirst = toJalali(viewGregYear, viewGregMonth + 1, 1);
          const jLast = toJalali(viewGregYear, viewGregMonth + 1, daysInGregMonth(viewGregYear, viewGregMonth));
          sub.textContent = `${JALALI_MONTHS_EN[jFirst.jm - 1]}–${JALALI_MONTHS_EN[jLast.jm - 1]} ${jLast.jy}`;
        }
        titleWrap.append(heading, sub);

        const controls = document.createElement('div');
        controls.className = 'mod-controls';

        // Mode switch
        const modeSeg = document.createElement('div');
        modeSeg.className = 'hw-seg';
        for (const [m, lbl] of [
          ['gregorian', 'Greg'],
          ['jalali', 'Jalali']
        ] as const) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'hw-seg-btn' + (activeMode === m ? ' is-active' : '');
          b.textContent = lbl;
          b.addEventListener('click', () => {
            modeOverride = m;
            renderCalendar();
          });
          modeSeg.appendChild(b);
        }

        const prevBtn = document.createElement('button');
        prevBtn.type = 'button';
        prevBtn.className = 'hw-mini-btn';
        prevBtn.textContent = '‹';
        prevBtn.setAttribute('aria-label', 'Previous month');
        prevBtn.addEventListener('click', () => {
          if (activeMode === 'jalali') {
            viewJalaliMonth -= 1;
            if (viewJalaliMonth < 1) {
              viewJalaliMonth = 12;
              viewJalaliYear -= 1;
            }
          } else {
            viewGregMonth -= 1;
            if (viewGregMonth < 0) {
              viewGregMonth = 11;
              viewGregYear -= 1;
            }
          }
          renderCalendar();
        });

        const todayBtn = document.createElement('button');
        todayBtn.type = 'button';
        todayBtn.className = 'hw-mini-btn';
        todayBtn.textContent = 'Today';
        todayBtn.addEventListener('click', () => {
          const n = new Date();
          viewGregYear = n.getFullYear();
          viewGregMonth = n.getMonth();
          const jn = toJalali(n.getFullYear(), n.getMonth() + 1, n.getDate());
          viewJalaliYear = jn.jy;
          viewJalaliMonth = jn.jm;
          selectedDate = new Date(n.getFullYear(), n.getMonth(), n.getDate());
          renderCalendar();
        });

        const nextBtn = document.createElement('button');
        nextBtn.type = 'button';
        nextBtn.className = 'hw-mini-btn';
        nextBtn.textContent = '›';
        nextBtn.setAttribute('aria-label', 'Next month');
        nextBtn.addEventListener('click', () => {
          if (activeMode === 'jalali') {
            viewJalaliMonth += 1;
            if (viewJalaliMonth > 12) {
              viewJalaliMonth = 1;
              viewJalaliYear += 1;
            }
          } else {
            viewGregMonth += 1;
            if (viewGregMonth > 11) {
              viewGregMonth = 0;
              viewGregYear += 1;
            }
          }
          renderCalendar();
        });

        controls.append(modeSeg, prevBtn, todayBtn, nextBtn);
        header.append(titleWrap, controls);

        // Weekday row
        const wdRow = document.createElement('div');
        wdRow.className = 'cal-weekdays';
        const weekdays = activeMode === 'jalali' ? JALALI_WEEKDAYS : GREG_WEEKDAYS;
        for (const wd of weekdays) {
          const c = document.createElement('div');
          c.className = 'cal-wd';
          c.textContent = wd;
          wdRow.appendChild(c);
        }

        // Day grid
        const grid = document.createElement('div');
        grid.className = 'cal-grid';

        if (activeMode === 'gregorian') {
          const firstDow = new Date(viewGregYear, viewGregMonth, 1).getDay();
          const total = daysInGregMonth(viewGregYear, viewGregMonth);
          for (let i = 0; i < firstDow; i++) {
            const pad = document.createElement('span');
            pad.className = 'cal-cell is-empty';
            grid.appendChild(pad);
          }
          for (let d = 1; d <= total; d++) {
            const key = gregorianKey(viewGregYear, viewGregMonth, d);
            const j = toJalali(viewGregYear, viewGregMonth + 1, d);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className =
              'cal-cell' +
              (key === todayKey ? ' is-today' : '') +
              (key === selectedKey ? ' is-selected' : '') +
              (HOLIDAYS[key] ? ' is-holiday' : '');
            btn.innerHTML = `<span class="cal-day-main">${d}</span><span class="cal-day-sub">${j.jd}</span>`;
            btn.addEventListener('click', () => {
              selectedDate = new Date(viewGregYear, viewGregMonth, d);
              renderCalendar();
            });
            grid.appendChild(btn);
          }
        } else {
          // Jalali month starts on Saturday (JS getDay(): 6 -> 0, 0 -> 1, ... 5 -> 6)
          const gFirst = toGregorian(viewJalaliYear, viewJalaliMonth, 1);
          const jsDow = new Date(gFirst.gy, gFirst.gm - 1, gFirst.gd).getDay();
          const offset = (jsDow + 1) % 7;
          const total = daysInJalaliMonth(viewJalaliYear, viewJalaliMonth);

          for (let i = 0; i < offset; i++) {
            const pad = document.createElement('span');
            pad.className = 'cal-cell is-empty';
            grid.appendChild(pad);
          }
          for (let jd = 1; jd <= total; jd++) {
            const g = toGregorian(viewJalaliYear, viewJalaliMonth, jd);
            const key = gregorianKey(g.gy, g.gm - 1, g.gd);
            const isFriday = new Date(g.gy, g.gm - 1, g.gd).getDay() === 5;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className =
              'cal-cell' +
              (key === todayKey ? ' is-today' : '') +
              (key === selectedKey ? ' is-selected' : '') +
              (HOLIDAYS[key] || isFriday ? ' is-holiday' : '');
            btn.innerHTML = `<span class="cal-day-main">${jd}</span><span class="cal-day-sub">${g.gd}</span>`;
            btn.addEventListener('click', () => {
              selectedDate = new Date(g.gy, g.gm - 1, g.gd);
              renderCalendar();
            });
            grid.appendChild(btn);
          }
        }

        // Inspector footer strip
        const inspector = document.createElement('div');
        inspector.className = 'cal-inspector';
        const selJ = toJalali(selectedDate.getFullYear(), selectedDate.getMonth() + 1, selectedDate.getDate());
        const selGregStr = selectedDate.toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric'
        });
        const selJalaliStr = `${selJ.jd} ${JALALI_MONTHS_EN[selJ.jm - 1]} ${selJ.jy}`;
        const holidayName = HOLIDAYS[selectedKey];
        inspector.textContent = holidayName
          ? `${selGregStr}  ·  ${selJalaliStr}  ·  ${holidayName}`
          : `${selGregStr}  ·  ${selJalaliStr}`;

        container.append(header, wdRow, grid, inspector);
      };

      renderCalendar();
    }
  };
}

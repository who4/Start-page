// Weather & Air Quality module — live Open-Meteo conditions, planet-wide geocoding
// (OpenStreetMap Photon + Open-Meteo + Nominatim + raw lat,lon), °C/°F units, and AQI meter.
import { WEATHER_CITIES } from './constants';
import type { WidgetDef } from './grid';
import type { Settings, TempUnit, WeatherLocation } from './types';

const STORAGE_KEY = 'weatherCacheV2';
const CACHE_TTL = 20 * 60 * 1000; // 20 min

export interface WeatherSnapshot {
  key: string;
  city: string;
  temp: number;
  feelsLike: number;
  windKmh: number;
  condition: string;
  code: number;
  aqi: number;
  aqiLabel: string;
  high: number;
  low: number;
  fetchedAt: number;
}

export interface GeocodingResult {
  name: string;
  admin1?: string;
  country?: string;
  countryCode?: string;
  latitude: number;
  longitude: number;
}

const WMO_CODES: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Dense drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  80: 'Showers',
  81: 'Rain showers',
  82: 'Heavy showers',
  95: 'Thunderstorm',
  96: 'Storm + hail',
  99: 'Heavy storm'
};

function isExtensionContext(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    typeof chrome.runtime?.id === 'string' &&
    chrome.runtime.id.length > 0
  );
}

export function formatTemp(celsius: number, unit: TempUnit = 'c', withUnit = true): string {
  const val = unit === 'f' ? Math.round((celsius * 9) / 5 + 32) : Math.round(celsius);
  return withUnit ? `${val}°${unit.toUpperCase()}` : `${val}°`;
}

export function formatSpeed(kmh: number, unit: TempUnit = 'c'): string {
  if (unit === 'f') {
    return `${Math.round(kmh * 0.621371)} mph`;
  }
  return `${Math.round(kmh)} km/h`;
}

export function aqiDescriptor(aqi: number): { label: string; level: 'good' | 'moderate' | 'poor' } {
  if (aqi <= 40) return { label: 'Good', level: 'good' };
  if (aqi <= 80) return { label: 'Fair', level: 'good' };
  if (aqi <= 120) return { label: 'Moderate', level: 'moderate' };
  if (aqi <= 160) return { label: 'Poor', level: 'poor' };
  return { label: 'Very Poor', level: 'poor' };
}

function parseCoordinateQuery(q: string): GeocodingResult | null {
  const m = q.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  return {
    name: `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`,
    admin1: 'Custom Coordinates',
    latitude: Number(lat.toFixed(4)),
    longitude: Number(lon.toFixed(4))
  };
}

async function searchCitiesDirect(q: string): Promise<GeocodingResult[]> {
  const results: GeocodingResult[] = [];
  const addUnique = (item: GeocodingResult): void => {
    if (!item.name || !Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) return;
    const duplicate = results.some(
      (r) => Math.abs(r.latitude - item.latitude) < 0.14 && Math.abs(r.longitude - item.longitude) < 0.14
    );
    if (!duplicate) results.push(item);
  };

  const [photonRes, openMeteoRes] = await Promise.allSettled([
    fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=10&lang=en`).then((r) =>
      r.ok ? r.json() : null
    ),
    fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q.split(',')[0].trim())}&count=8&language=en&format=json`
    ).then((r) => (r.ok ? r.json() : null))
  ]);

  const commaParts = q
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  if (openMeteoRes.status === 'fulfilled' && Array.isArray(openMeteoRes.value?.results)) {
    for (const r of openMeteoRes.value.results as Array<{
      name: string;
      admin1?: string;
      country?: string;
      country_code?: string;
      latitude: number;
      longitude: number;
    }>) {
      if (commaParts.length > 1) {
        const qualifier = commaParts.slice(1).join(' ');
        const haystack = `${r.admin1 || ''} ${r.country || ''} ${r.country_code || ''}`.toLowerCase();
        if (!haystack.includes(qualifier)) continue;
      }
      addUnique({
        name: r.name,
        admin1: r.admin1,
        country: r.country,
        countryCode: r.country_code,
        latitude: Number(r.latitude.toFixed(4)),
        longitude: Number(r.longitude.toFixed(4))
      });
    }
  }

  if (photonRes.status === 'fulfilled' && Array.isArray(photonRes.value?.features)) {
    for (const f of photonRes.value.features as Array<{
      properties?: {
        name?: string;
        city?: string;
        county?: string;
        state?: string;
        country?: string;
        countrycode?: string;
      };
      geometry?: { coordinates?: [number, number] };
    }>) {
      const props = f.properties;
      const coords = f.geometry?.coordinates;
      if (!props || !coords || coords.length < 2) continue;
      const name = props.name || props.city || props.county || props.state;
      if (!name) continue;
      const admin =
        props.state && props.state !== name
          ? props.state
          : props.county && props.county !== name
            ? props.county
            : undefined;
      addUnique({
        name,
        admin1: admin,
        country: props.country,
        countryCode: props.countrycode,
        latitude: Number(coords[1].toFixed(4)),
        longitude: Number(coords[0].toFixed(4))
      });
    }
  }

  if (results.length < 4 || q.includes(',') || /\d/.test(q)) {
    try {
      const nomResp = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=8&accept-language=en`
      );
      if (nomResp.ok) {
        const nomData = (await nomResp.json()) as Array<{
          name?: string;
          display_name?: string;
          lat?: string;
          lon?: string;
          address?: {
            city?: string;
            town?: string;
            village?: string;
            municipality?: string;
            suburb?: string;
            county?: string;
            state?: string;
            country?: string;
            country_code?: string;
          };
        }>;
        for (const item of nomData) {
          const lat = parseFloat(item.lat || '');
          const lon = parseFloat(item.lon || '');
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          const addr = item.address || {};
          const name =
            item.name ||
            addr.city ||
            addr.town ||
            addr.village ||
            addr.municipality ||
            addr.suburb ||
            addr.county ||
            (item.display_name || '').split(',')[0].trim();
          const admin1 =
            addr.state && addr.state !== name
              ? addr.state
              : addr.county && addr.county !== name
                ? addr.county
                : undefined;
          addUnique({
            name,
            admin1,
            country: addr.country,
            countryCode: addr.country_code?.toUpperCase(),
            latitude: Number(lat.toFixed(4)),
            longitude: Number(lon.toFixed(4))
          });
        }
      }
    } catch {
      // ignore fallback errors
    }
  }

  return results.slice(0, 8);
}

export async function searchCities(query: string): Promise<GeocodingResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  // Allow direct "lat, lon" coordinates for literally any spot on Earth
  const directCoord = parseCoordinateQuery(trimmed);
  if (directCoord) return [directCoord];

  if (!isExtensionContext()) {
    try {
      const resp = await fetch(`/api/geocode?q=${encodeURIComponent(trimmed)}`);
      if (resp.ok) {
        const data = (await resp.json()) as GeocodingResult[];
        if (Array.isArray(data) && data.length > 0) return data;
      }
    } catch {
      // fall through to direct browser query
    }
  }

  return searchCitiesDirect(trimmed);
}

export interface CitySearchControlOptions {
  currentLocation: WeatherLocation;
  compact?: boolean;
  onSelect: (loc: WeatherLocation) => Promise<void> | void;
}

const GPS_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/></svg>';

export function createCitySearchControl(options: CitySearchControlOptions): HTMLElement {
  const { currentLocation, compact = false, onSelect } = options;

  const root = document.createElement('div');
  root.className = 'city-picker' + (compact ? ' city-picker--compact' : '');

  const row = document.createElement('div');
  row.className = 'city-picker-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = compact ? 'hw-input-sm city-picker-input' : 'city-picker-input city-picker-input--full';
  input.placeholder = currentLocation.useGeolocation
    ? 'Local GPS — search any place...'
    : 'Search any city, town, or lat, lon...';
  input.value = currentLocation.useGeolocation ? '' : currentLocation.city;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Search any city, town, or coordinates worldwide');

  const gpsBtn = document.createElement('button');
  gpsBtn.type = 'button';
  gpsBtn.className = 'hw-mini-btn city-gps-btn' + (currentLocation.useGeolocation ? ' is-active' : '');
  gpsBtn.innerHTML = GPS_SVG;
  gpsBtn.title = 'Use Local GPS';
  gpsBtn.setAttribute('aria-label', 'Use Local GPS');
  gpsBtn.addEventListener('click', () => {
    closeList();
    void onSelect({
      ...currentLocation,
      city: 'Local GPS',
      country: undefined,
      useGeolocation: true
    });
  });

  const dropdown = document.createElement('div');
  dropdown.className = 'city-picker-dropdown';
  dropdown.hidden = true;

  row.append(input, gpsBtn);
  root.append(row, dropdown);

  let debounceId: number | undefined;
  let activeSeq = 0;
  let items: GeocodingResult[] = [];
  let highlight = -1;
  let lastQuery = '';

  const closeList = (): void => {
    dropdown.hidden = true;
    dropdown.replaceChildren();
    items = [];
    highlight = -1;
  };

  const commitCity = (item: GeocodingResult): void => {
    window.clearTimeout(debounceId);
    closeList();
    input.value = item.name;
    input.blur();
    void onSelect({
      city: item.name,
      country: item.country,
      lat: item.latitude,
      lon: item.longitude,
      useGeolocation: false,
      unit: currentLocation.unit ?? 'c'
    });
  };

  const renderDropdown = (list: GeocodingResult[], statusText?: string): void => {
    dropdown.replaceChildren();
    items = list;
    highlight = list.length > 0 ? 0 : -1;

    if (statusText) {
      const msg = document.createElement('div');
      msg.className = 'city-picker-status';
      msg.textContent = statusText;
      dropdown.appendChild(msg);
      dropdown.hidden = false;
      return;
    }

    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'city-picker-status';
      empty.textContent = 'No matching places found. Try "City, Country" or lat, lon.';
      dropdown.appendChild(empty);
      dropdown.hidden = false;
      return;
    }

    list.forEach((city, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'city-picker-item' + (idx === highlight ? ' is-highlighted' : '');

      const primary = document.createElement('span');
      primary.className = 'city-picker-name';
      primary.textContent = city.name;

      const meta = document.createElement('span');
      meta.className = 'city-picker-meta';
      const regionParts = [city.admin1, city.country].filter(Boolean);
      const coordStr = `${city.latitude.toFixed(2)}°, ${city.longitude.toFixed(2)}°`;
      meta.textContent = regionParts.length > 0 ? `${regionParts.join(', ')} · ${coordStr}` : coordStr;

      btn.append(primary, meta);
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        commitCity(city);
      });
      dropdown.appendChild(btn);
    });

    dropdown.hidden = false;
  };

  const showQuickPicks = (): void => {
    const quick: GeocodingResult[] = WEATHER_CITIES.map((c) => ({
      name: c.city,
      latitude: c.lat,
      longitude: c.lon
    }));
    renderDropdown(quick);
  };

  const runLiveSearch = async (q: string): Promise<GeocodingResult[]> => {
    const seq = ++activeSeq;
    lastQuery = q;
    renderDropdown([], 'Searching worldwide...');
    const results = await searchCities(q);
    if (seq !== activeSeq) return [];
    renderDropdown(results);
    return results;
  };

  input.addEventListener('focus', () => {
    input.select();
    if (input.value.trim().length < 2) {
      showQuickPicks();
    }
  });

  input.addEventListener('input', () => {
    window.clearTimeout(debounceId);
    const q = input.value.trim();
    if (q.length < 2) {
      lastQuery = '';
      showQuickPicks();
      return;
    }

    renderDropdown([], 'Searching worldwide...');
    debounceId = window.setTimeout(() => {
      void runLiveSearch(q);
    }, 200);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && items.length > 0) {
      e.preventDefault();
      highlight = (highlight + 1) % items.length;
      dropdown.querySelectorAll('.city-picker-item').forEach((el, idx) => {
        el.classList.toggle('is-highlighted', idx === highlight);
      });
    } else if (e.key === 'ArrowUp' && items.length > 0) {
      e.preventDefault();
      highlight = (highlight - 1 + items.length) % items.length;
      dropdown.querySelectorAll('.city-picker-item').forEach((el, idx) => {
        el.classList.toggle('is-highlighted', idx === highlight);
      });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      if (items.length > 0 && q === lastQuery) {
        commitCity(items[Math.max(0, highlight)]);
      } else if (q.length >= 2) {
        window.clearTimeout(debounceId);
        void runLiveSearch(q).then((results) => {
          if (results.length > 0) {
            commitCity(results[0]);
          }
        });
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeList();
      input.value = currentLocation.useGeolocation ? '' : currentLocation.city;
      input.blur();
    }
  });

  input.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (!root.contains(document.activeElement)) {
        closeList();
        if (!currentLocation.useGeolocation) {
          input.value = currentLocation.city;
        }
      }
    }, 150);
  });

  return root;
}

function weatherGlyphSvg(code: number): string {
  // Clean geometric Braun-style 1.5px stroke SVGs
  if (code <= 1) {
    return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"/></svg>';
  }
  if (code <= 3 || code === 45 || code === 48) {
    return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7.5 18h9.2a3.8 3.8 0 0 0 .5-7.6A5.5 5.5 0 0 0 6.6 9.1 3.5 3.5 0 0 0 7.5 18Z"/></svg>';
  }
  if (code >= 71 && code <= 77) {
    return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 14.5h10a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.6-1A3.2 3.2 0 0 0 7 14.5Z"/><path d="M8.5 18.5h.01M12 19.5h.01M15.5 18.5h.01" stroke-width="2.4" stroke-linecap="round"/></svg>';
  }
  if (code >= 95) {
    return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 14h10a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.6-1A3.2 3.2 0 0 0 7 14Z"/><path d="M13 14l-2.5 4h3L11.5 22"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 14h10a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.6-1A3.2 3.2 0 0 0 7 14Z"/><path d="M9 17.5l-1 3M13 17.5l-1 3M17 17.5l-1 3" stroke-linecap="round"/></svg>';
}

export async function fetchWeatherData(
  loc: WeatherLocation,
  forceRefresh = false
): Promise<WeatherSnapshot | null> {
  let lat = loc.lat;
  let lon = loc.lon;
  let city = loc.city;

  if (loc.useGeolocation && 'geolocation' in navigator) {
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 4000 });
      });
      lat = Number(pos.coords.latitude.toFixed(3));
      lon = Number(pos.coords.longitude.toFixed(3));
      city = 'Local GPS';
    } catch {
      // fall back to stored lat/lon
    }
  }

  const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (!forceRefresh) {
    try {
      const stored = await new Promise<WeatherSnapshot | undefined>((resolve) => {
        chrome.storage.local.get([STORAGE_KEY], (r) => resolve((r as Record<string, WeatherSnapshot>)[STORAGE_KEY]));
      });
      if (stored && stored.key === cacheKey && Date.now() - stored.fetchedAt < CACHE_TTL) {
        return { ...stored, city };
      }
    } catch {
      // ignore cache errors
    }
  }

  try {
    const [weatherResp, aqiResp] = await Promise.all([
      fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`
      ),
      fetch(
        `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=european_aqi`
      )
    ]);

    if (!weatherResp.ok) return null;
    const weather = await weatherResp.json();
    const aqiData = aqiResp.ok ? await aqiResp.json() : {};

    const current = weather.current;
    const daily = weather.daily;
    const aqi = Math.round(aqiData.current?.european_aqi ?? 0);

    const cache: WeatherSnapshot = {
      key: cacheKey,
      city,
      temp: Math.round(current.temperature_2m),
      feelsLike: Math.round(current.apparent_temperature ?? current.temperature_2m),
      windKmh: Math.round(current.wind_speed_10m ?? 0),
      code: current.weather_code,
      condition: WMO_CODES[current.weather_code] || 'Clear',
      aqi,
      aqiLabel: aqiDescriptor(aqi).label,
      high: Math.round(daily.temperature_2m_max[0]),
      low: Math.round(daily.temperature_2m_min[0]),
      fetchedAt: Date.now()
    };

    try {
      chrome.storage.local.set({ [STORAGE_KEY]: cache });
    } catch {
      // ignore
    }

    return cache;
  } catch {
    return null;
  }
}

export interface WeatherWidgetDeps {
  getSettings: () => Settings;
  onUpdateLocation: (loc: WeatherLocation) => Promise<void>;
}

export function createWeatherWidget(deps: WeatherWidgetDeps): WidgetDef {
  return {
    id: 'weather',
    title: 'Weather & AQI',
    defaultSize: { colSpan: 2, rowSpan: 1 },
    async render(container) {
      const renderInternal = async (forceRefresh: boolean): Promise<void> => {
        container.replaceChildren();
        const loc = deps.getSettings().weather;
        const unit: TempUnit = loc.unit ?? 'c';

        // Header with planet-wide searchable city picker
        const header = document.createElement('div');
        header.className = 'mod-header';

        const titleWrap = document.createElement('div');
        titleWrap.className = 'mod-title-group';
        const title = document.createElement('h3');
        title.className = 'mod-title';
        title.textContent = 'Atmosphere';
        titleWrap.appendChild(title);

        const controls = document.createElement('div');
        controls.className = 'mod-controls';

        const cityPicker = createCitySearchControl({
          currentLocation: loc,
          compact: true,
          onSelect: async (nextLoc) => {
            await deps.onUpdateLocation(nextLoc);
            await renderInternal(true);
          }
        });

        const refreshBtn = document.createElement('button');
        refreshBtn.type = 'button';
        refreshBtn.className = 'hw-mini-btn';
        refreshBtn.textContent = '↻';
        refreshBtn.title = 'Refresh weather';
        refreshBtn.addEventListener('click', () => void renderInternal(true));

        controls.append(cityPicker, refreshBtn);
        header.append(titleWrap, controls);

        const body = document.createElement('div');
        body.className = 'weather-body';
        body.innerHTML = '<div class="mod-loading">Reading local telemetry...</div>';

        container.append(header, body);

        const data = await fetchWeatherData(loc, forceRefresh);
        body.replaceChildren();

        if (!data) {
          const err = document.createElement('div');
          err.className = 'mod-empty';
          err.textContent = 'Weather service unavailable. Check network or retry.';
          body.appendChild(err);
          return;
        }

        // Left: Temperature + Condition
        const mainReadout = document.createElement('div');
        mainReadout.className = 'weather-main';

        const iconBox = document.createElement('div');
        iconBox.className = 'weather-icon';
        iconBox.innerHTML = weatherGlyphSvg(data.code);

        const tempCol = document.createElement('div');
        tempCol.className = 'weather-temp-col';

        const tempVal = document.createElement('div');
        tempVal.className = 'weather-temp';
        tempVal.textContent = formatTemp(data.temp, unit);

        const condLine = document.createElement('div');
        condLine.className = 'weather-cond';
        condLine.textContent = `${data.condition} · Feels ${formatTemp(data.feelsLike, unit, false)}`;

        tempCol.append(tempVal, condLine);
        mainReadout.append(iconBox, tempCol);

        // Right: Hi/Lo + Wind + Segmented AQI Meter
        const metrics = document.createElement('div');
        metrics.className = 'weather-metrics';

        const rangeLine = document.createElement('div');
        rangeLine.className = 'weather-range';
        rangeLine.textContent = `H ${formatTemp(data.high, unit, false)} / L ${formatTemp(data.low, unit, false)} · Wind ${formatSpeed(data.windKmh, unit)}`;

        const aqiDesc = aqiDescriptor(data.aqi);
        const aqiRow = document.createElement('div');
        aqiRow.className = 'weather-aqi-row';

        const aqiLabel = document.createElement('span');
        aqiLabel.className = `weather-aqi-label is-${aqiDesc.level}`;
        aqiLabel.textContent = `AQI ${data.aqi} · ${aqiDesc.label}`;

        const meter = document.createElement('div');
        meter.className = 'weather-aqi-meter';
        meter.setAttribute('aria-hidden', 'true');
        const filledCount = Math.max(1, Math.min(10, Math.round((data.aqi / 180) * 10)));
        for (let i = 0; i < 10; i++) {
          const seg = document.createElement('span');
          seg.className = 'weather-aqi-seg' + (i < filledCount ? ` is-filled is-${aqiDesc.level}` : '');
          meter.appendChild(seg);
        }

        aqiRow.append(aqiLabel, meter);
        metrics.append(rangeLine, aqiRow);
        body.append(mainReadout, metrics);
      };

      await renderInternal(false);
    }
  };
}

import type { FinanceAssetId } from './constants';

export type CalendarType = 'gregorian' | 'jalali';

export type ThemePresetId =
  | 'graphite'
  | 'braun-chalk'
  | 'paper-swiss'
  | 'obsidian'
  | 'field-olive'
  | 'dusk-slate'
  | 'warm-travertine';

export type AccentName =
  | 'random'
  | 'purple'
  | 'blue'
  | 'teal'
  | 'rose'
  | 'gold'
  | 'lime'
  | 'orange'
  | 'cyan'
  | 'magenta'
  | 'silver';

export interface PriceAlert {
  id: string;
  asset: FinanceAssetId;
  above?: number;
  below?: number;
  enabled: boolean;
}

export type TempUnit = 'c' | 'f';
export type ClockScale = 'compact' | 'standard' | 'large';
export type LayoutDensity = 'compact' | 'standard' | 'spacious';
export type BookmarkIconStyle = 'dithered' | 'solid' | 'original' | 'monochrome' | 'off';
export type ScrollbarStyle = 'thin' | 'accent' | 'hidden';

export interface WeatherLocation {
  city: string;
  country?: string;
  lat: number;
  lon: number;
  useGeolocation: boolean;
  unit?: TempUnit;
}

export interface NewsSettings {
  sourceId: string;
  customUrl: string;
  keywords: string[];
}

export interface Settings {
  appearance: {
    accent: AccentName;
    themePreset: ThemePresetId;
    customAccent: string;
    customBg: string;
    clockScale: ClockScale;
    density: LayoutDensity;
    bookmarkIconStyle: BookmarkIconStyle;
    scrollbarStyle: ScrollbarStyle;
    showBookmarkHosts: boolean;
    showBookmarkIndices: boolean;
    surfaceGrid: boolean;
    colorPalette: string[];
  };
  general: {
    calendar: CalendarType;
    clock24h: boolean;
    showSeconds: boolean;
    showDualDate: boolean;
    showDailyFocus: boolean;
    rememberDrawerState: boolean;
  };
  weather: WeatherLocation;
  news: NewsSettings;
  widgets: {
    priceTicker: boolean;
    newsWidget: boolean;
    greeting: boolean;
    intention: boolean;
    weather: boolean;
    calendar: boolean;
    rss: boolean;
    habits: boolean;
    focus: boolean;
  };
  privacy: {
    historySearch: boolean;
    clipboardHistory: boolean;
  };
  finance: {
    assets: FinanceAssetId[];
    alerts: PriceAlert[];
  };
}

export interface Shortcut {
  title: string;
  url: string;
}

export interface NoteData {
  id: number;
  title?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  text: string;
  color?: string;
  swatch?: 'surface' | 'orange' | 'cobalt' | 'sage' | 'ochre' | 'graphite';
  checklist?: boolean;
  pinned?: boolean;
  collapsed?: boolean;
  updatedAt?: number;
}

// Background message protocol
export interface FetchSuggestionsRequest {
  action: 'FETCH_SUGGESTIONS';
  query: string;
}

export interface ProxyFetchRequest {
  action: 'PROXY_FETCH';
  url: string;
}

export interface FetchRssRequest {
  action: 'FETCH_RSS';
  url: string;
}

export interface GetFaviconRequest {
  action: 'GET_FAVICON';
  domain: string;
}

export type BackgroundRequest =
  | FetchSuggestionsRequest
  | ProxyFetchRequest
  | FetchRssRequest
  | GetFaviconRequest;

export interface SuccessResponse<T = unknown> {
  success: true;
  data: T;
}

export interface ErrorResponse {
  success: false;
  error: string;
}

export type BackgroundResponse<T = unknown> = SuccessResponse<T> | ErrorResponse;

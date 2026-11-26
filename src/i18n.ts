const en = {
  search: 'Search, !bang, 2+2, 100 usd, or >command',
  newNote: 'New Note',
  addShortcut: 'Add Shortcut',
  editShortcut: 'Edit Shortcut',
  name: 'Name',
  address: 'URL Address',
  addToHome: 'Add Keycap',
  saveChanges: 'Save Changes',
  settings: 'Preferences',
  openSettings: 'Open preferences',
  general: 'General',
  appearance: 'Themes',
  commands: 'Commands',
  modules: 'Modules',
  widgets: 'Widgets',
  about: 'About',
  calendar: 'Primary calendar',
  gregorian: 'Gregorian',
  jalali: 'Jalali',
  clockFormat: 'Clock format',
  clock24h: '24-hour',
  clock12h: '12-hour',
  showSeconds: 'Show seconds readout',
  showDualDate: 'Show dual Gregorian & Jalali date',
  rememberDrawer: 'Remember workspace drawer state',
  accentColor: 'Custom accent override',
  surfaceGrid: 'Tactile micro-grid chassis',
  random: 'Theme default',
  themePreset: 'Hardware theme preset',
  midnight: 'Graphite Studio',
  priceTicker: 'Bottom market readout',
  newsWidget: 'Bottom breaking news headline',
  suggestedSites: 'Suggested sites row',
  suggested: 'Suggested',
  greeting: 'Greeting',
  intention: 'Daily intention',
  weather: 'Weather & AQI',
  calendarWidget: 'Dual Calendar',
  rssWidget: 'RSS Inbox',
  habitsWidget: 'Habits',
  focusWidget: 'Focus',
  finance: 'Market Pulse',
  financeAssets: 'Tracked market assets',
  financeAsset_usd: 'US Dollar (USD)',
  financeAsset_gold: 'Gold 18K (gram)',
  financeAsset_eur: 'Euro (EUR)',
  privacy: 'Privacy & Backup',
  historySearch: 'Search browser history in command bar',
  clipboardHistory: 'Capture clipboard on paste',
  clipboardNote: 'Clipboard entries are captured only when you paste into the command slot, stored locally, and never synced.',
  versionLabel: 'Build Version',
  reloadExtension: 'Reload Extension',
  dataSources: 'Markets by TGJU / BRS · Weather by Open-Meteo · Headlines via RSS.',
  noRecentNews: 'No recent top stories available',
  loadingTopStory: 'Fetching latest headline...',
  breaking: 'BBC World',
  deleteShortcut: 'Delete {name}',
  deleteNote: 'Delete note'
} as const;

export type StringKey = keyof typeof en;

export function t(key: StringKey, vars?: Record<string, string>): string {
  let s: string = en[key];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(`{${k}}`, v);
    }
  }
  return s;
}

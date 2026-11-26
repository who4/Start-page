// Multi-source RSS Reader & Breaking Headlines module.
import { ApiClient } from './api';
import { storage } from './storage';
import type { WidgetDef } from './grid';

const FEEDS_KEY = 'rssFeeds';
const ITEMS_KEY = 'rssItems';
const SEEDED_KEY = 'rssSeededV2';

export interface RssFeed {
  id: string;
  title: string;
  url: string;
}

interface RssItem {
  feedId: string;
  title: string;
  link: string;
  pubDate: number;
  read: boolean;
}

const CURATED_FEEDS: Array<{ title: string; url: string }> = [
  { title: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  {
    title: 'Iran Monitor',
    url: 'https://www.iranmonitor.org/api/events'
  },
  { title: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { title: 'Hacker News', url: 'https://hnrss.org/frontpage' },
  { title: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
  { title: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' }
];

async function getFeeds(): Promise<RssFeed[]> {
  const seeded = await storage.get<boolean>(SEEDED_KEY, false);
  const feeds = await storage.get<RssFeed[]>(FEEDS_KEY, []);
  if (!seeded && feeds.length === 0) {
    const initial: RssFeed[] = [{ id: 'bbc-world', title: 'BBC World', url: CURATED_FEEDS[0].url }];
    await storage.set(FEEDS_KEY, initial);
    await storage.set(SEEDED_KEY, true);
    return initial;
  }
  return feeds;
}

async function getItems(): Promise<RssItem[]> {
  return storage.get<RssItem[]>(ITEMS_KEY, []);
}

async function saveItems(items: RssItem[]): Promise<void> {
  await storage.set(ITEMS_KEY, items);
}

async function fetchFeed(
  url: string
): Promise<{ title: string; items: Array<{ title: string; link: string; pubDate: number }> }> {
  const result = await ApiClient.fetchRssFeed(url);
  return {
    title: result.title,
    items: result.items.map((item) => ({
      title: item.title || 'Untitled',
      link: item.link || '',
      pubDate: item.pubDate || Date.now()
    }))
  };
}

async function refreshAllFeeds(): Promise<void> {
  const feeds = await getFeeds();
  const existing = await getItems();
  const validFeedIds = new Set(feeds.map((f) => f.id));
  const kept = existing.filter((i) => validFeedIds.has(i.feedId));
  const existingLinks = new Set(kept.map((i) => i.link));

  const newItems: RssItem[] = [];
  for (const feed of feeds) {
    const result = await fetchFeed(feed.url);
    if (result.title && !feed.title) {
      feed.title = result.title;
    }
    for (const item of result.items) {
      if (!item.link || existingLinks.has(item.link)) continue;
      existingLinks.add(item.link);
      newItems.push({
        feedId: feed.id,
        title: item.title,
        link: item.link,
        pubDate: item.pubDate,
        read: false
      });
    }
  }

  const all = [...kept, ...newItems].sort((a, b) => b.pubDate - a.pubDate);
  if (all.length > 200) all.length = 200;
  await saveItems(all);
  await storage.set(FEEDS_KEY, feeds);
}

function timeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function createRssWidget(): WidgetDef {
  let filterMode: 'all' | 'unread' = 'all';
  let showManage = false;
  let initialFetched = false;

  return {
    id: 'rss',
    title: 'RSS Inbox',
    defaultSize: { colSpan: 2, rowSpan: 2 },
    async render(container) {
      const renderInternal = async (): Promise<void> => {
        container.replaceChildren();
        const feeds = await getFeeds();
        let items = await getItems();

        // Auto-fetch once on first load if inbox is empty
        if (!initialFetched && feeds.length > 0 && items.length === 0) {
          initialFetched = true;
          const loading = document.createElement('div');
          loading.className = 'mod-loading';
          loading.textContent = 'Syncing headlines...';
          container.appendChild(loading);
          await refreshAllFeeds();
          items = await getItems();
          container.replaceChildren();
        }

        const unreadCount = items.filter((i) => !i.read).length;

        // Header
        const header = document.createElement('div');
        header.className = 'mod-header';

        const titleWrap = document.createElement('div');
        titleWrap.className = 'mod-title-group';
        const title = document.createElement('h3');
        title.className = 'mod-title';
        title.textContent = 'RSS Wire';
        const meta = document.createElement('span');
        meta.className = 'mod-meta';
        meta.textContent = `${feeds.length} ${feeds.length === 1 ? 'source' : 'sources'}${unreadCount > 0 ? ` · ${unreadCount} unread` : ''}`;
        titleWrap.append(title, meta);

        const controls = document.createElement('div');
        controls.className = 'mod-controls';

        const seg = document.createElement('div');
        seg.className = 'hw-seg';
        for (const [m, lbl] of [
          ['all', 'All'],
          ['unread', 'Unread']
        ] as const) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'hw-seg-btn' + (filterMode === m ? ' is-active' : '');
          btn.textContent = lbl;
          btn.addEventListener('click', () => {
            filterMode = m;
            void renderInternal();
          });
          seg.appendChild(btn);
        }

        const manageBtn = document.createElement('button');
        manageBtn.type = 'button';
        manageBtn.className = 'hw-mini-btn' + (showManage ? ' is-active' : '');
        manageBtn.textContent = '+ Feed';
        manageBtn.addEventListener('click', () => {
          showManage = !showManage;
          void renderInternal();
        });

        const refreshBtn = document.createElement('button');
        refreshBtn.type = 'button';
        refreshBtn.className = 'hw-mini-btn';
        refreshBtn.textContent = '↻';
        refreshBtn.title = 'Refresh feeds';
        refreshBtn.addEventListener('click', async () => {
          refreshBtn.textContent = '…';
          refreshBtn.disabled = true;
          await refreshAllFeeds();
          await renderInternal();
        });

        controls.append(seg, manageBtn, refreshBtn);
        header.append(titleWrap, controls);
        container.appendChild(header);

        // Collapsible Feed Management Panel
        if (showManage) {
          const panel = document.createElement('div');
          panel.className = 'rss-manage-panel';

          const form = document.createElement('form');
          form.className = 'rss-add-form';
          const input = document.createElement('input');
          input.type = 'url';
          input.placeholder = 'https://example.com/rss.xml';
          input.className = 'hw-input-sm';
          const submit = document.createElement('button');
          submit.type = 'submit';
          submit.className = 'hw-mini-btn is-accent';
          submit.textContent = 'Add';
          form.append(input, submit);

          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const url = input.value.trim();
            if (!url) return;
            const current = await getFeeds();
            if (!current.some((f) => f.url === url)) {
              current.push({ id: `feed-${Date.now()}`, title: '', url });
              await storage.set(FEEDS_KEY, current);
              await refreshAllFeeds();
            }
            input.value = '';
            await renderInternal();
          });

          // Quick-add presets
          const quickRow = document.createElement('div');
          quickRow.className = 'rss-quick-row';
          for (const preset of CURATED_FEEDS) {
            const exists = feeds.some((f) => f.url === preset.url);
            if (exists) continue;
            const qBtn = document.createElement('button');
            qBtn.type = 'button';
            qBtn.className = 'hw-mini-btn';
            qBtn.textContent = `+ ${preset.title}`;
            qBtn.addEventListener('click', async () => {
              const current = await getFeeds();
              current.push({ id: `feed-${Date.now()}`, title: preset.title, url: preset.url });
              await storage.set(FEEDS_KEY, current);
              await refreshAllFeeds();
              await renderInternal();
            });
            quickRow.appendChild(qBtn);
          }

          // Active feeds list
          const feedList = document.createElement('div');
          feedList.className = 'rss-active-feeds';
          for (const f of feeds) {
            const row = document.createElement('div');
            row.className = 'rss-feed-item';
            const name = document.createElement('span');
            name.textContent = f.title || f.url;
            const rm = document.createElement('button');
            rm.type = 'button';
            rm.className = 'hw-mini-btn';
            rm.textContent = '×';
            rm.setAttribute('aria-label', `Remove ${f.title || f.url}`);
            rm.addEventListener('click', async () => {
              const remaining = feeds.filter((x) => x.id !== f.id);
              await storage.set(FEEDS_KEY, remaining);
              const keptItems = (await getItems()).filter((i) => i.feedId !== f.id);
              await saveItems(keptItems);
              await renderInternal();
            });
            row.append(name, rm);
            feedList.appendChild(row);
          }

          panel.append(form);
          if (quickRow.childElementCount > 0) panel.appendChild(quickRow);
          if (feeds.length > 0) panel.appendChild(feedList);
          container.appendChild(panel);
        }

        // Article list
        const visible = filterMode === 'unread' ? items.filter((i) => !i.read) : items;
        if (visible.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'mod-empty';
          empty.textContent =
            feeds.length === 0
              ? 'No feeds subscribed yet. Click "+ Feed" to add sources.'
              : filterMode === 'unread'
                ? 'All caught up — zero unread stories.'
                : 'No headlines loaded yet. Click ↻ to refresh.';
          container.appendChild(empty);
          return;
        }

        const feedMap = new Map(feeds.map((f) => [f.id, f.title || 'RSS']));
        const list = document.createElement('div');
        list.className = 'rss-list';

        for (const item of visible.slice(0, 24)) {
          const row = document.createElement('a');
          row.className = 'rss-row' + (item.read ? ' is-read' : '');
          row.href = item.link;
          row.target = '_blank';
          row.rel = 'noopener noreferrer';

          row.addEventListener('click', () => {
            if (!item.read) {
              item.read = true;
              row.classList.add('is-read');
              void saveItems(items);
            }
          });

          const metaLine = document.createElement('div');
          metaLine.className = 'rss-row-meta';
          metaLine.textContent = `${feedMap.get(item.feedId) ?? 'RSS'} · ${timeAgo(item.pubDate)}`;

          const headline = document.createElement('div');
          headline.className = 'rss-row-title';
          headline.textContent = item.title;

          row.append(metaLine, headline);
          list.appendChild(row);
        }

        container.appendChild(list);

        if (unreadCount > 0) {
          const footer = document.createElement('div');
          footer.className = 'rss-footer';
          const markBtn = document.createElement('button');
          markBtn.type = 'button';
          markBtn.className = 'hw-link-btn';
          markBtn.textContent = `Mark all ${unreadCount} as read`;
          markBtn.addEventListener('click', async () => {
            const all = await getItems();
            all.forEach((i) => {
              i.read = true;
            });
            await saveItems(all);
            await renderInternal();
          });
          footer.appendChild(markBtn);
          container.appendChild(footer);
        }
      };

      await renderInternal();
    }
  };
}

// Keep legacy export name so nothing importing rssWidget breaks
export const rssWidget = createRssWidget();

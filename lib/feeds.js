// Curated RSS feed categories. Clients pick categories (by key OR label, e.g.
// "technology" or "Technology"); these resolve to known feed URLs at fetch time.
// Feeds are ordered most-reliable-first so the daily picker prefers stable
// sources and falls through to the rest only if needed.
const CATEGORIES = {
  us_politics: {
    label: "US Politics",
    feeds: [
      "https://feeds.npr.org/1014/rss.xml",                      // NPR Politics (reliable)
      "https://feeds.washingtonpost.com/rss/politics",           // WaPo (may 403 sometimes)
      "https://rss.politico.com/politics-news.xml"               // Politico (flaky)
    ]
  },
  technology: {
    label: "Technology",
    feeds: [
      "https://techcrunch.com/feed/",
      "https://www.theverge.com/rss/index.xml",
      "https://feeds.arstechnica.com/arstechnica/index"
    ]
  },
  world: {
    label: "World News",
    feeds: [
      "https://feeds.bbci.co.uk/news/world/rss.xml",
      "https://www.aljazeera.com/xml/rss/all.xml"
    ]
  },
  business: {
    label: "Business & Finance",
    feeds: [
      "https://feeds.bbci.co.uk/news/business/rss.xml",
      "https://feeds.npr.org/1006/rss.xml"
    ]
  },
  science: {
    label: "Science",
    feeds: [
      "https://www.sciencedaily.com/rss/top/science.xml",
      "https://feeds.npr.org/1007/rss.xml"
    ]
  },
  health: {
    label: "Health",
    feeds: [
      "https://feeds.npr.org/1128/rss.xml",
      "https://www.sciencedaily.com/rss/health_medicine.xml"
    ]
  },
  sports: {
    label: "Sports",
    feeds: [
      "https://feeds.bbci.co.uk/sport/rss.xml",
      "https://www.espn.com/espn/rss/news"
    ]
  },
  entertainment: {
    label: "Entertainment",
    feeds: [
      "https://variety.com/feed/",
      "https://feeds.npr.org/1008/rss.xml"
    ]
  },
  india: {
    label: "India",
    feeds: [
      "https://feeds.feedburner.com/ndtvnews-top-stories",
      "https://www.thehindu.com/feeder/default.rss",
      "https://www.indiatoday.in/rss/home"
    ]
  }
};

// Build a label→key map once (lowercased) so lookups accept labels too.
const LABEL_TO_KEY = {};
for (const [id, c] of Object.entries(CATEGORIES)) {
  LABEL_TO_KEY[c.label.toLowerCase()] = id;
}

/** Normalize one category token (key or label) to a canonical category key. */
function resolveKey(token) {
  if (!token) return null;
  const t = String(token).trim();
  if (CATEGORIES[t]) return t;                                   // exact key
  const lower = t.toLowerCase();
  if (CATEGORIES[lower]) return lower;                           // case-insensitive key
  if (LABEL_TO_KEY[lower]) return LABEL_TO_KEY[lower];           // by label
  // last resort: match a key with spaces/dashes normalized to underscores
  const norm = lower.replace(/[\s-]+/g, "_");
  return CATEGORIES[norm] ? norm : null;
}

/** Resolve category keys/labels to a de-duplicated list of feed URLs. */
function feedsForCategories(keys = []) {
  const out = new Set();
  (keys || []).forEach(k => {
    const key = resolveKey(k);
    (CATEGORIES[key]?.feeds || []).forEach(u => out.add(u));
  });
  return [...out];
}

/**
 * Resolve category keys/labels to a MAP of { canonicalKey: [feedUrls] }, so the
 * scheduler can pick one unique article PER category. Unknown tokens are skipped.
 */
function feedsByCategory(keys = []) {
  const map = {};
  (keys || []).forEach(k => {
    const key = resolveKey(k);
    if (key && CATEGORIES[key]) map[key] = CATEGORIES[key].feeds.slice();
  });
  return map;
}

/** For the UI dropdown. */
function list() {
  return Object.entries(CATEGORIES).map(([id, c]) => ({ id, label: c.label, count: c.feeds.length }));
}

module.exports = { CATEGORIES, feedsForCategories, feedsByCategory, resolveKey, list };

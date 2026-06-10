// Curated RSS feed categories. Clients pick categories (e.g. "US Politics",
// "Technology"); these resolve to known feed URLs at fetch time.

const CATEGORIES = {
  us_politics: {
    label: "US Politics",
    feeds: [
      "https://feeds.npr.org/1014/rss.xml",
      "https://rss.politico.com/politics-news.xml",
      "https://feeds.washingtonpost.com/rss/politics"
    ]
  },
  technology: {
    label: "Technology",
    feeds: [
      "https://feeds.arstechnica.com/arstechnica/index",
      "https://www.theverge.com/rss/index.xml",
      "https://techcrunch.com/feed/"
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
      "https://feeds.npr.org/1007/rss.xml",
      "https://www.sciencedaily.com/rss/top/science.xml"
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
      "https://www.espn.com/espn/rss/news",
      "https://feeds.bbci.co.uk/sport/rss.xml"
    ]
  },
  entertainment: {
    label: "Entertainment",
    feeds: [
      "https://feeds.npr.org/1008/rss.xml",
      "https://variety.com/feed/"
    ]
  }
};

/** Resolve a list of category keys to a de-duplicated list of feed URLs. */
function feedsForCategories(keys = []) {
  const out = new Set();
  (keys || []).forEach(k => (CATEGORIES[k]?.feeds || []).forEach(u => out.add(u)));
  return [...out];
}

/** For the UI dropdown. */
function list() {
  return Object.entries(CATEGORIES).map(([id, c]) => ({ id, label: c.label, count: c.feeds.length }));
}

module.exports = { CATEGORIES, feedsForCategories, list };
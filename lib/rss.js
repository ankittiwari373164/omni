const Parser = require("rss-parser");
const parser = new Parser({ timeout: 15000 });

/** Parse the client's feed config (newline or comma separated) into URLs. */
function feedUrls(raw) {
  return String(raw || "")
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Fetch all feeds for a client and return a flat, de-duplicated list of items
 * shaped like { title, link, summary, isoDate }.
 * `limit` caps how many newest items are returned overall.
 */
async function fetchFeeds(rawFeeds, limit = 10) {
  const urls = feedUrls(rawFeeds);
  const all = [];
  for (const url of urls) {
    try {
      const feed = await parser.parseURL(url);
      (feed.items || []).forEach(it => {
        if (!it.link) return;
        all.push({
          title: (it.title || "").trim(),
          link: it.link.trim(),
          summary: (it.contentSnippet || it.content || it.summary || "").trim().slice(0, 400),
          isoDate: it.isoDate || it.pubDate || null
        });
      });
    } catch (e) {
      // skip a broken feed but keep going
      console.log("RSS fetch failed for", url, "-", e.message);
    }
  }
  // newest first, de-dup by link
  const seen = new Set();
  const sorted = all
    .filter(i => (seen.has(i.link) ? false : seen.add(i.link)))
    .sort((a, b) => new Date(b.isoDate || 0) - new Date(a.isoDate || 0));
  return sorted.slice(0, limit);
}

/**
 * Fetch the LATEST article for a free-text TOPIC (not a curated category) —
 * used by the day-fixed monthly topics feature. No API key: Google News'
 * public RSS search endpoint. Returns { title, link, summary, isoDate } or
 * null if nothing found.
 */
async function fetchTopicArticles(topic, limit = 10) {
  const q = encodeURIComponent(String(topic || "").trim());
  if (!q) return [];
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
  try {
    const feed = await parser.parseURL(url);
    return (feed.items || []).slice(0, limit).filter(it => it.link).map(it => ({
      title: (it.title || "").trim(),
      link: it.link.trim(),
      summary: (it.contentSnippet || it.content || it.summary || "").trim().slice(0, 600),
      isoDate: it.isoDate || it.pubDate || null
    }));
  } catch (e) {
    console.log("Topic article fetch failed for", topic, "-", e.message);
    return [];
  }
}

// Back-compat single-article version (first result).
async function fetchTopicArticle(topic) {
  const items = await fetchTopicArticles(topic, 1);
  return items[0] || null;
}

module.exports = { fetchFeeds, feedUrls, fetchTopicArticle, fetchTopicArticles };

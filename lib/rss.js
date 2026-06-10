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

module.exports = { fetchFeeds, feedUrls };
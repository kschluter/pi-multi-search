import { sanitize } from "./sanitize.ts";

export async function duckduckgoSearch(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ q: query, kl: "us-en" });
  const res = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml",
    },
    signal,
  });

  if (!res.ok) throw new Error(`DuckDuckGo search failed: HTTP ${res.status}`);

  const html = await res.text();
  const anchors = [...html.matchAll(/<a\b(?=[^>]*\bclass="[^"]*result__a\b)[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...html.matchAll(/<a\b[^>]*\bclass="[^"]*result__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)];

  // local: a bot check is a **failure**, not an empty web. DuckDuckGo answers a challenged client with
  // HTTP 202 and an anomaly page, and 202 passes `res.ok`, so the parse below found nothing and the
  // footer reported "nothing found: duckduckgo" — a truthful-looking lie, and the engine is the only
  // source the shipped default enables. Measured 2026-11-15 after a day of heavy use from one address.
  if (!anchors.length && (res.status === 202 || /anomaly|challenge|bots use DuckDuckGo/i.test(html))) {
    throw new Error(
      `DuckDuckGo refused the request (bot challenge, HTTP ${res.status}) — wait a minute, or enable another source`
    );
  }

  return anchors.slice(0, maxResults).flatMap((m, i) => {
    const url = extractUrl(m[1]);
    if (!url) return [];
    return [{ title: sanitize(m[2]), url, snippet: sanitize(snippets[i]?.[1] ?? "") }];
  });
}

// DDG wraps result URLs in a redirect: /l/?uddg=<encoded-url>
function extractUrl(href: string): string | null {
  try {
    const u = new URL(href, "https://html.duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return href.startsWith("http") ? href : null;
  } catch {
    return null;
  }
}

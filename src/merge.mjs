/**
 * **The merge half of `web_search`** — pure functions over hits that have already been fetched.
 *
 * Why it is its own file, with no `fetch` and no pi in it: a fan-out is only worth having if the
 * ranking is testable without the network. Every function here takes plain data and returns plain
 * data, so `test/web-merge.test.mjs` proves the ordering, the dedupe and the diversity rule on
 * fixtures in a millisecond.
 *
 * **Reciprocal rank fusion** is the ranking, because it is the one merge rule that needs no
 * comparable scores between sources: each source only has to say what order it found things in.
 * `1 / (K + rank)` summed across sources, so a hit two indexes agree on outranks a hit that is
 * first in one and absent from the rest — which is exactly "corroboration beats enthusiasm".
 *
 * **The quota is the diversity rule.** Without it the loudest source fills the list: DuckDuckGo
 * returns ten results, arXiv returns two, and the reader concludes the web and arXiv disagree.
 * So no single source may contribute more than half the budget until every other source has had
 * its turn, and if the budget is still short the cap is lifted rather than the list left thin.
 */

/** Query-string parameters that are tracking, not identity. Dropped before a URL is compared. */
const TRACKING = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|si|ref|ref_src|source)$/i;

/** A date is worth showing only if it is a date; every source spells its own. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** How many characters of a snippet are worth sending to a model. */
export const SNIPPET_CHARS = 240;

/**
 * A URL longer than this is a tracker, never a page — the measured case was a 2 KB
 * `duckduckgo.com/y.js?ad_domain=…` click-through. Printing it costs more than the result is worth
 * and tells the reader nothing they can fetch.
 */
export const MAX_URL_CHARS = 300;

/**
 * **Ads are not results.** DuckDuckGo's HTML page puts sponsored links in the same `result__a`
 * anchors as organic ones, so a fan-out that trusts the parse hands the model an advert — and a
 * paid placement ranked as evidence is worse than a shorter list. Blocked by host+path, and by the
 * two parameters the click-throughs always carry.
 */
const AD_ENDPOINTS = [
	{ host: /(^|\.)duckduckgo\.com$/, path: /^\/y\.js$/ },
	{ host: /(^|\.)bing\.com$/, path: /^\/aclick$/ },
	{ host: /(^|\.)google\.com$/, path: /^\/aclk$/ },
	{ host: /(^|\.)googleadservices\.com$/ },
	{ host: /(^|\.)doubleclick\.net$/ },
	{ host: /(^|\.)adservice\.google\.com$/ }
];

export function isAdUrl(raw) {
	let url;
	try {
		url = new URL(String(raw));
	} catch {
		return false;
	}
	const host = url.hostname.replace(/^www\./i, '').toLowerCase();
	if (AD_ENDPOINTS.some((rule) => rule.host.test(host) && (!rule.path || rule.path.test(url.pathname)))) {
		return true;
	}
	return url.searchParams.has('ad_domain') || url.searchParams.has('ad_provider');
}

/**
 * The URL two sources must share to be one result: no fragment, no tracking parameters, no
 * `www.`, no trailing slash, lower-case host. A miss here is a duplicate the reader sees twice,
 * so it is deliberately aggressive — a canonical form is for comparison only, never for fetching.
 */
export function canonicalUrl(raw) {
	if (typeof raw !== 'string') return null;
	let url;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	url.hash = '';
	url.hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
	for (const key of [...url.searchParams.keys()]) {
		if (TRACKING.test(key)) url.searchParams.delete(key);
	}
	const search = url.searchParams.toString();
	// A root path stays `/` — stripping it produced `https://en.wikipedia.org?curid=…`, which
	// resolves, and reads like a broken URL to the one reader that matters (the model choosing
	// what to fetch next).
	const path = url.pathname.replace(/\/$/, '') || '/';
	return `${url.protocol}//${url.host}${path}${search ? `?${search}` : ''}`;
}

/** One line, trimmed, capped — the shape every field leaves this module in. */
export function clean(value, max = SNIPPET_CHARS) {
	if (typeof value !== 'string') return '';
	const flat = value.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * One source's answer, normalised. Order is the source's own relevance order and is what RRF
 * scores, so it must survive from here to `fuse` untouched. A hit with no usable URL is dropped:
 * an un-fetchable result is not a result.
 */
export function normaliseHits(sourceId, hits, limit) {
	const out = [];
	// **A source may not corroborate itself.** Measured: Hacker News returned one PDF at ranks 3, 4 and
	// 5, so RRF summed three positions and pushed it to the top of a search where Brave had the answer
	// at #1. First occurrence wins, because a source's own order is its relevance order.
	const seen = new Set();
	for (const hit of hits ?? []) {
		if (isAdUrl(hit?.url)) continue;
		const url = canonicalUrl(hit?.url);
		if (!url) continue;
		if (seen.has(url)) continue;
		if (url.length > MAX_URL_CHARS) continue;
		seen.add(url);
		out.push({
			url,
			title: clean(hit.title, 160) || url,
			snippet: clean(hit.snippet),
			// ISO or nothing. Brave reports `age` as prose ("July 14, 2026", "3 days ago") alongside an
			// ISO `page_age`, and slicing prose to ten characters printed "(July 14, 2" beside a result.
			date: ISO_DATE.test(String(hit.date ?? '')) ? String(hit.date).slice(0, 10) : null,
			sources: [sourceId]
		});
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * @param {Array<{id: string, hits: Array<{url: string}>, error?: string, ms?: number}>} groups
 * @param {{limit?: number, perSourceQuota?: number|null, rrfK?: number}} options
 * @returns {{results: object[], answered: string[], empty: string[], failed: Array<{id: string, error: string}>, total: number}}
 */
export function fuse(groups, { limit = 8, perSourceQuota = null, rrfK = 60 } = {}) {
	const merged = new Map();
	const answered = [];
	const empty = [];
	const failed = [];

	for (const group of groups ?? []) {
		if (group.error) {
			failed.push({ id: group.id, error: group.error });
			continue;
		}
		if (!group.hits?.length) {
			empty.push(group.id);
			continue;
		}
		answered.push(group.id);
		// **A source's rank is only as trustworthy as the source.** Fusion treats every list as equally
		// meaningful, which is wrong here: a paid index with real ranking and a title-matching fallback
		// both contribute a #1, and without a weight they tie — measured, and the tie was broken by URL
		// order, which put "Operation Choke Point" above Brave's actual answer.
		const weight = Number(group.weight ?? 1);
		group.hits.forEach((hit, index) => {
			const score = weight / (rrfK + index + 1);
			const seen = merged.get(hit.url);
			if (!seen) {
				merged.set(hit.url, { ...hit, score, sources: [...(hit.sources ?? [group.id])] });
				return;
			}
			seen.score += score;
			for (const source of hit.sources ?? [group.id]) {
				if (!seen.sources.includes(source)) seen.sources.push(source);
			}
			// "Content-aware" in the small: the richest copy of a row wins each field, because a
			// terse index and a chatty one describe the same page differently and the reader wants
			// the longer sentence. The exception is the title, where the shorter one is the real one.
			if ((hit.snippet?.length ?? 0) > (seen.snippet?.length ?? 0)) seen.snippet = hit.snippet;
			if (seen.title === seen.url && hit.title !== hit.url) seen.title = hit.title;
			seen.date = seen.date ?? hit.date ?? null;
		});
	}

	const ranked = [...merged.values()]
		.map((hit) => ({
			...hit,
			// Corroboration is a bonus, not a multiplier worth much: two sources agreeing moves a
			// row up past one source's third result and never past its first.
			score: hit.score * (1 + 0.1 * (hit.sources.length - 1))
		}))
		.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));

	const quota = perSourceQuota ?? Math.max(1, Math.ceil(limit / 2));
	const picked = [];
	const used = new Map();
	const overflow = [];

	// **Every source that answered gets one slot before any source gets its second.** The quota
	// alone promised this in its comment and did not keep it: with three sources and a budget of six
	// (the shape a routed search actually has — `brave` + `tavily` + the role that was chosen) the
	// first two sources filled the budget at a quota of three each and the third contributed
	// **nothing**. Measured: `TypeError: x.map is not a function` routed to Stack Exchange, and no
	// Stack Exchange row appeared in the list — the index the routing picked for the question was
	// the one the merge discarded. The first pass is one per source, in ranked order; the quota
	// then decides the rest.
	const taken = new Set();
	const chosen = new Set();
	for (const hit of ranked) {
		if (picked.length >= limit) break;
		const primary = hit.sources[0];
		if (taken.has(primary)) continue;
		taken.add(primary);
		used.set(primary, 1);
		picked.push(hit);
		chosen.add(hit.url);
	}
	for (const hit of ranked) {
		if (picked.length >= limit) break;
		if (chosen.has(hit.url)) continue;
		const primary = hit.sources[0];
		const count = used.get(primary) ?? 0;
		if (count >= quota) {
			overflow.push(hit);
			continue;
		}
		used.set(primary, count + 1);
		picked.push(hit);
	}
	for (const hit of overflow) {
		if (picked.length >= limit) break;
		picked.push(hit);
	}
	// The two passes pick out of score order (a source's #1 can outrank it), and the list is a
	// ranking, so the order the reader sees is the scores' — not the order the passes happened to run.
	picked.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));

	return { results: picked, answered, empty, failed, total: ranked.length };
}

/**
 * The text a model reads. Sources are named per hit **and** in the footer, because "which index
 * said this" is the difference between a fact and a guess, and because a source that failed is
 * information — a quiet list is not the same as an empty web.
 */
export function render(fused, { query, limit = 8, plan = [], skipped = [] } = {}) {
	const lines = [];
	if (!fused.results.length) {
		lines.push(`No results for “${clean(query, 120)}”.`);
	} else {
		fused.results.forEach((hit, index) => {
			const stamp = hit.date ? ` (${hit.date})` : '';
			lines.push(`${index + 1}. ${hit.title}${stamp} [${hit.sources.join(', ')}]`);
			lines.push(`   URL: ${hit.url}`);
			if (hit.snippet) lines.push(`   ${hit.snippet}`);
		});
	}
	const bits = [];
	if (fused.answered.length) bits.push(`answered: ${fused.answered.join(', ')}`);
	if (fused.empty.length) bits.push(`nothing found: ${fused.empty.join(', ')}`);
	if (fused.failed.length) {
		bits.push(`failed: ${fused.failed.map((f) => `${f.id} (${f.error})`).join(', ')}`);
	}
	const wanted = fused.answered.length + fused.empty.length + fused.failed.length;
	lines.push('');
	lines.push(
		`${fused.results.length} of ${fused.total} merged result(s) shown; ${wanted} source(s) asked.`
	);
	if (skipped.length) bits.push(`not asked: ${skipped.map((s) => `${s.id} (${s.why})`).join(', ')}`);
	if (bits.length) lines.push(bits.join('; '));
	// Shaped queries are shown, not hidden: when a source was asked something other than the question,
	// the reader must be able to see what — otherwise "why did arXiv return that" has no answer.
	const shaped = (plan ?? []).filter(
		(entry) => entry.query && entry.query !== String(query ?? '').replace(/\s+/g, ' ').trim()
	);
	// A shaped query that already carries its own quotes (`arxiv all:"bicycle repair stand"`) was being
	// wrapped in a second pair, which printed as `arxiv "all:"bicycle repair stand""` — a footer that
	// reads as a malformed command in the one place a reader goes to ask why an index returned what it
	// returned. Quote it only when it is not quoted already.
	const shown = (entry) => (entry.query.includes('"') ? `${entry.id} ${entry.query}` : `${entry.id} "${entry.query}"`);
	if (shaped.length) {
		lines.push(`asked: ${shaped.map(shown).join(' · ')}`);
	}
	if (limit && fused.total > fused.results.length) {
		lines.push(`Raise max_results (max 20) or narrow the query for more of the same.`);
	}
	return lines.join('\n');
}

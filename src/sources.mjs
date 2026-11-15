/**
 * **Where `web_search` looks** — the sources, as data wherever a source can be described, as code
 * only where it cannot.
 *
 * The split is the point. A source that answers JSON or a feed is an entry in `sources.json`: a URL
 * template with `{query}` and `{limit}`, and the paths to a title, a URL and a snippet. That covers
 * most of the useful web — encyclopedias, paper indexes, discussion sites, news feeds — and it means
 * **a new source is a line of config, not a code change**, which is the difference between "many
 * sources" being a promise and being a thing you can do on a Sunday.
 *
 * Code is only for a source that cannot be described: DuckDuckGo's results are an HTML page, so its
 * parser is lifted code (`vendor/duckduckgo.ts`), and Wikipedia/HN/Stack Exchange get small
 * functions because their shapes differ enough to be clearer as code than as four config dialects.
 *
 * **Nothing here sanitises text** — that is `index.ts`'s one job at the boundary — and nothing here
 * knows what a tool is, so the whole module is testable with fixtures and no network.
 */
import { readFileSync } from 'node:fs';
import { duckduckgoSearch } from '../vendor/duckduckgo.ts';
import { core } from './route.mjs';

/** A source that is shipped as code, by id, because its shape is not a URL template. */
const BUILTIN = new Map([
	['duckduckgo', duckduckgo],
	['wikipedia', wikipedia],
	['hackernews', hackernews],
	['stackexchange', stackexchange]
]);

export const BUILTIN_IDS = [...BUILTIN.keys()];

/** DuckDuckGo is HTML, so its parser is lifted code — this is only the shape adapter. */
function duckduckgo(query, { limit, signal }) {
	return duckduckgoSearch(query, limit, signal);
}

// ── the three built-ins whose answers are JSON ────────────────────────────────────────────────

async function wikipedia(query, { limit, signal }) {
	const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&origin=*&srlimit=${limit}&srsearch=${encodeURIComponent(query)}`;
	const body = await getJson(url, signal);
	return (body?.query?.search ?? []).map((row) => ({
		title: row.title,
		// **The article's own URL, not `?curid=`.** The page id is a fine identifier and a bad link: no
		// other index cites an article that way, so a Wikipedia hit could never be found to be the same
		// page as Brave's or Tavily's — measured, `what is a content delivery network` returned
		// `en.wikipedia.org/?curid=880860` and `en.wikipedia.org/wiki/Content_delivery_network` as two
		// rows in one answer, which is the duplicate the whole merge exists to remove. `row.title` is
		// already here, and it is what every other source quotes.
		url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(row.title).replace(/ /g, '_'))}`,
		snippet: row.snippet
	}));
}

/**
 * Algolia matches with OR semantics and ranks by how many words hit, so a third generic word
 * ("… tools") drags in unrelated stories — measured: `content operations tools` returned a GPU-memory
 * question and a casino MVP, while the same query restricted to titles was clean but empty. So the
 * strict form is tried first and the broad one only when it finds nothing: sharpening costs a second
 * request only where the alternative is silence.
 */
async function hackernews(query, { limit, signal, fetchJson = getJson }) {
	const base = 'https://hn.algolia.com/api/v1/search';
	const strict = `${base}?restrictSearchableAttributes=title&query=${encodeURIComponent(query)}&hitsPerPage=${limit}`;
	const broad = `${base}?tags=story&query=${encodeURIComponent(query)}&hitsPerPage=${limit}`;
	let body = null;
	try {
		body = await fetchJson(strict, signal);
	} catch {
		body = null;
	}
	if (!body?.hits?.length) body = await fetchJson(broad, signal);
	return (body?.hits ?? []).map((row) => ({
		title: row.title || row.story_title || '',
		url: row.url || `https://news.ycombinator.com/item?id=${row.objectID}`,
		snippet: row.story_text || row.comment_text || `${row.points ?? 0} points, ${row.num_comments ?? 0} comments`,
		date: row.created_at
	}));
}

async function stackexchange(query, { limit, signal }) {
	const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&pagesize=${limit}&site=stackoverflow&q=${encodeURIComponent(query)}`;
	const body = await getJson(url, signal);
	return (body?.items ?? []).map((row) => ({
		title: decodeEntities(row.title),
		url: row.link,
		// `tags: a, b` and not `[a] [b]` — square brackets are how every result names the index it
		// came from, and a snippet that borrows them reads as a second source tag.
		snippet: (row.tags ?? []).length ? `tags: ${row.tags.join(', ')}` : ''
	}));
}

// ── the declarative engine ────────────────────────────────────────────────────────────────────

/** A template is the only place a query becomes a URL, so it is held to http(s) and nothing else. */
export function expandUrl(template, { query, limit }, { requireQuery = true } = {}) {
	if (typeof template !== 'string' || !/^https?:\/\/\S+$/i.test(template)) {
		throw new Error(`source url must be an http(s) template, got ${JSON.stringify(template ?? '')}`);
	}
	// A POST source puts the query in its body, so its URL is an endpoint and nothing more.
	if (requireQuery && !template.includes('{query}')) throw new Error('source url must contain {query}');
	return template.replaceAll('{query}', encodeURIComponent(query)).replaceAll('{limit}', String(limit));
}

/**
 * A POST source sends a JSON body, and its values are templated the same way the URL is. `"{limit}"`
 * becomes a number because an API that wants `max_results: 5` rejects `"5"`, and a config that has to
 * know that is a config with an undocumented rule.
 */
export function templateBody(body, { query, limit }) {
	if (typeof body === 'string') {
		if (body === '{limit}') return limit;
		return body.replaceAll('{query}', query).replaceAll('{limit}', String(limit));
	}
	if (Array.isArray(body)) return body.map((item) => templateBody(item, { query, limit }));
	if (body && typeof body === 'object') {
		return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, templateBody(value, { query, limit })]));
	}
	return body;
}

const pickPath = (object, path) => {
	if (!path) return undefined;
	let value = object;
	for (const part of String(path).split('.')) {
		if (value == null) return undefined;
		value = value[part];
	}
	return value;
};

/** First non-empty value among `a|b|c` — how a config says "this field, or that one". */
const pickField = (object, spec) => {
	for (const path of String(spec ?? '').split('|')) {
		const value = pickPath(object, path.trim());
		if (typeof value === 'string' && value.trim()) return value;
		if (typeof value === 'number') return String(value);
	}
	return '';
};

/**
 * A JSON source is a list somewhere in the payload plus three field paths (`items`, `title`, `link`,
 * `snippet`). Nothing more: an engine
 * with a query language of its own would be a second config format, and the point is that a source
 * can be added without learning one.
 */
export function parseJsonSource(payload, source, limit) {
	const items = pickPath(payload, source.items);
	if (!Array.isArray(items)) {
		throw new Error(`source "${source.id}": no array at "${source.items}"`);
	}
	// `url` on a source is the endpoint template; `link` is where a result's own URL lives. Two
	// different things, two different names — spelling both `url` is a config that silently points
	// the request at the wrong string.
	return items.slice(0, limit).map((item) => ({
		title: pickField(item, source.title),
		url: pickField(item, source.link ?? source.resultUrl),
		snippet: pickField(item, source.snippet),
		date: pickField(item, source.date) || null
	}));
}

const CDATA = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/;

function tagText(block, name) {
	const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
	if (!match) return '';
	const cdata = CDATA.exec(match[1]);
	const raw = cdata ? cdata[1] : match[1];
	// Decode, strip, decode again: a feed writes its HTML either raw or entity-encoded, and one
	// pass in the wrong order leaves `<p>` visible in the snippet the model reads.
	return decodeEntities(decodeEntities(raw).replace(/<[^>]{0,200}>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(text) {
	return String(text)
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&');
}

/**
 * RSS and Atom share one parser because a feed is a feed: `<item>` or `<entry>`, a title, a link
 * (text in RSS, `href=` in Atom), and a body under one of four names. arXiv's API is Atom, which
 * is how the declarative path gets exercised by a real source instead of only by a fixture.
 */
export function parseFeedSource(text, { limit } = {}) {
	const blocks = [...String(text).matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
	return blocks.slice(0, limit ?? blocks.length).map((block) => {
		const href = /<link\b[^>]*\bhref="([^"]+)"/i.exec(block)?.[1] ?? '';
		return {
			title: tagText(block, 'title'),
			url: tagText(block, 'link') || decodeEntities(href) || tagText(block, 'id'),
			snippet: tagText(block, 'description') || tagText(block, 'summary') || tagText(block, 'content'),
			date: tagText(block, 'pubDate') || tagText(block, 'published') || tagText(block, 'updated') || null
		};
	});
}

// ── running them ─────────────────────────────────────────────────────────────────────────────

/**
 * **A keyed source is still config, not code.** An entry names the environment variable and where the
 * key goes — Brave wants `X-Subscription-Token`, most others want `Authorization: Bearer` — and the
 * key itself never enters `sources.json`. The variable lives in the deployment's environment or its
 * `.env`, so a rotated key is a restart and never a commit.
 */
export function authHeaders(source, env = process.env) {
	if (!source.key) return {};
	const value = env[source.key];
	if (!value) return {};
	if (source.keyHeader) return { [source.keyHeader]: value };
	return { authorization: `Bearer ${value}` };
}

/** Is this source runnable at all? A keyed source with no key is *skipped*, and says why. */
export function resolveSources(config, env = process.env) {
	const available = [];
	const skipped = [];
	for (const source of config.sources) {
		if (source.key && !env[source.key]) {
			skipped.push({ id: source.id, why: `${source.key} is not set` });
			continue;
		}
		available.push(source);
	}
	return { available, skipped };
}

/**
 * The user agent: **who is asking, never which release.** Wikipedia's and Stack Exchange's API policies
 * ask a client to identify itself and give a way to reach whoever runs it, and a bare runtime agent gets
 * refused outright by some endpoints — so the name and the URL earn their place. The *version* does not:
 * it is one more thing to keep in step with `package.json`, its only use is telling a remote operator
 * which release sent bad traffic, and neither of those is worth a number that can silently go stale. It
 * said `0.3` for three releases, which is the argument against it.
 *
 * It is also the same shape the page reader sends (`vendor/fetch.ts`: `Mozilla/5.0 (compatible;
 * pi-multi-search)`), because two conventions for one package is a second thing to explain.
 */
export const USER_AGENT = 'pi-multi-search (+https://github.com/kschluter/pi-multi-search)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * **A 429 is a wait, not a failed source.** Brave's free plan allows one request per second, and two
 * searches in one turn — or the title-restricted attempt Hacker News makes first — arrive inside that
 * second and came back as `HTTP 429`, which the footer reported as a dead index. One bounded retry,
 * honouring `retry-after` up to three seconds, turns a rate limit back into an answer.
 */
async function getJson(url, signal, headers = {}, { method = 'GET', body } = {}) {
	const request = () =>
		fetch(url, {
			method,
			...(body === undefined
				? {}
				: { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
			headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
			signal
		});

	let res = await request();
	if (res.status === 429) {
		const wait = Math.min(Number(res.headers.get('retry-after')) * 1000 || 1200, 3000);
		await sleep(wait);
		if (signal?.aborted) throw new Error('aborted while waiting out a rate limit');
		res = await request();
	}
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

async function getText(url, signal) {
	const res = await fetch(url, {
		headers: { accept: 'application/atom+xml, application/rss+xml, text/xml', 'user-agent': USER_AGENT },
		signal
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.text();
}

/**
 * One source, one answer, one error string. The error is *content* — the footer names it — because
 * a source that failed and a source that found nothing are different facts, and a search that hides
 * the difference teaches the reader to trust a short list.
 */
export async function runSource(source, { query, limit, signal, env = process.env, fetchJson = getJson }) {
	// The source's own budget wins: `sources.json` says arXiv takes three and DuckDuckGo five, and a
	// caller's default must not quietly overrule the number written next to the source.
	const budget = source.limit ?? limit ?? 5;
	if (source.kind === 'rss' || source.kind === 'atom') {
		const text = await getText(expandUrl(source.url, { query, limit: budget }), signal);
		return parseFeedSource(text, { limit: budget });
	}
	if (source.kind === 'json') {
		const isPost = String(source.method ?? 'GET').toUpperCase() === 'POST';
		const url = expandUrl(source.url, { query, limit: budget }, { requireQuery: !isPost });
		const init =
			source.method === 'POST'
				? { method: 'POST', body: templateBody(source.body ?? { query: '{query}', max_results: '{limit}' }, { query, limit: budget }) }
				: {};
		// The key comes from the resolved environment — the process, then the key file (`keys.mjs`). Reading
		// `process.env` here instead is how a key that only exists in the file silently became a 401.
		const payload = await fetchJson(url, signal, authHeaders(source, env), init);
		return parseJsonSource(payload, source, budget);
	}
	const builtin = BUILTIN.get(source.id);
	if (!builtin) throw new Error(`unknown source "${source.id}"`);
	return builtin(query, { limit: budget, signal });
}

/**
 * Retry policy for a source that came back empty. The shaped query is the first attempt (`route.mjs`);
 * this is the last one — the topic's core words with the stopwords gone, because the measured failure
 * was a long conjunctive match (`nbHits: 0` for a nine-word query, 5 526 for its first three words)
 * and truncating by position is not the same as keeping the words that carry the topic.
 */
/** Every enabled source at once; one slow or broken source cannot fail the search. */
export async function runAll(sources, { query, limit = 5, timeoutMs = 2500, signal, env = process.env, fetchJson } = {}) {
	return Promise.all(
		sources.map(async (source) => {
			const started = Date.now();
			const timer = AbortSignal.timeout(timeoutMs);
			const combined = signal ? AbortSignal.any([signal, timer]) : timer;
			try {
				// The query a source receives is the *shaped* one: routing chose this source because of
				// the question's shape, and each index is asked in the form it matches best.
				const asked = source.query ?? query;
				let hits = await runSource(source, { query: asked, limit, signal: combined, env, fetchJson });
				const fallback = hits.length || source.retryOnEmpty === false ? null : core(query, 4);
				if (fallback && fallback !== asked) {
					const retry = await runSource(source, { query: fallback, limit, signal: combined, env, fetchJson });
					if (retry.length) hits = retry.map((hit) => ({ ...hit, narrowed: fallback }));
				}
				return { id: source.id, hits, asked, weight: source.weight ?? 1, ms: Date.now() - started };
			} catch (error) {
				const aborted = error?.name === 'TimeoutError' || error?.name === 'AbortError';
				const message = aborted ? `timeout after ${timeoutMs}ms` : String(error?.message ?? error);
				return { id: source.id, error: message.slice(0, 120), weight: source.weight ?? 1, ms: Date.now() - started };
			}
		})
	);
}

/**
 * `sources.json`, validated into the list `runAll` takes. An unknown id or a template that is not
 * http(s) is a **refusal at load**, not a source that silently returns nothing: a misconfigured
 * source that fails quietly is worse than one that will not start, because the reader never learns
 * the index they think they are searching was never asked.
 */
export function parseSourcesConfig(config) {
	const defaults = { limit: 5, timeoutMs: 2500, ...(config?.defaults ?? {}) };
	const entries = [];
	// **What is switched off, and which key it wants.** A source the profile disables is dropped, and a
	// key left in `.env` for it would then be accepted and ignored — the class of defect this repo keeps
	// finding. The caller says so in the footer instead of staying quiet.
	const disabled = [];
	for (const [id, raw] of Object.entries(config?.sources ?? {})) {
		const source = { id, limit: defaults.limit, ...raw };
		if (source.enabled === false) {
			disabled.push({ id, key: typeof source.key === 'string' ? source.key : null });
			continue;
		}
		if (!source.kind) {
			if (!BUILTIN.has(id)) throw new Error(`source "${id}": no built-in by that name, and no kind`);
			source.kind = 'builtin';
		}
		if (source.kind === 'json' || source.kind === 'rss' || source.kind === 'atom') {
			if (source.kind === 'json' && !source.items) {
				throw new Error(`source "${id}": kind "json" needs items`);
			}
			if (source.method && !['GET', 'POST'].includes(String(source.method).toUpperCase())) {
				throw new Error(`source "${id}": method must be GET or POST`);
			}
			if (source.body && String(source.method ?? 'GET').toUpperCase() !== 'POST') {
				throw new Error(`source "${id}": a body needs method "POST"`);
			}
			if (source.key && !/^[A-Z][A-Z0-9_]*$/.test(source.key)) {
				throw new Error(`source "${id}": key must name an environment variable, got "${source.key}"`);
			}
			// Validated now, not at query time: a template that is not http(s) must not wait for a
			// wake to discover it.
			const isPost = String(source.method ?? 'GET').toUpperCase() === 'POST';
			expandUrl(source.url, { query: 'x', limit: 1 }, { requireQuery: !isPost });
			if (isPost && !JSON.stringify(source.body ?? {}).includes('{query}')) {
				throw new Error(`source "${id}": a POST source needs {query} in its url or its body`);
			}
		} else if (!BUILTIN.has(id)) {
			throw new Error(`source "${id}": unknown kind "${source.kind}"`);
		}
		entries.push(source);
	}
	return { defaults, sources: entries, disabled };
}

export function loadSourcesConfig(file) {
	return parseSourcesConfig(JSON.parse(readFileSync(file, 'utf8')));
}

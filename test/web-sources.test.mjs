/**
 * **Sources are data wherever they can be** — so the parsers, the template rule and the config
 * validation are all testable from fixtures. Nothing here opens a socket.
 *
 * The declarative path is the one that matters politically: it is what makes "add a source" a
 * config edit rather than a code change. Its tests therefore use the two shapes a real endpoint
 * returns (JSON with a list in it, and a feed) rather than a convenient invention.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
	authHeaders,
	expandUrl,
	loadSourcesConfig,
	parseFeedSource,
	parseJsonSource,
	parseSourcesConfig,
	resolveSources,
	templateBody,
	USER_AGENT,
	runAll
} from '../src/sources.mjs';
import { createRequire } from 'node:module';

test('a template is the one place a query becomes a URL, and only http(s) gets that far', () => {
	assert.equal(
		expandUrl('https://api.example.com/s?q={query}&n={limit}', { query: 'a b&c', limit: 3 }),
		'https://api.example.com/s?q=a%20b%26c&n=3'
	);
	assert.throws(() => expandUrl('file:///etc/passwd?q={query}', { query: 'x', limit: 1 }), /http\(s\)/);
	assert.throws(() => expandUrl('https://api.example.com/s?n={limit}', { query: 'x', limit: 1 }), /\{query\}/);
	assert.throws(() => expandUrl(undefined, { query: 'x', limit: 1 }), /http\(s\)/);
});

test('a JSON source is a list plus three paths, and a pipe means "this, else that"', () => {
	const payload = {
		hits: [
			{ title: 'First', url: 'https://example.com/a', story_text: 'the story', created_at: '2024-03-07T00:00:00Z' },
			{ title: 'Second', url: 'https://example.com/b', comment_text: '', points: 12 },
			{ title: 'No URL at all', snippet: 'dropped later' }
		]
	};
	const source = {
		id: 'custom',
		kind: 'json',
		url: 'https://api.example.com/s?q={query}',
		items: 'hits',
		title: 'title',
		link: 'url',
		snippet: 'story_text|comment_text|points',
		date: 'created_at'
	};

	const rows = parseJsonSource(payload, source, 5);
	assert.equal(rows.length, 3, 'the parser does not judge a row; the merge drops the one with no URL');
	assert.equal(rows[0].snippet, 'the story');
	assert.equal(rows[1].snippet, '12', 'a number becomes text rather than vanishing');
	assert.equal(rows[0].date, '2024-03-07T00:00:00Z');

	assert.throws(
		() => parseJsonSource({ other: [] }, source, 5),
		/source "custom": no array at "hits"/,
		'a payload that is not the shape the config promised is named, not silently empty'
	);
});

test('a feed is a feed: RSS and Atom share one parser', () => {
	const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
		<title>arXiv Query</title>
		<entry>
			<title>Automatic Prompt Injection</title>
			<id>http://arxiv.org/abs/2403.04957v1</id>
			<link href="https://arxiv.org/abs/2403.04957v1" rel="alternate"/>
			<summary>Large Language Models excel at following instructions.</summary>
			<updated>2024-03-07T00:00:00Z</updated>
		</entry>
		<entry><title>No link here</title><summary>nothing</summary></entry>
	</feed>`;
	const rss = `<rss><channel>
		<item><title><![CDATA[A &amp; B]]></title><link>https://example.com/a</link>
			<description>&lt;p&gt;html body&lt;/p&gt;</description><pubDate>Wed, 06 Mar 2024 10:00:00 GMT</pubDate></item>
	</channel></rss>`;

	const papers = parseFeedSource(atom, { limit: 5 });
	assert.equal(papers.length, 2);
	assert.equal(papers[0].title, 'Automatic Prompt Injection', 'the feed title is not an entry');
	assert.equal(papers[0].url, 'https://arxiv.org/abs/2403.04957v1');
	assert.match(papers[0].snippet, /following instructions/);
	assert.equal(papers[0].date, '2024-03-07T00:00:00Z');

	const items = parseFeedSource(rss, { limit: 1 });
	assert.equal(items.length, 1, 'the limit is honoured');
	assert.equal(items[0].title, 'A & B', 'CDATA and entities are decoded once, not twice');
	assert.equal(items[0].url, 'https://example.com/a');
	assert.equal(items[0].snippet, 'html body', 'tags are stripped from a body');
});

test('a misconfigured source refuses to load, by name, instead of returning nothing forever', () => {
	const ok = parseSourcesConfig({
		defaults: { limit: 4, timeoutMs: 1000 },
		sources: {
			wikipedia: { enabled: true },
			arxiv: { kind: 'atom', url: 'https://export.arxiv.org/api/query?search_query=all:{query}' },
			off: { enabled: false, kind: 'json', url: 'https://example.com' },
			mine: { kind: 'json', url: 'https://api.example.com?q={query}', items: 'data.rows', title: 'name', link: 'href' }
		}
	});
	assert.deepEqual(ok.sources.map((source) => source.id), ['wikipedia', 'arxiv', 'mine']);
	assert.equal(ok.sources[0].kind, 'builtin', 'a built-in with no kind is still a built-in');
	assert.equal(ok.sources[0].limit, 4, 'the default limit reaches every source');

	assert.throws(
		() => parseSourcesConfig({ sources: { mystery: { enabled: true } } }),
		/source "mystery": no built-in/
	);
	assert.throws(
		() => parseSourcesConfig({ sources: { mine: { kind: 'json', url: 'https://e.com?q={query}' } } }),
		/needs items/
	);
	assert.throws(
		() => parseSourcesConfig({ sources: { mine: { kind: 'json', url: 'ftp://e.com?q={query}', items: 'x' } } }),
		/http\(s\)/
	);
	assert.throws(
		() => parseSourcesConfig({ sources: { mine: { kind: 'telepathy', url: 'https://e.com?q={query}' } } }),
		/unknown kind/
	);
});

test('the shipped profile is valid, and switches on exactly one free index', () => {
	// **One enabled source, and it is the keyless one.** A package someone just installed must answer
	// without an account, a key or a config file — so `duckduckgo` is on and everything else is here,
	// defined and tested, switched off with a `$why` that says what turning it on buys.
	const config = loadSourcesConfig(new URL('../profiles/default.json', import.meta.url));
	assert.deepEqual(config.sources.map((source) => source.id), ['duckduckgo']);
	assert.equal(config.sources[0].key, undefined, 'and it needs no key to work');
	assert.ok(config.sources.every((source) => /^https?:\/\//.test(source.url ?? 'https://builtin')));

	// Every other entry is still a valid definition — off, not absent — and a keyed one says which
	// variable it would want, which is what makes "a key you set for a source that is off" reportable.
	const file = JSON.parse(readFileSync(new URL('../profiles/default.json', import.meta.url), 'utf8'));
	const off = Object.entries(file.sources).filter(([, entry]) => entry.enabled === false);
	assert.ok(off.length >= 6, 'the disabled entries are the catalog, not leftovers');
	for (const [id, entry] of off) assert.equal(typeof entry.$why, 'string', `${id} says why it is off`);
	assert.deepEqual(
		config.disabled.filter((entry) => entry.key).map((entry) => entry.id).sort(),
		['brave', 'tavily'],
		'the keyed entries name their variable even while switched off'
	);
});

test('a keyed source names the variable and where the key goes — never the key', () => {
	const brave = { id: 'brave', key: 'BRAVE_API_KEY', keyHeader: 'X-Subscription-Token' };
	assert.deepEqual(authHeaders(brave, { BRAVE_API_KEY: 'k' }), { 'X-Subscription-Token': 'k' });
	// The default is the form most APIs take.
	assert.deepEqual(authHeaders({ id: 'x', key: 'X_KEY' }, { X_KEY: 'k' }), { authorization: 'Bearer k' });
	assert.deepEqual(authHeaders(brave, {}), {}, 'no key, no header — never an empty one');
	assert.deepEqual(authHeaders({ id: 'ddg' }, {}), {}, 'a keyless source sends nothing extra');
});

test('a POST source sends a JSON body, and "{limit}" is a number because the API will not take a string', () => {
	assert.deepEqual(
		templateBody(
			{ query: '{query}', max_results: '{limit}', search_depth: 'basic', include: ['{query}'], nested: { n: '{limit}' } },
			{ query: 'a b', limit: 5 }
		),
		{ query: 'a b', max_results: 5, search_depth: 'basic', include: ['a b'], nested: { n: 5 } }
	);
	// A GET source cannot have one, and an unknown method is a typo.
	assert.throws(
		() => parseSourcesConfig({ sources: { mine: { kind: 'json', url: 'https://e.com?q={query}', items: 'x', body: {} } } }),
		/a body needs method "POST"/
	);
	assert.throws(
		() => parseSourcesConfig({ sources: { mine: { kind: 'json', url: 'https://e.com?q={query}', items: 'x', method: 'PUT' } } }),
		/method must be GET or POST/
	);
	const post = parseSourcesConfig({
		sources: {
			tavily: {
				kind: 'json', method: 'POST', url: 'https://api.tavily.com/search',
				body: { query: '{query}', max_results: '{limit}' }, items: 'results', link: 'url', key: 'TAVILY_API_KEY'
			}
		}
	});
	assert.equal(post.sources[0].method, 'POST');
});

test('a keyless-by-missing-key source is skipped and says which variable is missing', () => {
	const config = parseSourcesConfig({
		sources: {
			duckduckgo: { enabled: true },
			brave: { kind: 'json', url: 'https://api.search.brave.com/res/v1/web/search?q={query}', items: 'web.results', link: 'url', key: 'BRAVE_API_KEY' }
		}
	});
	const without = resolveSources(config, {});
	assert.deepEqual(without.available.map((source) => source.id), ['duckduckgo']);
	assert.deepEqual(without.skipped, [{ id: 'brave', why: 'BRAVE_API_KEY is not set' }]);

	const withKey = resolveSources(config, { BRAVE_API_KEY: 'k' });
	assert.deepEqual(withKey.available.map((source) => source.id), ['duckduckgo', 'brave']);
	assert.deepEqual(withKey.skipped, []);
});

test('a key that is not an environment-variable name is a typo, not a source', () => {
	assert.throws(
		() => parseSourcesConfig({
			// Deliberately not key-shaped and not a secret: the point is that a literal pasted where a
			// variable NAME belongs is refused, so this must not look like a credential either.
			sources: { mine: { kind: 'json', url: 'https://e.com?q={query}', items: 'x', key: 'pasted-here-by-mistake' } }
		}),
		/key must name an environment variable/
	);
});

test('a POST source may keep the query out of its URL, but not out of both', () => {
	assert.throws(
		() => parseSourcesConfig({
			sources: { mine: { kind: 'json', method: 'POST', url: 'https://api.example.com/search', body: { limit: '{limit}' }, items: 'x' } }
		}),
		/needs \{query\} in its url or its body/
	);
});

test('a key from the resolved environment reaches the request, not from process.env', async () => {
	// The bug this holds: `authHeaders(source)` defaulted to `process.env`, so a key that existed only in
	// `~/.pi/agent/pi-multi-search.env` produced an unauthenticated request — a 401 that looked like a bad key.
	let seen = null;
	const { runSource } = await import('../src/sources.mjs');
	await runSource(
		{ id: 'mine', kind: 'json', url: 'https://api.example.com?q={query}', items: 'results', key: 'MINE_KEY' },
		{
			query: 'x',
			env: { MINE_KEY: 'from-file' },
			fetchJson: async (_url, _signal, headers) => {
				seen = headers;
				return { results: [] };
			}
		}
	);
	assert.equal(seen.authorization, 'Bearer from-file');
});

test('the user agent names the package and never the release', () => {
	// The name and URL are asked for by the API policies of the indexes this package talks to; a version
	// number is not, and the one that used to be here (`0.3`) went stale for three releases without
	// anything noticing. This test exists so it cannot come back by accident.
	assert.match(USER_AGENT, /^pi-multi-search \(\+https:\/\/github\.com\/kschluter\/pi-multi-search\)$/);
	assert.doesNotMatch(USER_AGENT, /\d+\.\d+/, 'a version in the user agent is a second thing to keep in sync');
});

test('a challenged DuckDuckGo is a failure, never an empty web', async () => {
	// Measured 2026-11-15: DuckDuckGo answers HTTP 202 with an anomaly page to a client it has seen too
	// much of, and 202 passes `res.ok`. The parser found no anchors, so the merge counted an empty result
	// and the footer said "nothing found: duckduckgo" — on the only source the shipped default enables.
	// The distinction matters to a model reading the footer: "nobody has this" and "we were refused" are
	// different answers, and only one of them is worth retrying.
	const challenge = '<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.'
		+ ' Please complete the following challenge to confirm this search was made by a human.</div></body></html>';
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(challenge, { status: 202, headers: { 'content-type': 'text/html' } });
	try {
		const [result] = await runAll(
			[{ id: 'duckduckgo', kind: 'builtin', weight: 0.7 }],
			{ query: 'anything at all', limit: 3, timeoutMs: 2000 }
		);
		assert.match(String(result.error), /bot challenge/i, 'a refused search must not read as an empty one');
		assert.equal(result.hits, undefined, 'and it must not carry an empty result set');
	} finally {
		globalThis.fetch = realFetch;
	}
});

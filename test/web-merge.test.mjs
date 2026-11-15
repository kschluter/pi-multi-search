/**
 * **The merge is the product**, so it is tested without a single byte of network.
 *
 * A fan-out is easy to get wrong in ways that look fine: two indexes agree and the row still shows
 * twice; the loudest source fills the list; a hit with no URL ends up in the answer; a source that
 * timed out is invisible in the footer. Each of those has a test here, on data that fits in this
 * file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalUrl, clean, fuse, isAdUrl, normaliseHits, render, SNIPPET_CHARS } from '../src/merge.mjs';

const hit = (url, extra = {}) => ({ url, title: url, snippet: '', ...extra });

test('a URL is compared by identity, not by how it was written', () => {
	assert.equal(canonicalUrl('https://www.example.com/post/'), 'https://example.com/post');
	assert.equal(canonicalUrl('https://example.com/post?utm_source=x&utm_medium=y'), 'https://example.com/post');
	assert.equal(canonicalUrl('https://example.com/post#section'), 'https://example.com/post');
	assert.equal(canonicalUrl('HTTPS://Example.COM/Post'), 'https://example.com/Post');
	// A root path keeps its slash: `https://host?q=1` resolves, and reads like a broken URL.
	assert.equal(canonicalUrl('https://example.com'), 'https://example.com/');
	assert.equal(canonicalUrl('https://example.com/?curid=7'), 'https://example.com/?curid=7');
	// Identity is the query that is not tracking — and the surviving parameters keep their order,
	// so the same URL always canonicalises to the same string.
	assert.equal(canonicalUrl('https://example.com/s?q=cats&page=2'), 'https://example.com/s?q=cats&page=2');
	// Refused, because an un-fetchable result is not a result.
	assert.equal(canonicalUrl('javascript:alert(1)'), null);
	assert.equal(canonicalUrl('ftp://example.com/x'), null);
	assert.equal(canonicalUrl('not a url'), null);
	assert.equal(canonicalUrl(undefined), null);
});

test('a snippet is one line, bounded, and the ellipsis does not eat a character', () => {
	assert.equal(clean('  a \n\n  b  '), 'a b'); // sanitised text arrives with newlines; the list needs one line
	assert.equal(clean('', 10), '');
	assert.equal(clean(undefined), '');
	const long = clean('x'.repeat(500));
	assert.equal(long.length, SNIPPET_CHARS);
	assert.ok(long.endsWith('…'));
});

test('one source\u2019s order is what RRF scores, and only usable rows survive', () => {
	const rows = normaliseHits('wikipedia', [
		{ title: 'A', url: 'https://example.com/a', snippet: '' },
		{ title: 'skip me', url: 'javascript:void(0)' },
		{ title: 'B', url: 'https://example.com/b?utm_source=x', snippet: 'body' }
	], 10);
	assert.deepEqual(rows.map((row) => row.url), ['https://example.com/a', 'https://example.com/b']);
	assert.equal(rows[0].sources[0], 'wikipedia');
	assert.equal(rows[1].snippet, 'body');
	// The cap is a cap, not a suggestion.
	assert.equal(normaliseHits('w', [hit('https://e.com/1'), hit('https://e.com/2')], 1).length, 1);
});

test('a date is a date, and prose about an age is not one', () => {
	// Brave returns both: `page_age` is ISO, `age` is "July 14, 2026" — which used to print as
	// "(July 14, 2" beside a result.
	const rows = normaliseHits('brave', [
		{ title: 'ISO', url: 'https://e.com/1', date: '2026-07-14T00:00:00Z' },
		{ title: 'Prose', url: 'https://e.com/2', date: 'July 14, 2026' },
		{ title: 'Relative', url: 'https://e.com/3', date: '3 days ago' },
		{ title: 'None', url: 'https://e.com/4' }
	], 10);
	assert.deepEqual(rows.map((row) => row.date), ['2026-07-14', null, null, null]);
	const text = render(fuse([{ id: 'brave', hits: rows }], { limit: 4 }), { query: 'x', limit: 4 });
	assert.match(text, /\(2026-07-14\)/);
	assert.doesNotMatch(text, /July 14/);
});

test('a paid placement is not a result, and a tracker URL is not a page', () => {
	// Measured on a real query: DuckDuckGo's sponsored block uses the same anchors as organic rows.
	assert.ok(isAdUrl('https://duckduckgo.com/y.js?ad_domain=puppyspot.com&ad_provider=bingv7aa'));
	assert.ok(isAdUrl('https://www.bing.com/aclick?ld=abc'));
	assert.ok(isAdUrl('https://doubleclick.net/x'));
	assert.ok(!isAdUrl('https://duckduckgo.com/about'), 'the engine is only blocked at its ad endpoint');
	assert.ok(!isAdUrl('https://arxiv.org/abs/2503.05216v1'));

	const rows = normaliseHits('duckduckgo', [
		{ title: 'Sponsored', url: 'https://duckduckgo.com/y.js?ad_domain=example.com' },
		{ title: 'A very long tracker', url: `https://example.com/x?${'a'.repeat(400)}` },
		{ title: 'Puppy (computing)', url: 'https://en.wikipedia.org/wiki/Puppy' }
	], 10);
	assert.deepEqual(rows.map((row) => row.title), ['Puppy (computing)']);
});

test('agreement beats enthusiasm, and the richer copy of a row wins its fields', () => {
	const fused = fuse([
		{ id: 'duckduckgo', hits: normaliseHits('duckduckgo', [
			hit('https://example.com/loud', { title: 'Loud', snippet: 'short' }),
			hit('https://example.com/shared', { title: 'Shared (ddg)', snippet: 'a terse line' })
		], 5) },
		{ id: 'wikipedia', hits: normaliseHits('wikipedia', [
			hit('https://example.com/shared', { title: 'Shared', snippet: 'the longer, better sentence' })
		], 5) }
	], { limit: 5 });

	assert.equal(fused.results[0].url, 'https://example.com/shared', 'the corroborated row ranks first');
	assert.deepEqual(fused.results[0].sources.sort(), ['duckduckgo', 'wikipedia']);
	assert.equal(fused.results[0].snippet, 'the longer, better sentence');
	assert.equal(fused.results.length, 2, 'one row per URL, not one per source');
	assert.equal(fused.total, 2);
});

test('no single source fills the list, and a short list is not the only alternative', () => {
	const ten = (prefix) => Array.from({ length: 10 }, (_, i) => hit(`https://example.com/${prefix}${i}`));
	const fused = fuse([
		{ id: 'duckduckgo', hits: normaliseHits('duckduckgo', ten('d'), 10) },
		{ id: 'arxiv', hits: normaliseHits('arxiv', ten('a'), 10) }
	], { limit: 4 });

	assert.equal(fused.results.length, 4);
	const perSource = new Map();
	for (const row of fused.results) perSource.set(row.sources[0], (perSource.get(row.sources[0]) ?? 0) + 1);
	assert.deepEqual([...perSource.values()], [2, 2], 'two sources, a budget of four: two each, not four-and-none');

	// A quiet source is still represented when the loud one has ten results above it.
	const loudAndQuiet = fuse([
		{ id: 'duckduckgo', hits: normaliseHits('duckduckgo', ten('d'), 10) },
		{ id: 'arxiv', hits: normaliseHits('arxiv', [hit('https://example.com/paper')], 10) }
	], { limit: 5 });
	assert.ok(
		loudAndQuiet.results.some((row) => row.sources[0] === 'arxiv'),
		'the quota is what stops "ten DuckDuckGo results" being the whole answer'
	);

	// Two sources of one result each, budget of five: the cap lifts rather than returning a thin lie.
	const thin = fuse([
		{ id: 'a', hits: normaliseHits('a', [hit('https://e.com/1'), hit('https://e.com/2')], 5) },
		{ id: 'b', hits: normaliseHits('b', [hit('https://e.com/3')], 5) }
	], { limit: 5 });
	assert.equal(thin.results.length, 3);
});

test('a third source is not starved by the quota, because a routed search has three', () => {
	// The shape a routed search actually has: two `web` engines (brave, tavily) plus the one role the
	// question earned (here `code` → stackexchange). Measured on a real search: with a budget of six
	// and a quota of three each, brave and tavily filled the list and **Stack Exchange contributed
	// nothing** — the index the routing chose for the question was the one the merge discarded.
	const many = (id, count) => normaliseHits(id, Array.from({ length: count }, (_, i) => hit(`https://${id}.example/${i + 1}`)), 10);
	for (const limit of [5, 6, 8]) {
		const fused = fuse([
			{ id: 'brave', weight: 1.0, hits: many('brave', 5) },
			{ id: 'tavily', weight: 0.9, hits: many('tavily', 5) },
			{ id: 'stackexchange', weight: 0.8, hits: many('stackexchange', 3) }
		], { limit });
		assert.equal(fused.results.length, limit);
		assert.ok(
			fused.results.some((row) => row.sources[0] === 'stackexchange'),
			`the third source appears at limit ${limit}`
		);
		// The list is still a ranking: one slot per source must not scramble the order it is read in.
		const scores = fused.results.map((row) => row.score);
		assert.deepEqual(scores, [...scores].sort((a, b) => b - a), `order stays score-descending at limit ${limit}`);
	}
});

test('a source cannot corroborate itself by listing one page three times', () => {
	// Measured on Hacker News: one PDF at ranks 3, 4 and 5 summed to the top of the merge.
	const hits = normaliseHits('hackernews', [
		{ title: 'first', url: 'https://example.com/a' },
		{ title: 'same page', url: 'https://www.example.com/a/' },
		{ title: 'same page again', url: 'https://example.com/a#frag' }
	], 10);
	assert.equal(hits.length, 1);
	assert.equal(hits[0].title, 'first', 'the first occurrence is the one the source ranked best');

	const fused = fuse([{ id: 'hackernews', weight: 0.5, hits }], { limit: 5 });
	assert.equal(fused.results[0].score, 0.5 / 61);
});

test('a source whose ranking means more outranks one whose ranking means less', () => {
	const groups = [
		{ id: 'hackernews', weight: 0.5, hits: normaliseHits('hackernews', [hit('https://example.com/noise')], 5) },
		{ id: 'brave', weight: 1, hits: normaliseHits('brave', [hit('https://example.com/answer')], 5) }
	];
	const fused = fuse(groups, { limit: 5 });
	assert.equal(fused.results[0].url, 'https://example.com/answer', 'a #1 from a trusted index beats a #1 from a loose one');
	assert.equal(fused.results.length, 2);
});

test('a failed source is content, and the footer says which', () => {
	const fused = fuse([
		{ id: 'duckduckgo', hits: normaliseHits('duckduckgo', [hit('https://example.com/a')], 5) },
		{ id: 'stackexchange', error: 'timeout after 2500ms' },
		{ id: 'arxiv', hits: [] }
	], { limit: 5 });

	assert.deepEqual(fused.answered, ['duckduckgo']);
	assert.deepEqual(fused.empty, ['arxiv']);
	assert.deepEqual(fused.failed, [{ id: 'stackexchange', error: 'timeout after 2500ms' }]);

	const text = render(fused, { query: 'anything', limit: 5 });
	assert.match(text, /\[duckduckgo\]/, 'every hit names the index that returned it');
	assert.match(text, /answered: duckduckgo/);
	assert.match(text, /nothing found: arxiv/);
	assert.match(text, /failed: stackexchange \(timeout after 2500ms\)/);
});

test('a source that was not asked at all is named, so the reader knows the list is partial', () => {
	const fused = fuse([{ id: 'duckduckgo', hits: normaliseHits('duckduckgo', [hit('https://example.com/a')], 5) }], { limit: 5 });
	const text = render(fused, { query: 'x', limit: 5, skipped: [{ id: 'brave', why: 'BRAVE_API_KEY is not set' }] });
	assert.match(text, /not asked: brave \(BRAVE_API_KEY is not set\)/);
});

test('a shaped query that already carries quotes is shown once, not re-quoted', () => {
	// Measured in a real search: `asked: arxiv "all:"bicycle repair stand""` — a malformed-looking
	// command in the one place a reader goes to ask why an index returned what it returned.
	const fused = fuse([{ id: 'arxiv', hits: normaliseHits('arxiv', [hit('https://example.com/a')], 5) }], { limit: 5 });
	const text = render(fused, {
		query: 'best bicycle repair stand',
		limit: 5,
		plan: [{ id: 'arxiv', query: 'all:"bicycle repair stand"' }, { id: 'wikipedia', query: 'bicycle repair stand' }]
	});
	assert.match(text, /asked: arxiv all:"bicycle repair stand" · wikipedia "bicycle repair stand"/);
	assert.doesNotMatch(text, /""/, 'no doubled quotes');
});

test('an empty search says so once, without pretending a source answered', () => {
	const text = render(fuse([{ id: 'a', error: 'HTTP 502' }], { limit: 5 }), { query: 'nothing at all', limit: 5 });
	assert.match(text, /No results for/);
	assert.match(text, /failed: a \(HTTP 502\)/);
	assert.doesNotMatch(text, /answered:/);
});

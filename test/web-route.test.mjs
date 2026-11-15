/**
 * **Which indexes, and in what words.** Routing and query shaping are decisions, so they are tested as
 * decisions — no network, no clock, no model.
 *
 * The two failures this file exists to prevent, both measured on real searches before it existed:
 * asking all five indexes every time (arXiv on a segfault, Stack Exchange on "state of the art"), and
 * asking every index the question verbatim (Algolia returned `nbHits: 0` for a nine-word query and
 * 5 526 for its first three words).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseRoles, classify, core, planSearch, shapeFor, terms } from '../src/route.mjs';

const SOURCES = [
	{ id: 'duckduckgo', role: 'web' },
	{ id: 'wikipedia', role: 'reference' },
	{ id: 'hackernews', role: 'discussion' },
	{ id: 'stackexchange', role: 'code' },
	{ id: 'arxiv', role: 'papers' }
];

test('a question is read for what it is', () => {
	assert.equal(classify('TypeError: cannot read properties of undefined npm install').code, true);
	assert.equal(classify('what is a transformer model').definition, true);
	// The other half of the same question, and it used to fall through to `['web']`: "what does X mean"
	// is a definition, so the `reference` index has to be asked for it (found 2026-11-15).
	assert.equal(classify('what does a race condition mean').definition, true);
	assert.deepEqual(chooseRoles('what does a race condition mean'), ['reference', 'web']);
	assert.equal(classify('what does a monad mean').definition, true);
	// And a `what does ... do` question is not a definition — it is about behaviour, so no encyclopedia.
	assert.equal(classify('what does systemctl daemon-reload do').definition, false);
	assert.equal(classify('state of the art prompt injection defences, paper').paper, true);
	assert.equal(classify('Qwen3 4B vs Gemma 3 4B pricing').comparison, true);
	assert.equal(classify('latest llama release news').recency, true);
	assert.equal(classify('small language models').code, false);
	assert.equal(classify('small language models').paper, false);
});

test('roles are chosen from the shape of the question, never all of them', () => {
	assert.deepEqual(chooseRoles('segfault when I run cargo build'), ['code', 'web']);
	assert.deepEqual(chooseRoles('survey of prompt injection defences'), ['papers', 'web']);
	assert.deepEqual(chooseRoles('what is a content delivery network'), ['reference', 'web']);
	assert.deepEqual(chooseRoles('Qwen3 vs Gemma 3 for local use'), ['web', 'discussion']);
	assert.deepEqual(chooseRoles('latest llama release'), ['web', 'discussion', 'reference']);
	const generic = chooseRoles('content operations');
	assert.deepEqual(generic, ['web'], 'a question with no signal asks the general indexes and nothing else');
	// **A question with no signal must not buy an arXiv or a MediaWiki query.** Both were measured as
	// noise on a real shopping search: condensed-matter papers and an encyclopedia page about a film,
	// taking slots from the results the question was about.
	assert.ok(!generic.includes('papers'), 'an unclassifiable question does not ask arXiv');
	assert.ok(!generic.includes('reference'), 'and it does not ask an encyclopedia either');
	assert.ok(!chooseRoles('used bicycles for sale').includes('papers'), 'a shop is not a paper signal');
	assert.ok(!chooseRoles('used bicycles for sale').includes('reference'), 'a shop does not want an encyclopedia');
	assert.ok(!chooseRoles('cheap flights to Lisbon in March').includes('papers'));
});

test('every index is asked in the form it matches, not the question verbatim', () => {
	const query = 'best small language models 2026 under 10B parameters';

	// The web engine gets the question as written — it is the one that wants prose.
	assert.equal(shapeFor({ role: 'web' }, query), query);
	// Algolia is conjunctive: three topical words, no "best", no year.
	assert.equal(shapeFor({ role: 'discussion' }, query), 'small language models');
	// arXiv treats bare words as an AND over field soup; its own UI sends a quoted phrase in `all:`.
	assert.equal(shapeFor({ role: 'papers' }, query), 'all:"small language models"');
	// MediaWiki is phrase-ish and a year is noise.
	assert.equal(shapeFor({ role: 'reference' }, 'what is the 2026 state of vector databases'), 'state vector databases');
	assert.equal(
		shapeFor({ role: 'reference' }, 'best content operations tools 2026'),
		'content operations',
		'three words: six let a generic word in and MediaWiki answered "Tool steel"'
	);
	// Stack Exchange matches the symbol; the sentence around it is what buries it.
	assert.equal(
		shapeFor({ role: 'code' }, 'TypeError: x.map is not a function'),
		'TypeError: x.map is not a function',
		'the symbol is the search — Stack Exchange tolerates the sentence, and cutting it loses the error'
	);
	// A source may opt out of shaping entirely.
	assert.equal(shapeFor({ role: 'web', shape: 'none' }, '  a   b  '), 'a b');
});

test('keywords drop the words that carry no matching weight, and stop at the topic', () => {
	assert.deepEqual(terms('What is the best small language model?'), ['small', 'language', 'model']);
	assert.deepEqual(terms('llama llama LLAMA'), ['llama'], 'case is identity, not a second term');
	assert.equal(core('best small language models 2026 under 10B parameters'), 'small language models 2026');
	assert.equal(
		core('best content operations tools 2026'),
		'content operations 2026',
		'a generic noun is intent, not subject — the web engine still gets the whole question'
	);
	assert.equal(core(''), '');
});

test('a plan names what it will ask and what it will ask it', () => {
	const code = planSearch('node error: EADDRINUSE on port 5178', SOURCES);
	assert.deepEqual(code.plan.map((entry) => entry.id), ['stackexchange', 'duckduckgo']);
	assert.ok(!code.plan.some((entry) => entry.id === 'arxiv'), 'a runtime error is not a paper question');
	assert.match(code.plan[0].query, /^node error: EADDRINUSE/);
	assert.match(code.plan[0].why, /role "code"/);

	const paper = planSearch('survey of prompt injection defences', SOURCES);
	assert.deepEqual(paper.plan.map((entry) => entry.id), ['arxiv', 'duckduckgo']);
	assert.equal(paper.plan[0].query, 'all:"prompt injection defences"');

	// An explicit request is honoured to the word, and still shaped for the index it names.
	const explicit = planSearch('prompt injection', SOURCES, { only: ['arxiv', 'wikipedia'] });
	assert.deepEqual(explicit.plan.map((entry) => entry.id), ['arxiv', 'wikipedia']);
	assert.deepEqual(explicit.roles, ['explicit']);
	assert.equal(explicit.plan[0].why, 'asked for by name');
	assert.equal(explicit.plan[0].query, 'all:"prompt injection"');
	assert.equal(explicit.plan[1].query, 'prompt injection');
});

test('one index per role, by priority — and the fallback is the one that is left', () => {
	const sources = [
		{ id: 'duckduckgo', role: 'web', priority: 50 },
		{ id: 'brave', role: 'web', priority: 10 },
		{ id: 'wikipedia', role: 'reference' }
	];
	// A definition question wants `reference` before `web`, so that is the order the plan lists them in;
	// within the web role, `priority` decides who is asked at all.
	const preferred = planSearch('what is a content delivery network', sources);
	assert.deepEqual(preferred.plan.map((entry) => entry.id), ['wikipedia', 'brave'], 'the keyed index wins the web role');
	assert.equal(preferred.plan.find((entry) => entry.role === 'web').id, 'brave');

	// Its key is missing → `resolveSources` dropped it, and the free index answers instead.
	const fallback = planSearch('what is a content delivery network', sources.filter((source) => source.id !== 'brave'));
	assert.deepEqual(fallback.plan.map((entry) => entry.id), ['wikipedia', 'duckduckgo']);

	// Opting into two indexes of one role is a config decision, and then both are asked.
	const both = planSearch('what is a content delivery network', sources, { perRole: 2 });
	assert.deepEqual(both.plan.filter((entry) => entry.role === 'web').map((entry) => entry.id), ['brave', 'duckduckgo']);
});

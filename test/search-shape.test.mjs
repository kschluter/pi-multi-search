/**
 * **The seam.** Routing and merging are each tested thoroughly — and both of the defects a real
 * search found lived *between* them, because nothing ever composed the two:
 *
 * - routing was tested with `chooseRoles('content operations')` asserting three roles, which
 *   *enshrined* the fallback (`web`, `reference`, `papers`) rather than questioning it. A green test
 *   that agrees with the bug is worse than no test: it is a written claim that the behaviour is
 *   intended;
 * - merging was tested with one and two answering sources in every fixture. The three-source case
 *   appeared once, as "one answered, one errored, one found nothing" — never three lists of hits. So
 *   the quota was proved on a two-source machine while `perRole: 2` plus one routed role always
 *   produces three, and in that shape the third source was silently dropped.
 *
 * So this file asks the questions the halves cannot: **given the shapes real questions have, what does
 * a routed search plan, and does every index it planned reach the answer?** No network, no profile
 * files, no keys — the shipped source table and synthetic hits are enough, which is also why it runs
 * in a millisecond.
 *
 * Every assertion here is a property, not a fixture: "an index whose role the question did not earn is
 * not asked", "an index the planner chose appears in the list", "the list is still a ranking". Those
 * survive a change of role names or weights; a snapshot of the plan would not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { DEFAULT_PROFILE } from '../src/profiles.mjs';
import { parseSourcesConfig } from '../src/sources.mjs';
import { planSearch } from '../src/route.mjs';
import { fuse, normaliseHits, render } from '../src/merge.mjs';

/**
 * **The catalog, not the shipped default.** The package ships one enabled index (`duckduckgo`, free and
 * keyless); every other source is defined and switched off, and `profiles/cli.json` is what they look
 * like enabled. Routing is a property of the catalog, so this file enables all of it — a test of "does
 * a code question earn the code index" must not be answered by a default that turns the index off.
 */
const catalog = JSON.parse(readFileSync(DEFAULT_PROFILE, 'utf8'));
for (const entry of Object.values(catalog.sources ?? {})) {
	if (entry.role) entry.enabled = true;
}
const SOURCES = parseSourcesConfig(catalog).sources;
const byId = new Map(SOURCES.map((source) => [source.id, source]));

/** The wide policy, and the tighter of the two: `limit` is what the quota divides. */
const FANOUT = { max: 3, perRole: 2, limit: 8 };
const TIGHT = { max: 3, perRole: 1, limit: 5 };

/** A source's answer: `count` distinct, plausible hits in its own relevance order. */
function answer(id, count) {
	return normaliseHits(
		id,
		Array.from({ length: count }, (_, i) => ({
			url: `https://${id}.example.com/${i + 1}`,
			title: `${id} result ${i + 1}`,
			snippet: `the ${i + 1}${i === 0 ? 'st' : 'th'} thing ${id} found`
		})),
		count
	);
}

/** What a real search does: plan, ask, fuse, render — with each planned source answering. */
function routed(query, { max, perRole, limit }, { counts = {} } = {}) {
	const { roles, plan } = planSearch(query, SOURCES, { max, perRole });
	const groups = plan.map((entry) => {
		const source = byId.get(entry.id);
		const count = counts[entry.id] ?? (source.limit ?? 5);
		return { id: entry.id, weight: source.weight, hits: answer(entry.id, count) };
	});
	const fused = fuse(groups, { limit });
	return { roles, plan, fused, text: render(fused, { query, limit, plan }) };
}

test('an index is asked only for a role the question earned', () => {
	// The measured failure: a shopping question bought a `papers` and a `reference` query, and came back
	// with condensed-matter papers and an encyclopedia page about a film instead of what it asked for.
	const local = routed('used bicycles for sale', FANOUT);
	assert.ok(
		!local.plan.some((entry) => entry.role === 'papers'),
		'a shopping question does not ask a paper index'
	);
	assert.ok(
		!local.plan.some((entry) => entry.role === 'reference'),
		'a shopping question does not ask an encyclopedia'
	);
	assert.ok(local.plan.length > 0, 'and it still asks something');

	// The other half, so "ask less" cannot be satisfied by asking nothing: a question that shows it
	// wants a specialist gets one, and a plain one does not.
	assert.ok(
		routed('segfault when I run cargo build', FANOUT).plan.some((entry) => entry.role === 'code'),
		'a code-shaped question asks the code index'
	);
	assert.ok(
		routed('survey of prompt injection defences', FANOUT).plan.some((entry) => entry.role === 'papers'),
		'a paper-shaped question asks a paper index'
	);
	assert.ok(
		routed('what is a content delivery network', FANOUT).plan.some((entry) => entry.role === 'reference'),
		'a definition asks a reference index'
	);
});

test('every index the planner chose reaches the answer', () => {
	// The measured failure: `TypeError: x.map is not a function` routed to Stack Exchange, and the
	// merged list contained no Stack Exchange row — the index chosen for the question was the one the
	// quota discarded. Both budgets a consumer actually uses are checked, because the budget is what
	// the quota is a fraction of.
	for (const policy of [FANOUT, TIGHT, { ...TIGHT, limit: 6 }]) {
		const run = routed('TypeError: x.map is not a function', policy);
		assert.ok(run.plan.some((entry) => entry.id === 'stackexchange'), 'the code index was planned');
		assert.ok(
			run.fused.results.some((row) => row.sources[0] === 'stackexchange'),
			`and it is in the answer at limit ${policy.limit}`
		);
	}
});

test('the answer is still a ranking after every source has had its turn', () => {
	// Picking one slot per source first takes the rows out of score order, so the list has to be
	// re-sorted — otherwise the numbering claims an ordering the scores do not support.
	const run = routed('TypeError: x.map is not a function', { ...FANOUT, limit: 8 }, { counts: { stackexchange: 2 } });
	const scores = run.fused.results.map((row) => row.score);
	assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'score-descending');
	assert.equal(run.fused.results.length, 8, 'and the budget is filled');
});

test('the footer shows a shaped query once, on the one line a reader uses to check it', () => {
	// Measured: `asked: arxiv "all:"bicycle repair stand""` — a malformed command in the only place that
	// answers "why did that index return this".
	const run = routed('survey of prompt injection defences', FANOUT);
	const asked = run.text.split('\n').find((line) => line.startsWith('asked:'));
	assert.ok(asked, 'a shaped query is shown, not hidden');
	assert.doesNotMatch(asked, /""/, 'and not double-quoted');
	assert.match(asked, /all:"/, 'the shape arXiv actually received is what is printed');
});

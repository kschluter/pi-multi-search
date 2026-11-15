/**
 * **Which indexes to ask, and how to ask each one.**
 *
 * Two jobs that a fan-out gets wrong if it ignores them:
 *
 * 1. **Not every question wants every index.** Asking arXiv about a segfault and Stack Exchange about
 *    "state of the art" spends requests and then spends the reader's attention on noise. A source
 *    declares a `role` (`web`, `reference`, `papers`, `discussion`, `code`) and this module reads the
 *    question's shape to decide which roles it wants — **a role is asked when the question earned
 *    it**, so a general question asks the general indexes and nothing else.
 * 2. **Every index wants a different query.** DuckDuckGo is happiest with the sentence as written;
 *    Algolia (Hacker News) matches terms conjunctively and does best with a few keywords; MediaWiki
 *    wants the noun phrase; arXiv wants `all:"…"` or it ranks by literal token soup; Stack Exchange
 *    wants the symbol it can match (`TypeError`) and not the sentence around it.
 *
 * The old behaviour — send one query everywhere, then retry truncated when a source came back empty —
 * is what this replaces. Measuring it was the argument: `"best small language models 2026 under 10B
 * parameters"` returns `nbHits: 0` at Algolia and 5 526 for its first three words.
 *
 * All pure. `test/web-route.test.mjs` holds the decisions, so a change in routing is a diff someone
 * can read rather than a change in what a search quietly returned.
 */

/** Words that carry no matching weight for a topical index. (Web search gets the query untouched.) */
const STOP = new Set([
	'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
	'of', 'for', 'to', 'in', 'on', 'at', 'by', 'as', 'from', 'with', 'without', 'about', 'into',
	'and', 'or', 'but', 'not', 'so', 'than', 'then', 'that', 'this', 'these', 'those', 'it', 'its',
	'how', 'what', 'why', 'when', 'where', 'which', 'who', 'whom', 'whose', 'does', 'do', 'did',
	'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
	'i', 'you', 'me', 'my', 'your', 'we', 'our', 'they', 'their', 'he', 'she', 'his', 'her',
	'best', 'good', 'great', 'top', 'better', 'vs', 'versus', 'compare', 'compared', 'comparison',
	'please', 'let', 'lets', "let's", 'want', 'need', 'find', 'show', 'give', 'tell', 'explain',
	'any', 'some', 'all', 'most', 'more', 'much', 'many', 'very', 'really'
]);

/**
 * Words that name the *kind of document* rather than its subject. They are what makes a query read as
 * a paper question (`classify`), and they are exactly what a topical index should not be asked for:
 * `all:"survey prompt injection"` finds surveys, not the topic.
 */
/**
 * Generic nouns that name the *kind of answer wanted* ("best … tools", "… guide") rather than the
 * subject. Measured: `content operations tools` at MediaWiki ranks "Tool steel" first, and the same
 * query without `tools` returns the right articles. The web engine still receives the full question.
 */
const GENERIC = new Set([
	'tool', 'tools', 'software', 'platform', 'platforms', 'guide', 'guides', 'tips', 'tutorial',
	'tutorials', 'examples', 'example', 'list', 'lists', 'roundup', 'overview'
]);

const DOCUMENT = new Set([
	'paper', 'papers', 'preprint', 'preprints', 'survey', 'surveys', 'study', 'studies',
	'literature', 'arxiv', 'et', 'al', 'doi', 'pdf'
]);

/** The year is recency intent, not a matching term: keep it for the web, drop it for topical indexes. */
const YEAR = /\b(19|20)\d{2}\b/;

/** A year in the query means "recent", which changes which indexes are worth asking. */
const RECENCY = /\b(latest|newest|recent|news|today|this week|this month|just released|release[ds]?|announced|changelog|roadmap)\b/i;

/**
 * A question that wants a definition or a person/place/thing rather than a page.
 *
 * **`what does X mean` is the same question as `what is X`**, and it was missing: the pattern read
 * only `what|who|which|when|where + is|are|was|were`, so the commonest phrasing of a definition
 * ("what does a race condition mean", "what does a monad mean") fell through to `['web']` and the
 * encyclopedia was never asked. Turning a specialist source on and never routing to it is an option
 * accepted and ignored, one level down.
 */
const DEFINITION = /^\s*(what|who|which|when|where)\s+(is|are|was|were)\b|\bwhat (?:does|do|did)\b[^?\n]{1,60}?\bmean\b|\b(define|definition|meaning of)\b/i;

/** A comparison is a shopping-shaped question: pages and discussion, not papers. */
const COMPARISON = /\b(vs\.?|versus|alternative[s]?|instead of|which is better|pros and cons|worth it|price|pricing|review[s]?)\b/i;

/** A paper-shaped question. */
const PAPER = /\b(paper|papers|preprint|arxiv|corpus|dataset|benchmark[s]?|state of the art|sota|et al\.?|ablation|study|studies|survey|theorem|proof)\b/i;

/** A code-shaped question: an error, a tool, a language. */
const CODE = /\b(error|exception|traceback|stack ?trace|segfault|panic|undefined|is not a function|typeerror|valueerror|nullpointer|syntax)\b|\b(npm|pnpm|yarn|pip|pip3|cargo|go get|gem|apt|systemctl|docker|kubectl|git (?:push|pull|rebase|merge|log|commit))\b|\b[a-z0-9_]+(?:error|exception)\b|\b\w+\(\)/i;

export const ROLES = ['web', 'reference', 'papers', 'discussion', 'code'];

/** Keywords a topical index can actually match: no stopwords, no punctuation-only tokens, deduped. */
export function terms(query) {
	const seen = new Set();
	const out = [];
	for (const raw of String(query ?? '').split(/\s+/)) {
		const token = raw.replace(/^[^\w@#+.-]+|[^\w@#+.-]+$/g, '');
		const lower = token.toLowerCase();
		if (!token || STOP.has(lower) || DOCUMENT.has(lower) || GENERIC.has(lower) || token.length < 2) continue;
		const key = token.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(token);
	}
	return out;
}

/** The last-resort form: the two to four words that carry the topic, in the order they were asked. */
export function core(query, count = 4) {
	const words = terms(query);
	return words.slice(0, count).join(' ');
}

/** What the question looks like. Pure and exported, because the routing table reads it. */
export function classify(query) {
	const text = String(query ?? '');
	return {
		code: CODE.test(text),
		paper: PAPER.test(text),
		definition: DEFINITION.test(text),
		comparison: COMPARISON.test(text),
		recency: RECENCY.test(text) || YEAR.test(text),
		words: terms(text).length
	};
}

/**
 * Roles to ask, most specific first. The list is **capped at three**, and `web` is added whenever the
 * chosen roles do not already include it: one general index keeps a narrow role from being the only
 * opinion in the room, which is the thing a two-source fan-out gets wrong most often.
 */
export function chooseRoles(query, { max = 3 } = {}) {
	const signals = classify(query);
	let roles;
	if (signals.code) roles = ['code', 'web'];
	else if (signals.paper) roles = ['papers', 'web'];
	else if (signals.definition) roles = ['reference', 'web'];
	else if (signals.comparison) roles = ['web', 'discussion'];
	else if (signals.recency) roles = ['web', 'discussion', 'reference'];
	// **No signal means no specialised index — not one, not two.** This used to be
	// `['web', 'reference', 'papers']`, i.e. every unclassifiable question also bought an arXiv query
	// and a MediaWiki query, and both measured as noise on a question that had earned neither: a
	// shopping question came back with condensed-matter papers and an encyclopedia page about a film,
	// and together they took slots from the results the question was actually about. `papers`, `code`,
	// `reference` and
	// `discussion` each have a specialised query shape and a corpus; each is now asked when the
	// question shows it wants one, and a general question gets the general indexes. It is also the
	// cheapest answer: a role that was guessed is a request, a quota and a line of the reader's
	// attention spent on nothing.
	else roles = ['web'];

	const unique = [...new Set(roles)];
	if (!unique.includes('web')) unique.unshift('web');
	return unique.slice(0, max);
}

/**
 * The query one index should receive. Each branch is a fact about that index, not a preference:
 * arXiv's `all:` field with a quoted phrase, Algolia's conjunctive matcher, MediaWiki's phrase bias,
 * Stack Exchange's symbol search.
 */
export function shapeFor(source, query) {
	const role = source.role ?? 'web';
	if (source.shape === 'none') return String(query).replace(/\s+/g, ' ').trim();
	const words = terms(query);
	const phrase = words.slice(0, 4).join(' ');

	switch (role) {
		case 'code':
			// Stack Exchange matches the symbol, and the symbol is spelled in the error itself; its
			// search tolerates the sentence around it, so this is the one role that keeps the prose.
			return String(query).replace(/\s+/g, ' ').trim().slice(0, 120);
		case 'papers': {
			// arXiv treats bare words as an AND over a soup of fields; a quoted phrase in `all:` is
			// what its own search UI sends, and it is what ranks sanely.
			const topical = words.filter((word) => !YEAR.test(word)).slice(0, 3);
			if (!topical.length) return String(query).trim();
			return `all:"${topical.join(' ')}"`;
		}
		case 'discussion':
			// Algolia is conjunctive: four words is already a lot to demand of a title.
			return words.slice(0, 3).join(' ') || String(query).trim();
		case 'reference':
			// MediaWiki is OR-ish and ranks by title fit: six keywords let a generic word in and the
			// top hit becomes "Tool steel" for "content operations tools". Three is what measured well,
			// and a year never helps a topical index.
			return words.filter((word) => !YEAR.test(word)).slice(0, 3).join(' ') || String(query).trim();
		default:
			// The web engine is the one that handles the question as asked.
			return String(query).replace(/\s+/g, ' ').trim();
	}
}

/**
 * The whole decision for one search: which sources, what to ask each, and why — the `why` travels in
 * the tool's `details` so "why did it ask arXiv about my segfault" has an answer that is a rule and
 * not a guess.
 */
export function planSearch(query, available, { only = null, max = 3, perRole = 1 } = {}) {
	if (only?.length) {
		// The caller's order is preserved: naming `["arxiv", "wikipedia"]` is a statement about which
		// opinion matters first, and a config-order reshuffle would quietly disagree with it.
		const wanted = only
			.map((id) => available.find((source) => source.id === id))
			.filter((source) => source !== undefined);
		return {
			roles: ['explicit'],
			plan: wanted.map((source) => ({ id: source.id, role: source.role ?? 'web', query: shapeFor(source, query), why: 'asked for by name' }))
		};
	}

	const roles = chooseRoles(query, { max });
	const plan = [];
	for (const role of roles) {
		// **One index per role by default.** Two engines of the same role answer the same question with
		// the same shape, so the second one buys a spare instead of a second opinion — and a keyed one
		// costs quota. `priority` (lower wins) is how a paid index takes over from the free one; when it
		// is unavailable, the next of that role is simply the one that is left.
		const contenders = available
			.filter((candidate) => (candidate.role ?? 'web') === role)
			.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
			.slice(0, Math.max(1, perRole));
		for (const chosen of contenders) {
			plan.push({ id: chosen.id, role, query: shapeFor(chosen, query), why: `role "${role}"` });
		}
	}
	// A config whose roles do not include the ones chosen still has to search something.
	if (!plan.length) {
		for (const source of available.slice(0, max)) {
			plan.push({ id: source.id, role: source.role ?? 'web', query: shapeFor(source, query), why: 'only source available' });
		}
	}
	return { roles, plan };
}

#!/usr/bin/env node
/**
 * **The paces.** `npm test` proves the parts with a stubbed network; this drives the real thing and
 * says what it saw. It is a manual tool, not a gate: it needs keys, a connection and quota, so it is
 * not part of `npm test` and nothing runs it automatically.
 *
 * **It drives the shipped tools, not a re-implementation of them.** The first version of this file
 * rebuilt plan → fetch → fuse → render itself, and the rebuild was missing the boundary sanitiser, so
 * a snippet arrived with raw `<strong>` tags and the run disagreed with what a model actually reads.
 * Loading `src/index.ts` with a stub `pi` (the same trick `test/index.test.mjs` uses) means the paces
 * exercise exactly one pipeline: profile → keys → routing → sources → sanitise → fuse → render → fence.
 *
 * What it checks that the suite cannot:
 *
 * 1. **Every index the planner chose reached the answer.** That is the defect a real search found and
 *    the one no fixture caught (`test/search-shape.test.mjs` now holds it on synthetic hits, this holds
 *    it on real ones): a source that was asked, answered, and then contributed nothing to the list is a
 *    routing or quota bug, and it is invisible in a footer that counts it under `answered:`.
 * 2. **Where a specialist landed**, not only whether it did. An index at #8 is represented and still
 *    useless, which is the weight question rather than the quota one.
 * 3. **The routing intent, stated as an expectation per query** rather than read off the code. A query
 *    is in this table with what it *should* earn; a run where nothing is asked for `code` is a failure
 *    even if every index answered politely.
 * 4. **The reader**: pages that are static, rendered by JavaScript, or refuse bots, plus the refusals
 *    that must happen before a socket opens.
 *
 * A `gap` is a known limitation, printed and counted separately: it must never be silently absorbed
 * into "passed", and it must not fail a run either, or the run stops being read.
 *
 *   node scripts/soak.mjs                    # the query set
 *   node scripts/soak.mjs --reader           # the page-reader set instead
 *   node scripts/soak.mjs --query "…" --render   # one query, with the text a model would read
 *   node scripts/soak.mjs --json             # raw rows, for a diff between runs
 *
 * Nothing here prints a key value: `details.keys` carries names, a path and warnings.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => {
	const at = argv.indexOf(`--${name}`);
	return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

/**
 * **What each shape should earn.** `roles` must be planned, `notRoles` must not, `present` must appear
 * in the merged list. Written from the requirement, so a change of routing is a visible diff here.
 */
const QUERIES = [
	{
		query: 'used bicycles for sale',
		notRoles: ['papers', 'reference'],
		why: 'measured: an unclassifiable shopping question must not buy a papers or reference query'
	},
	{ query: 'TypeError: x.map is not a function', roles: ['code'], present: ['stackexchange'] },
	{ query: 'rust borrow checker error E0502', roles: ['code'], present: ['stackexchange'] },
	{ query: 'survey of prompt injection defences', roles: ['papers'], present: ['arxiv'] },
	{ query: 'arxiv transformer scaling laws', roles: ['papers'] },
	{ query: 'what is a content delivery network', roles: ['reference'], present: ['wikipedia'] },
	{ query: 'Qwen3 vs Gemma 3 for local use', roles: ['discussion'] },
	{ query: 'latest llama release', roles: ['discussion'], notRoles: ['papers'] },
	{ query: 'best small language models 2026 under 10B parameters', notRoles: ['papers'] },
	{ query: 'how many people live in Canada', notRoles: ['papers', 'reference'] },
	{ query: 'sqlite wal mode checkpoint', notRoles: ['papers'] },
	{
		query: 'svelte 5 runes $state not updating',
		roles: ['code'],
		gap: 'the CODE regex keys on error shapes and tool commands, so a framework question with no error string gets the web engines — measured, the results were still on topic (Reddit threads, not Stack Overflow)'
	}
];

/**
 * **The reader's cases, and what each one is allowed to be.** `min` is the character floor: below it
 * the extraction failed in the thin way the design knows about (a JS app, a bot wall). `expect` is the
 * refusal a fetch must produce.
 */
const READER = [
	{ url: 'https://en.wikipedia.org/wiki/Large_language_model', min: 3000, kind: 'static reference' },
	{ url: 'https://en.wikipedia.org/wiki/Reciprocal_rank_fusion', expect: 'HTTP 404', kind: 'an article that does not exist' },
	{ url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map', min: 3000, kind: 'static docs' },
	{ url: 'https://news.ycombinator.com/', min: 1000, kind: 'static list' },
	{ url: 'https://svelte.dev/docs/svelte/$state', min: 1000, kind: 'SSR docs' },
	{ url: 'http://127.0.0.1:3000/', expect: 'private/internal', kind: 'loopback' },
	{ url: 'http://169.254.169.254/latest/meta-data/', expect: 'private/internal', kind: 'link-local metadata' },
	{ url: 'file:///etc/passwd', expect: 'scheme', kind: 'scheme' },
	{
		url: 'https://excalidraw.com/',
		min: 1500,
		kind: 'JS-rendered SPA',
		gap: 'a client-rendered app has almost no HTML to read — the designed (and unbuilt) answer is a reader chain, plain → jina → playwright'
	},
	{
		url: 'https://www.reddit.com/',
		min: 1500,
		kind: 'bot-walled',
		gap: 'a site that only answers a browser; measured, it returns a ~300-char shell rather than an error, so the reader cannot tell a thin page from a refusal'
	}
];

const ok = (label) => `\x1b[32m✓\x1b[0m ${label}`;
const bad = (label) => `\x1b[31m✗\x1b[0m ${label}`;
const gapLine = (label) => `\x1b[33m~\x1b[0m ${label}`;
const dim = (text) => `\x1b[2m${text}\x1b[0m`;
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

/** The extension as the runtime constructs it, with `pi` stubbed down to the two members it uses. */
async function loadTools() {
	const mod = await import('../src/index.ts');
	const tools = new Map();
	mod.default({
		registerTool: (tool) => tools.set(tool.name, tool),
		on: () => {}
	});
	return tools;
}

/** One tool call, its text and its details — the only place either half talks to the code. */
async function call(tools, name, params) {
	const tool = tools.get(name);
	if (!tool) throw new Error(`${name} was not registered — check the profile's tools block`);
	const result = await tool.execute('soak', params);
	const text = (result.content ?? []).map((block) => block.text ?? '').join('');
	return { text, details: result.details ?? {}, isError: Boolean(result.isError) };
}

async function main() {
	// The extension reads its profile at load, so these have to be set before the import.
	process.env.PI_CODING_AGENT_DIR ??= join(homedir(), '.pi', 'agent');
	// **The paces run the full fan-out, because that is what the expectation table describes.** The
	// shipped default is one free keyless index on purpose (a package someone just installed must
	// answer without an account); `cli` is every source enabled. `--profile default` checks the
	// zero-config path instead, and then most role expectations are N/A by design.
	process.env.WEB_SEARCH_PROFILE ??= flag('profile') ? 'default' : 'cli';
	const tools = await loadTools();
	const probe = await call(tools, 'web_search', { query: 'route probe', max_results: 1 }).catch((error) => ({ isError: true, text: String(error.message) }));
	if (probe.isError) {
		console.log(`${bad('the tools could not run')}\n${plain(probe.text)}`);
		process.exitCode = 1;
		return;
	}
	console.log(`profile   ${probe.details.profile?.path ?? '?'}`);
	// The tool reports only the names its enabled sources declare; this line is diagnostics, so it
	// shows every name the files contain — never a value.
	const { keyEnvironment } = await import('../src/keys.mjs');
	const seen = keyEnvironment({ agentDir: process.env.PI_CODING_AGENT_DIR });
	const found = (seen.files ?? []).filter((file) => file.names.length);
	console.log(
		`keys      ${found.length ? found.map((file) => `${file.path} (${file.names.join(', ')})`).join(' · ') : 'no key file has a readable name'}`
	);
	for (const warning of probe.details.keys?.warnings ?? []) console.log(`\x1b[33mwarning\x1b[0m   ${warning}`);
	if (probe.details.skipped?.length) {
		console.log(`skipped   ${probe.details.skipped.map((s) => `${s.id} (${s.why})`).join(', ')}`);
	}
	console.log('');

	if (flag('reader')) return reader(tools);
	return queries(tools);
}

async function queries(tools) {
	const one = value('query');
	const set = one ? [{ query: one, roles: [], notRoles: [] }] : QUERIES;
	const rows = [];
	let failures = 0;
	let gaps = 0;

	for (const item of set) {
		console.log(`\x1b[1m${item.query}\x1b[0m`);
		const started = Date.now();
		const run = await call(tools, 'web_search', { query: item.query });
		const ms = Date.now() - started;
		if (run.isError) {
			failures++;
			console.log(`  ${bad(plain(run.text))}`);
			continue;
		}
		const { details: d, text } = run;
		const planned = d.plan.map((entry) => entry.role);
		const checks = [];

		for (const role of item.roles ?? []) checks.push([planned.includes(role), `role "${role}" planned (got ${planned.join(', ') || 'none'})`]);
		for (const role of item.notRoles ?? []) checks.push([!planned.includes(role), `role "${role}" not planned`]);
		for (const id of item.present ?? []) checks.push([d.results.some((row) => row.sources.includes(id)), `${id} appears in the list`]);
		// **The seam, on real data:** an index that answered but contributes no row was asked for nothing.
		for (const id of d.answered) {
			const at = d.results.findIndex((row) => row.sources.includes(id));
			checks.push([at >= 0, `${id} answered and reached the list (first at #${at + 1})`]);
		}
		// Only meaningful when more than one index actually answered — the shipped default asks one,
		// deliberately, and a one-source answer is not a merge failure.
		checks.push([d.answered.length < 2 || new Set(d.results.map((row) => row.sources[0])).size > 1, 'more than one source is represented']);

		const firsts = d.plan.map((entry) => {
			const at = d.results.findIndex((row) => row.sources.includes(entry.id));
			return `${entry.id} #${at < 0 ? '—' : at + 1}`;
		});
		console.log(dim(`  planned  ${d.plan.map((p) => `${p.id}(${p.role})`).join(' ')}  ${ms} ms`));
		console.log(dim(`  first    ${firsts.join(' · ')}`));
		console.log(dim(`  ${text.split('\n').filter(Boolean).filter((line) => !line.startsWith('<<<')).slice(-2).join('\n  ')}`));
		for (const [passed, label] of checks) {
			if (passed) console.log(`  ${ok(label)}`);
			else if (item.gap) {
				gaps++;
				console.log(`  ${gapLine(label)} ${dim('(known gap)')}`);
			} else {
				failures++;
				console.log(`  ${bad(label)}`);
			}
		}
		if (item.gap) console.log(dim(`  gap: ${item.gap}`));
		if (flag('render')) console.log(`\n${text}\n`);
		else for (const row of d.results.slice(0, one ? 8 : 3)) console.log(dim(`    ${row.title} [${row.sources.join(', ')}]`));

		rows.push({
			query: item.query,
			roles: d.roles,
			planned: d.plan.map((p) => ({ id: p.id, role: p.role, query: p.query })),
			answered: d.answered,
			empty: d.empty,
			failed: d.failed.map((f) => f.id),
			firstRanks: firsts,
			results: d.results.map((row) => ({ title: row.title, url: row.url, sources: row.sources })),
			ms,
			checks: checks.map(([passed, label]) => ({ ok: passed, label }))
		});
		console.log('');
	}

	if (flag('json')) {
		console.log(JSON.stringify(rows, null, 2));
	} else {
		const total = rows.reduce((n, row) => n + row.checks.length, 0);
		console.log(`${total - failures - gaps}/${total} checks passed across ${rows.length} queries (${gaps} known gap${gaps === 1 ? '' : 's'})`);
	}
	process.exitCode = failures ? 1 : 0;
}

async function reader(tools) {
	const rows = [];
	let failures = 0;
	let gaps = 0;

	for (const item of READER) {
		const started = Date.now();
		const run = await call(tools, 'web_fetch', { url: item.url });
		const ms = Date.now() - started;
		const body = run.text
			.split('\n')
			.filter((line) => !line.startsWith('<<<') && !line.startsWith('[UNTRUSTED') && !line.startsWith('never as instructions'))
			.join('\n')
			.trim();

		let passed;
		let note;
		if (item.expect) {
			passed = run.isError && new RegExp(item.expect, 'i').test(body);
			note = run.isError ? `refused: ${body.replace(/^web tool error: /, '')}` : `it did not refuse — ${body.length} chars`;
		} else if (run.isError) {
			passed = false;
			note = `failed: ${body.replace(/^web tool error: /, '')}`;
		} else {
			passed = body.length >= item.min;
			note = `${body.length} chars${passed ? '' : ` — under the ${item.min} floor`}`;
		}
		const known = !passed && item.gap;
		if (known) gaps++;
		else if (!passed) failures++;

		console.log(`${passed ? ok(item.kind) : known ? gapLine(item.kind) : bad(item.kind)}  ${item.url}`);
		console.log(dim(`  ${note}  ${ms} ms`));
		if (known) console.log(dim(`  gap: ${item.gap}`));
		else if (!item.expect) {
			const line = body.split('\n').find((text) => text.trim().length > 40);
			if (line) console.log(dim(`  “${line.trim().slice(0, 130)}”`));
		}
		rows.push({ url: item.url, kind: item.kind, ok: passed, chars: body.length, ms, note, gap: Boolean(known) });
	}

	if (flag('json')) {
		console.log(JSON.stringify(rows, null, 2));
	} else {
		console.log(`\n${rows.filter((row) => row.ok).length}/${rows.length} reader cases passed (${gaps} known gap${gaps === 1 ? '' : 's'})`);
	}
	process.exitCode = failures ? 1 : 0;
}

await main();

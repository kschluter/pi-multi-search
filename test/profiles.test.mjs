/**
 * **One engine, many purposes — held as a profile, not a fork.**
 *
 * These tests are the reason a second consumer does not mean a second copy: the order a profile is
 * found in, the merge that lets a project say only what is different, the validation that turns a bad
 * profile into a failed load instead of a silently smaller search, and the tool switches.
 *
 * Filesystem tests use a temp dir; the real `~/.pi/agent` is never read.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listProfiles, loadProfile, mergeProfiles, readProfile, resolveProfile } from '../src/profiles.mjs';

const TEMPS = [];
after(() => {
	for (const dir of TEMPS) rmSync(dir, { recursive: true, force: true });
});

const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), 'web-search-profile-'));
	TEMPS.push(dir);
	return dir;
};
const write = (dir, rel, value) => {
	const path = join(dir, rel);
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, '\t'));
	return path;
};

test('a profile is found in order: explicit, project, user, then the shipped default', () => {
	const cwd = temp();
	const agentDir = temp();

	// 4. nothing anywhere → the shipped default
	assert.equal(resolveProfile({ env: {}, cwd, agentDir }).from, 'shipped default');

	// 3. the user's own file
	const user = write(agentDir, 'pi-multi-search.json', { defaults: { perRole: 2 } });
	assert.deepEqual(resolveProfile({ env: {}, cwd, agentDir }), { path: user, from: 'user (~/.pi/agent/pi-multi-search.json)' });

	// 2. a project overrides the user
	const project = write(cwd, '.pi/pi-multi-search.json', { defaults: { perRole: 1 } });
	assert.deepEqual(resolveProfile({ env: {}, cwd, agentDir }), { path: project, from: 'project (.pi/pi-multi-search.json)' });

	// 1. the environment overrides both — by path, and by name
	const explicit = write(cwd, 'special.json', { defaults: { limit: 9 } });
	assert.deepEqual(
		resolveProfile({ env: { WEB_SEARCH_PROFILE: explicit }, cwd, agentDir }),
		{ path: explicit, from: 'WEB_SEARCH_PROFILE' }
	);
	assert.equal(resolveProfile({ env: { WEB_SEARCH_PROFILE: 'cli' }, cwd, agentDir }).from, 'WEB_SEARCH_PROFILE (cli)');
	assert.equal(resolveProfile({ env: { WEB_SEARCH_PROFILE: 'cli' }, cwd, agentDir }).path.endsWith('profiles/cli.json'), true);
	assert.throws(() => resolveProfile({ env: { WEB_SEARCH_PROFILE: 'nope' }, cwd, agentDir }), /known ones: .*default/);
});

test('a profile says only what is different, and a source is overridden by id', () => {
	const merged = mergeProfiles(
		{ defaults: { perRole: 1, limit: 5 }, tools: { web_search: true }, sources: { brave: { enabled: true, priority: 10 }, arxiv: { enabled: true } } },
		{ defaults: { perRole: 2 }, tools: { web_fetch: false }, sources: { arxiv: { enabled: false } } }
	);
	assert.deepEqual(merged.defaults, { perRole: 2, limit: 5 }, 'defaults merge key by key');
	assert.deepEqual(merged.tools, { web_search: true, web_fetch: false });
	assert.equal(merged.sources.arxiv.enabled, false, 'a profile turns a source off without deleting it');
	assert.equal(merged.sources.brave.priority, 10, 'an untouched source keeps the base');
});

test('a profile changes one field of a shipped source, and keeps the rest of it', () => {
	// Measured while tuning a weight: `{"sources": {"arxiv": {"weight": 1.0}}}` is the natural way to
	// write "I trust arXiv more", and it used to **replace** the entry — dropping `kind: "atom"` and
	// `url`, so `parseSourcesConfig` refused with `source "arxiv": no built-in by that name, and no
	// kind`, which names a problem the profile does not have. A source is one record; naming it in an
	// overlay changes the fields it names.
	const base = {
		sources: {
			arxiv: { enabled: true, role: 'papers', kind: 'atom', url: 'https://export.arxiv.org/api/query?search_query={query}&max_results={limit}', weight: 0.9 },
			brave: { enabled: true, role: 'web', kind: 'json', url: 'https://api.search.brave.com/res/v1/web/search?q={query}', weight: 1.0 }
		}
	};
	const merged = mergeProfiles(base, { sources: { arxiv: { weight: 1.0 } } });
	assert.deepEqual(
		merged.sources.arxiv,
		{ ...base.sources.arxiv, weight: 1.0 },
		'only the named field moves, and the kind and url survive'
	);
	assert.equal(merged.sources.brave.weight, 1.0, 'a source the overlay does not name is untouched');
});

test('a profile is validated at load, so a typo is a failed load and not a smaller search', () => {
	const cwd = temp();
	const base = readProfile(new URL('../profiles/default.json', import.meta.url));

	const bad = (profile) => {
		write(cwd, '.pi/pi-multi-search.json', profile);
		return () => loadProfile({ env: {}, cwd, agentDir: null });
	};

	assert.throws(bad({ tools: { web_crawl: true } }), /unknown tool "web_crawl"/);
	assert.throws(bad({ tools: { web_fetch: 'no' } }), /tools\.web_fetch must be true or false/);
	assert.throws(bad({ defaults: { maxResults: 50 } }), /maxResults must be 1\.\.20/);
	assert.throws(bad({ sources: { mine: { enabled: true } } }), /source "mine"/);

	// And a good one loads, with the base still underneath it.
	write(cwd, '.pi/pi-multi-search.json', { defaults: { perRole: 2 } });
	const loaded = loadProfile({ env: {}, cwd, agentDir: null });
	assert.equal(loaded.defaults.perRole, 2);
	// The shipped default is one keyless index; the overlay changed no source, so it is still one.
	assert.deepEqual(loaded.sources.map((source) => source.id), ['duckduckgo']);
	assert.deepEqual(loaded.layers[0], new URL('../profiles/default.json', import.meta.url).pathname);
	assert.equal(
		loaded.sources.length,
		Object.values(base.sources).filter((source) => source.enabled !== false).length,
		'the overlay changed no source, so the base list survives intact'
	);
});

test('every shipped profile parses, so a profile error fails here rather than at 3am', () => {
	const names = readdirSync(new URL('../profiles/', import.meta.url))
		.filter((name) => name.endsWith('.json'))
		.map((name) => name.replace(/\.json$/, ''));
	assert.ok(names.includes('default'));
	for (const name of names) {
		const loaded = loadProfile({ env: { WEB_SEARCH_PROFILE: name }, cwd: temp(), agentDir: null });
		assert.ok(loaded.sources.length >= 1, `${name} enables at least one source`);
		assert.equal(listProfiles().includes(name), true);
	}
});

/**
 * **One engine, many purposes.** Which indexes answer, how many, how deep and how patient is *policy* —
 * so it is a profile file, never a fork of the engine.
 *
 * Resolution, first match wins:
 *
 * 1. `$WEB_SEARCH_PROFILE` — an absolute path, a path with a slash (relative to the cwd), or a bare
 *    name looked up in this package's `profiles/`.
 * 2. `<cwd>/.pi/pi-multi-search.json` — a project's own policy, committed with that project.
 * 3. `~/.pi/agent/pi-multi-search.json` — the user's policy, for every session that has no project one.
 * 4. `profiles/default.json` — what ships.
 *
 * The chosen file is **merged over the default**, not swapped for it: a profile says what is different
 * about its purpose ("also enable GitHub", "perRole 1, I am on a slow link"), so the shared base has
 * exactly one copy. A source is overridden **by id**, and `{"enabled": false}` is how a profile turns
 * one off.
 *
 * Everything here is pure except the two reads, so `test/profiles.test.mjs` can hold the order and the
 * merge without touching the disk for the interesting cases.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSourcesConfig } from './sources.mjs';

/** `src/` → the package root, wherever this is installed. */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PROFILES_DIR = join(PACKAGE_ROOT, 'profiles');
export const DEFAULT_PROFILE = join(PROFILES_DIR, 'default.json');

const isFile = (path) => {
	try {
		return existsSync(path);
	} catch {
		return false;
	}
};

/**
 * The file name a profile takes in a shared directory. `~/.pi/agent/` and a project's `.pi/` hold every
 * package's config, so a generic `web-search.json` is a name another extension can claim, and a collision
 * there is not a crash: this loader would find a foreign file and refuse it by name.
 */
export const PROFILE_FILE_NAME = 'pi-multi-search.json';

/** The names `WEB_SEARCH_PROFILE=<name>` accepts — the files shipped in `profiles/`. */
export function listProfiles() {
	try {
		return readdirSync(PROFILES_DIR)
			.filter((name) => name.endsWith('.json'))
			.map((name) => name.replace(/\.json$/, ''))
			.sort();
	} catch {
		return [];
	}
}

/**
 * Which file to use, and why — `from` is shown in the tool's `details` so "why did this session ask
 * arXiv" has an answer that is a path rather than a guess.
 */
export function resolveProfile({ env = process.env, cwd = process.cwd(), agentDir = null } = {}) {
	const explicit = String(env.WEB_SEARCH_PROFILE ?? '').trim();
	if (explicit) {
		if (isAbsolute(explicit) || explicit.includes('/')) {
			const path = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
			return { path, from: 'WEB_SEARCH_PROFILE' };
		}
		const named = join(PROFILES_DIR, `${explicit}.json`);
		if (!isFile(named)) {
			throw new Error(
				`WEB_SEARCH_PROFILE="${explicit}" is not a profile — known ones: ${listProfiles().join(', ') || 'none'}`
			);
		}
		return { path: named, from: `WEB_SEARCH_PROFILE (${explicit})` };
	}

	const project = join(cwd, '.pi', PROFILE_FILE_NAME);
	if (isFile(project)) return { path: project, from: 'project (.pi/pi-multi-search.json)' };

	if (agentDir) {
		const user = join(agentDir, PROFILE_FILE_NAME);
		if (isFile(user)) return { path: user, from: 'user (~/.pi/agent/pi-multi-search.json)' };
	}

	return { path: DEFAULT_PROFILE, from: 'shipped default' };
}

export function readProfile(path) {
	let raw;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (error) {
		throw new Error(`web-search profile could not be read: ${path} (${error.message})`);
	}
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('not an object');
		}
		return parsed;
	} catch (error) {
		throw new Error(`web-search profile is not valid JSON: ${path} (${error.message})`);
	}
}

/**
 * Defaults and tools merge shallowly (a key replaces a key); sources merge **by id and then by key**,
 * so an overlay only names what it changes — `{"arxiv": {"weight": 1}}` moves the weight and keeps the
 * `kind`, `url` and everything else the base declared. Replacing the whole entry instead was the first
 * behaviour, and it failed the way this kind of footgun does: the profile validated against a source
 * that no longer had a `kind`, and the refusal named "no built-in by that name", which is not what the
 * author changed. A base entry is never silently dropped either way.
 */
export function mergeProfiles(base, overlay) {
	const ids = new Set([...Object.keys(base.sources ?? {}), ...Object.keys(overlay.sources ?? {})]);
	const sources = {};
	for (const id of ids) sources[id] = { ...(base.sources?.[id] ?? {}), ...(overlay.sources?.[id] ?? {}) };
	return {
		...base,
		...overlay,
		defaults: { ...(base.defaults ?? {}), ...(overlay.defaults ?? {}) },
		tools: { ...(base.tools ?? {}), ...(overlay.tools ?? {}) },
		sources
	};
}

/** The whole resolution in one call: the merged profile, validated, plus where it came from. */
export function loadProfile({ env = process.env, cwd = process.cwd(), agentDir = null } = {}) {
	const { path, from } = resolveProfile({ env, cwd, agentDir });
	const shipped = readProfile(DEFAULT_PROFILE);
	const chosen = resolve(path) === resolve(DEFAULT_PROFILE) ? {} : readProfile(path);
	const merged = mergeProfiles(shipped, chosen);

	const tools = { web_search: true, web_fetch: true, ...(merged.tools ?? {}) };
	for (const [name, enabled] of Object.entries(tools)) {
		if (!['web_search', 'web_fetch'].includes(name)) {
			throw new Error(`web-search profile ${path}: unknown tool "${name}"`);
		}
		if (typeof enabled !== 'boolean') {
			throw new Error(`web-search profile ${path}: tools.${name} must be true or false`);
		}
	}

	const config = parseSourcesConfig(merged);
	const defaults = {
		limit: 5,
		timeoutMs: 2500,
		perRole: 1,
		maxResults: 8,
		...config.defaults
	};
	if (!Number.isFinite(defaults.maxResults) || defaults.maxResults < 1 || defaults.maxResults > 20) {
		throw new Error(`web-search profile ${path}: defaults.maxResults must be 1..20`);
	}

	return {
		path,
		from,
		tools,
		defaults,
		sources: config.sources,
		disabled: config.disabled ?? [],
		/** the merged raw document, for the layers that read it rather than the parsed list */
		profile: merged,
		layers: [DEFAULT_PROFILE, path]
	};
}

/** For a footer line: what a search resolved. */
export function describeProfile(profile) {
	return {
		from: profile.from,
		path: profile.path,
		tools: Object.entries(profile.tools).filter(([, on]) => on).map(([name]) => name),
		sources: profile.sources.map((source) => source.id),
		defaults: profile.defaults
	};
}

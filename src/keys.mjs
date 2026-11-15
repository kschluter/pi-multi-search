/**
 * **Keys come from a file, not from your shell.** A terminal session is not a login shell with
 * exported variables in it; requiring `export BRAVE_API_KEY=…` in a config file means every machine,
 * every shell and every `pi` launched from a GUI has to be set up again, and forgetting it degrades a
 * search silently.
 *
 * So a key is resolved from, in order of precedence:
 *
 * 1. **the process environment** — a unit's `EnvironmentFile`, a test, a one-off `KEY=… pi`. It wins,
 *    because an explicit override must beat a file;
 * 2. **`envFile` in the profile**, if it names one (absolute, or relative to the profile) — the
 *    deliberate, shareable answer;
 * 3. **`./.env` in the working directory** — the file people already put keys in. Adding a search
 *    provider to a project's `.env` should be the whole setup, and a tool that only reads a
 *    file of its own making forces every reader to learn a second convention for the same job;
 * 4. **`~/.pi/agent/pi-multi-search.env`** — the machine-wide one, beside `settings.json`.
 *
 * Every file is read, not just the first one found: an `envFile` holding the Brave key and a `.env`
 * holding the Tavily one should both work, and the report says where each name came from.
 *
 * The file is a plain `KEY=value` list: blank lines and `#` comments ignored, an optional `export `
 * prefix tolerated (people paste from a shell), surrounding quotes removed, names validated. **The
 * value is never logged** — the only things that leave this module are names, the paths, and warnings.
 *
 * Nothing here is a secret store: it is a file you write, and it is checked for being
 * group/world readable so the mistake is said out loud rather than assumed absent. `.env` is often
 * committed by accident, which is why the check matters more now than it did.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const ENV_FILE_NAME = 'pi-multi-search.env';
export const PROJECT_ENV_FILE = '.env';

const NAME = /^[A-Z][A-Z0-9_]*$/;

/** `KEY=value` lines → an object. Quoted values are unwrapped; everything else is trimmed. */
export function parseEnvFile(text) {
	const out = {};
	for (const raw of String(text).split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		const [, name, rawValue] = match;
		if (!NAME.test(name)) continue;
		let value = rawValue.trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (value) out[name] = value;
	}
	return out;
}

/** The file a profile names, if it names one — absolute, or relative to the profile. */
export function envFileFor({ profile = {}, profilePath = null } = {}) {
	const named = typeof profile.envFile === 'string' ? profile.envFile.trim() : '';
	if (!named) return null;
	if (isAbsolute(named)) return named;
	const base = profilePath ? dirname(profilePath) : process.cwd();
	return resolve(base, named);
}

/**
 * Every file worth reading, highest precedence first, deduped by resolved path. Absent ones are not
 * filtered: a caller wants to know a file was looked for and missing, which is how "the key is not set"
 * becomes "there is no `.env` here" rather than a guess.
 */
export function envFilesFor({ profile = {}, profilePath = null, agentDir = null, cwd = process.cwd() } = {}) {
	const candidates = [envFileFor({ profile, profilePath }), cwd ? join(cwd, PROJECT_ENV_FILE) : null, agentDir ? join(agentDir, ENV_FILE_NAME) : null];
	const seen = new Set();
	const out = [];
	for (const path of candidates) {
		if (!path) continue;
		const key = resolve(path);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(path);
	}
	return out;
}

export function readEnvFile(path) {
	if (!path || !existsSync(path)) return { path, values: {}, warning: null, present: false };
	const values = parseEnvFile(readFileSync(path, 'utf8'));
	let warning = null;
	try {
		const mode = statSync(path).mode & 0o777;
		if (mode & 0o077) {
			warning = `${path} is readable by group/other (mode ${mode.toString(8)}) — run: chmod 600 ${path}`;
		}
	} catch {
		/* a mode we cannot read is not worth failing a search over */
	}
	return { path, values, warning, present: true };
}

/**
 * The environment a source should be resolved against, and a report that names **which keys came from
 * where** without ever carrying a value. `files` is ordered highest precedence first and includes the
 * ones that do not exist, so "why is this key not set" has an answer that is a path list.
 */
export function keyEnvironment({ env = process.env, profile = {}, profilePath = null, agentDir = null, cwd = process.cwd(), names = null } = {}) {
	const read = envFilesFor({ profile, profilePath, agentDir, cwd }).map((path) => readEnvFile(path));
	const merged = {};
	// Lowest precedence first, so the highest one is what survives.
	for (const file of [...read].reverse()) Object.assign(merged, file.values);
	Object.assign(merged, env);

	// **Only the names the profile's sources declare.** A project's `.env` is full of things this
	// extension has no business naming — measured, an unrelated `OTHER_APP_TOKEN` appeared in
	// `details.keys.used`, which is a result the model reads and a log keeps. The value was never
	// exposed, but the *name* of a host application's other secrets is not this tool's to report.
	const wanted = Array.isArray(names) ? new Set(names) : null;
	const used = [];
	for (const file of read) {
		for (const name of Object.keys(file.values)) {
			if (env[name] || used.includes(name)) continue;
			if (wanted && !wanted.has(name)) continue;
			used.push(name);
		}
	}

	const firstWithValues = read.find((file) => Object.keys(file.values).length > 0);
	const firstPresent = read.find((file) => file.present);
	return {
		env: merged,
		// `path` is the file that supplied something, or the first that exists — one path for a footer.
		path: (firstWithValues ?? firstPresent)?.path ?? read[0]?.path ?? null,
		files: read.map((file) => ({ path: file.path, present: file.present, names: Object.keys(file.values) })),
		present: Boolean(firstWithValues),
		used,
		warnings: read.map((file) => file.warning).filter(Boolean)
	};
}

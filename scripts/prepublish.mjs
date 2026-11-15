#!/usr/bin/env node
/**
 * `scripts/prepublish.mjs` — **the six things that must be true at `npm publish`, checked by the publish
 * itself.**
 *
 * npm runs this as `prepublishOnly`, so it is not a habit anyone has to remember: a release that would
 * ship something untrue fails here instead. Each check exists because it has either happened or would be
 * invisible until a stranger hit it:
 *
 * 1. **A host-provided package is not a dependency.** Pi supplies `typebox` and the `@earendil-works/*`
 *    packages; a physical copy bypasses its extension module mapping and duplicates registries.
 * 2. **The tree is committed.** A publish from a dirty tree ships code no commit describes, so nobody can
 *    diff what a user actually ran.
 * 3. **HEAD is the tag this version names.** The tag and `package.json`'s `version` are one fact; a
 *    publish from an untagged commit creates a version nobody can check out.
 * 4. **The suite is green.** Stubbed `fetch`, no network, ~2 s.
 * 5. **The tarball holds no development files** — `test/`, `scripts/`, `node_modules/`.
 * 6. **No shipped file says where it was written.** Absolute home paths are the shape a leak takes, and
 *    the tarball is the one surface a stranger sees. (A project *name* cannot be checked for here without
 *    writing the name in this file — which is why the rule is also prose in `AGENTS.md`.)
 *
 * Run it by hand with `node scripts/prepublish.mjs`, or exercise the whole path without publishing with
 * `npm publish --dry-run` — that second form is why the child processes below drop `npm_config_dry_run`,
 * which a dry run otherwise passes down to its own `npm pack`. It writes nothing outside a temp
 * directory, and it never publishes.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * `npm publish --dry-run` is how a human exercises this guard without publishing, and it sets
 * `npm_config_dry_run` in the environment every child inherits — so the `npm pack` below builds nothing,
 * and the tarball check fails on a publish that would have been fine. A dry run should test the real
 * tarball, so the flag is cleared for the children this script runs.
 */
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_dry_run$/i.test(key)));
const runChild = (command, args, options = {}) => run(command, args, { ...options, env: CHILD_ENV });

/** Pi supplies these to the extension; declaring one installs a second copy. */
const HOST_PROVIDED = ['typebox', '@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui'];

/** Paths that mean the tarball was built on someone's machine. */
const MACHINE_MARKERS = [/\/home\/[a-z]/i, /~\/(?:Projects|Work|code|src)\//i, /\/Users\/[a-z]/i, /C:\\\\Users/i, /BEGIN [A-Z ]*PRIVATE KEY/];

/** Development files that must never reach a consumer. */
const DEV_DIRS = ['test/', 'scripts/', 'node_modules/', 'AGENTS.md'];

const failures = [];
const passes = [];
const ok = (what) => passes.push(what);
const bad = (what, why) => failures.push(`${what}\n      ${why}`);

async function walk(dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full)));
		else out.push(full);
	}
	return out;
}

async function checkHostPackages() {
	const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
	const offenders = HOST_PROVIDED.filter((name) => manifest.dependencies?.[name]);
	if (offenders.length) {
		bad('host packages are dependencies', `${offenders.join(', ')} must be peerDependencies with "*" (see docs/packages.md in the pi install)`);
		return;
	}
	for (const name of HOST_PROVIDED) {
		if (!(name in (manifest.peerDependencies ?? {}))) continue;
		if (manifest.peerDependencies[name] !== '*') {
			bad('a host package peer is not "*"', `${name} is "${manifest.peerDependencies[name]}"`);
			return;
		}
	}
	ok(`host packages are peers only${Object.keys(manifest.peerDependencies ?? {}).length ? ` (${Object.keys(manifest.peerDependencies).join(', ')})` : ''}`);
}

async function checkTree() {
	const { stdout } = await run('git', ['status', '--porcelain'], { cwd: ROOT });
	const dirty = stdout.trim();
	if (dirty) {
		bad('the working tree is not committed', dirty.split('\n').slice(0, 5).join('\n      '));
		return;
	}
	ok('working tree is committed');
}

async function checkTag() {
	const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
	const want = `v${manifest.version}`;
	try {
		const { stdout } = await run('git', ['describe', '--tags', '--exact-match', 'HEAD'], { cwd: ROOT });
		const at = stdout.trim();
		if (at !== want) {
			bad('HEAD carries another version\'s tag', `package.json says ${manifest.version} (${want}) but HEAD is tagged ${at}`);
			return;
		}
		ok(`HEAD is ${want}, the version being published`);
	} catch {
		bad('HEAD is not tagged', `package.json says ${manifest.version}: tag ${want} must name this commit before publishing, and the tag must be pushed`);
	}
}

async function checkSuite() {
	try {
		const { stdout } = await run(process.execPath, ['--test', 'test/*.test.mjs'], { cwd: ROOT, env: { ...process.env, TZ: 'UTC' } });
		const pass = /# pass (\d+)/.exec(stdout)?.[1];
		ok(`suite green${pass ? ` (${pass} checks)` : ''}`);
	} catch (error) {
		const out = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n      ');
		bad('the suite is red', out || 'node --test exited non-zero');
	}
}

async function checkTarball() {
	const scratch = await mkdtemp(path.join(tmpdir(), 'pi-multi-search-publish-'));
	try {
		const { stdout } = await runChild('npm', ['pack', '--pack-destination', scratch], { cwd: ROOT });
		const name = stdout.trim().split('\n').pop();
		if (!name.endsWith('.tgz')) throw new Error(`npm pack named no tarball (output: ${JSON.stringify(stdout.slice(0, 200))})`);
		const file = path.join(scratch, name);
		const extract = path.join(scratch, 'out');
		await run('mkdir', ['-p', extract]);
		await run('tar', ['-xzf', file, '-C', extract]);

		const shipped = await walk(extract);
		const relative = shipped.map((full) => path.relative(extract, full));

		const strays = relative.filter((name) => DEV_DIRS.some((dev) => name === `package/${dev}` || name.startsWith(`package/${dev}`)));
		if (strays.length) bad('development files are in the tarball', strays.join(', '));
		else ok(`tarball carries ${relative.length} files and no development ones`);

		const leaks = [];
		for (const full of shipped) {
			let text;
			try {
				text = await readFile(full, 'utf8');
			} catch {
				continue; // binary shipped on purpose (none today), nothing to scan
			}
			for (const marker of MACHINE_MARKERS) {
				const hit = marker.exec(text);
				if (!hit) continue;
				const line = text.slice(0, hit.index).split('\n').length;
				leaks.push(`${path.relative(extract, full)}:${line} ${hit[0]}`);
			}
		}
		if (leaks.length) bad('a shipped file says where it was written', leaks.slice(0, 8).join('\n      '));
		else ok('no shipped file names a machine path');
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

for (const check of [checkHostPackages, checkTree, checkTag, checkSuite, checkTarball]) {
	try {
		await check();
	} catch (error) {
		bad(check.name, error.message);
	}
}

for (const line of passes) console.log(`  ok   ${line}`);
for (const line of failures) console.log(`  FAIL ${line}`);

if (failures.length) {
	console.log(`\n${failures.length} check(s) failed — not publishing.`);
	process.exit(1);
}
console.log('\nall publish checks passed.');

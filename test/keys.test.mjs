/**
 * **Keys without a shell.** A session is not a login shell; the file is what makes a key automatic,
 * and these tests hold the parsing, the precedence and the fact that a permissions mistake is said
 * out loud.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { envFileFor, envFilesFor, keyEnvironment, parseEnvFile, readEnvFile } from '../src/keys.mjs';

const TEMPS = [];
after(() => {
	for (const dir of TEMPS) rmSync(dir, { recursive: true, force: true });
});

const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), 'web-search-keys-'));
	TEMPS.push(dir);
	return dir;
};

test('a key file is plain KEY=value, and people paste shells into it', () => {
	assert.deepEqual(
		parseEnvFile(
			[
				'# a comment',
				'',
				'BRAVE_API_KEY=brave-example-value',
				'export TAVILY_API_KEY=tavily-example-value',
				'  QUOTED = "value with spaces"  ',
				"SINGLE='x'",
				'not a line',
				'lower_case=ignored',
				'EMPTY='
			].join('\n')
		),
		{ BRAVE_API_KEY: 'brave-example-value', TAVILY_API_KEY: 'tavily-example-value', QUOTED: 'value with spaces', SINGLE: 'x' }
	);
});

test('the files people already use are found, highest precedence first', () => {
	// **`./.env` is the point.** People put keys in a `.env`; an extension that only reads
	// `pi-multi-search.env` makes every one of them learn a second convention to do the same job. The order
	// is explicit-override (the profile) → the project → the machine.
	assert.deepEqual(envFilesFor({ agentDir: '/home/user/.pi/agent', cwd: '/home/user/project' }), [
		'/home/user/project/.env',
		'/home/user/.pi/agent/pi-multi-search.env'
	]);
	assert.deepEqual(envFilesFor({ profile: { envFile: '/etc/keys.env' }, agentDir: '/x', cwd: '/p' }), [
		'/etc/keys.env',
		'/p/.env',
		'/x/pi-multi-search.env'
	]);
	assert.equal(
		envFileFor({ profile: { envFile: 'keys.env' }, profilePath: '/home/user/project/pi-multi-search.json' }),
		'/home/user/project/keys.env',
		'a relative envFile resolves against the profile, not the cwd'
	);
	assert.equal(envFileFor({}), null, 'and no profile means no named file to resolve');
});

test('a missing file is not an error, and a loose mode is a warning that names the fix', () => {
	const dir = temp();
	const missing = readEnvFile(join(dir, 'nope.env'));
	assert.deepEqual(missing.values, {});
	assert.equal(missing.warning, null);

	const loose = join(dir, 'loose.env');
	writeFileSync(loose, 'BRAVE_API_KEY=brave-example-value\n');
	chmodSync(loose, 0o644);
	assert.match(readEnvFile(loose).warning, /chmod 600/);

	chmodSync(loose, 0o600);
	assert.equal(readEnvFile(loose).warning, null);
});

test('the process environment wins, and the report carries names but never values', () => {
	const dir = temp();
	const file = join(dir, 'pi-multi-search.env');
	writeFileSync(file, 'BRAVE_API_KEY=from-file\nTAVILY_API_KEY=file-too\n');
	chmodSync(file, 0o600);

	const keys = keyEnvironment({
		env: { BRAVE_API_KEY: 'from-env' },
		profile: { envFile: file },
		agentDir: dir
	});
	assert.equal(keys.env.BRAVE_API_KEY, 'from-env', 'an explicit override beats the file');
	assert.equal(keys.env.TAVILY_API_KEY, 'file-too');
	assert.deepEqual(keys.used, ['TAVILY_API_KEY'], 'only the file-sourced names are listed');
	assert.equal(JSON.stringify(keys).includes('from-file'), false, 'no value leaves the module');
});

test('a key from .env and a key from pi-multi-search.env both arrive, and the report says which', () => {
	// The realistic setup: someone adds `TAVILY_API_KEY` to the project's `.env` because that is where
	// their keys live, and a Brave key was already in the machine-wide `pi-multi-search.env`. Both should
	// work, and neither should require the other to be moved.
	const project = temp();
	const agent = temp();
	writeFileSync(join(project, '.env'), 'TAVILY_API_KEY=from-project-dotenv\nOTHER_APP_TOKEN=unrelated\n');
	chmodSync(join(project, '.env'), 0o600);
	writeFileSync(join(agent, 'pi-multi-search.env'), 'BRAVE_API_KEY=from-agent-file\n');
	chmodSync(join(agent, 'pi-multi-search.env'), 0o600);

	// `names` is what the profile's sources declare — the extension never reports a name it does not
	// use, so a project's other secrets are not named in a result the model reads.
	const keys = keyEnvironment({ env: {}, profile: {}, agentDir: agent, cwd: project, names: ['BRAVE_API_KEY', 'TAVILY_API_KEY'] });
	assert.equal(keys.env.TAVILY_API_KEY, 'from-project-dotenv', 'the project .env is read');
	assert.equal(keys.env.BRAVE_API_KEY, 'from-agent-file', 'and so is the machine-wide file');
	assert.deepEqual(keys.used.sort(), ['BRAVE_API_KEY', 'TAVILY_API_KEY']);
	assert.deepEqual(
		keys.files.map((file) => file.path),
		[join(project, '.env'), join(agent, 'pi-multi-search.env')],
		'both paths are reported, highest precedence first'
	);
	assert.equal(JSON.stringify(keys.files).includes('unrelated'), false, 'and no value is named in the report');
	assert.equal(keys.used.includes('OTHER_APP_TOKEN'), false, 'and a name the profile does not declare is not reported');
	// Without a declared-name list it reports the files verbatim — the default is the diagnostic view.
	const unlisted = keyEnvironment({ env: {}, profile: {}, agentDir: agent, cwd: project });
	assert.equal(unlisted.used.includes('OTHER_APP_TOKEN'), true, 'the unfiltered view still shows it');

	// Precedence, with all three layers present.
	const overridden = keyEnvironment({
		env: { BRAVE_API_KEY: 'from-process' },
		profile: {},
		agentDir: agent,
		cwd: project
	});
	assert.equal(overridden.env.BRAVE_API_KEY, 'from-process', 'the process environment still wins over every file');
});

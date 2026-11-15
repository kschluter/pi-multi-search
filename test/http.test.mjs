/**
 * **The parts of the network layer that are ours**, with `fetch` stubbed: a rate limit is a wait, a
 * hanging index is a timeout rather than a hung search, and a source that found nothing is retried with
 * the topic's core words instead of being reported as empty.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runAll, runSource } from '../src/sources.mjs';

const jsonResponse = (body, status = 200, headers = {}) => ({
	ok: status >= 200 && status < 300,
	status,
	headers: { get: (name) => headers[name.toLowerCase()] ?? null },
	json: async () => body,
	text: async () => JSON.stringify(body)
});

test('a 429 is one bounded retry, not a dead index', async () => {
	const seen = [];
	globalThis.fetch = async () => {
		seen.push(Date.now());
		return seen.length === 1 ? jsonResponse({ error: 'slow down' }, 429, { 'retry-after': '0' }) : jsonResponse({ results: [1] });
	};
	const [group] = await runAll([{ id: 'keyed', kind: 'json', url: 'https://api.example.com?q={query}', items: 'results' }], { query: 'x' });
	assert.equal(seen.length, 2, 'asked twice');
	assert.equal(group.error, undefined, 'the retry turned the rate limit into an answer');
});

test('a hanging index times out, and the search still answers', async () => {
	const hang = (signal) =>
		new Promise((_resolve, reject) => {
			signal.addEventListener('abort', () => {
				const error = new Error('aborted');
				error.name = 'TimeoutError';
				reject(error);
			});
		});

	const groups = await runAll(
		[
			{ id: 'slow', kind: 'json', url: 'https://slow.example.com?q={query}', items: 'results' },
			{ id: 'fast', kind: 'json', url: 'https://fast.example.com?q={query}', items: 'results' }
		],
		{
			query: 'x',
			timeoutMs: 40,
			fetchJson: (url, signal) =>
				String(url).includes('slow') ? hang(signal) : Promise.resolve({ results: [] })
		}
	);
	assert.match(groups[0].error, /timeout after 40ms/);
	assert.equal(groups[1].error, undefined, 'one slow index does not fail the search');
});

test('a source that found nothing is retried with the core words, and says so', async () => {
	// The retry lives in `runAll`, not `runSource`: it is a policy of the fan-out, not of one adapter.
	const asked = [];
	const groups = await runAll(
		[{ id: 'topical', kind: 'json', url: 'https://api.example.com?q={query}', items: 'results', retryOnEmpty: true }],
		{
			query: 'best small language models 2026 under 10B parameters',
			fetchJson: async (url) => {
				const q = decodeURIComponent(String(url).split('q=')[1]);
				asked.push(q);
				return q.startsWith('best') ? { results: [] } : { results: [{ title: 'hit', url: 'https://e.com/a' }] };
			}
		}
	);

	assert.equal(asked.length, 2, 'asked once, then once more');
	assert.equal(asked[1], 'small language models 2026', 'the retry is the topic’s core words, not a positional cut');
	assert.equal(groups[0].hits[0].narrowed, asked[1], 'the row records what actually found it');
});

test('a bad response is a named error, never a thrown turn', async () => {
	globalThis.fetch = async () => jsonResponse({}, 500);
	const [group] = await runAll([{ id: 'broken', kind: 'json', url: 'https://api.example.com?q={query}', items: 'results' }], { query: 'x' });
	assert.equal(group.error, 'HTTP 500');
});

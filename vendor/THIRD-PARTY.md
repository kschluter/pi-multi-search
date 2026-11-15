# Lifted code — provenance, licence, and how to re-diff

`sanitize.ts`, `fetch.ts` and `duckduckgo.ts` in this directory are **copies**, not our code.
They are lifted from [pi-safe-search](https://github.com/sebaxzero/pi-safe-search) v1.4.0 (npm
`pi-safe-search@1.4.0`, tarball integrity
`sha512-FD2rCUt2z386byxR50J7CaCFIYKN64Looky5tA7uhnPuJTn+GvOsxUvFHT8ZAqtl5JGMZE4dfVm4DuRfdZCfAw==`),
which is MIT-licensed per its `package.json` (`"license": "MIT"`; the upstream tree carries no
LICENSE file, so the permission text is reproduced in `LICENSE-MIT` beside this file).

| our file | upstream file | changes |
|---|---|---|
| `sanitize.ts` | `extensions/sanitize.ts` | none — byte-identical |
| `fetch.ts` | `extensions/fetch.ts` | **two local changes, both marked `// local:` in the file**: (1) the `User-Agent` names this package, not the one it was copied from — a request should not claim to be a different extension; (2) the 8 000-character cap is **stated** rather than silent (`[truncated at 8000 of 21999 characters …]`), because a reader handed an 8 KB prefix with no marker answers confidently from the top of the page. Measured: MDN and svelte.dev both came back as exactly 8 255 characters |
| `duckduckgo.ts` | `extensions/search.ts` | **one local change, marked `// local:`**: a bot check is a *failure*, not an empty web. DuckDuckGo answers a challenged client with HTTP 202 and an anomaly page, and 202 passes `res.ok`, so the parse found no anchors and the footer said `nothing found: duckduckgo` — on the one source the shipped default enables. It now throws a named error (measured 2026-11-15). Otherwise byte-identical, renamed |

**Why copies and not a dependency.** Node refuses to strip TypeScript types for files under
`node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a test in this repo cannot import
the package's `.ts` files at all — only the running extension can, through pi's jiti. Lifted copies
are covered by `npm test`; imported ones would be covered by nothing.

**Re-diffing after an upstream release** (the only mechanism there is — we do not inherit fixes):

```bash
cd <a temp dir> && npm pack pi-safe-search@<version> && tar xf pi-safe-search-*.tgz
diff -u package/extensions/sanitize.ts vendor/sanitize.ts
diff -u package/extensions/fetch.ts    vendor/fetch.ts
diff -u package/extensions/search.ts   vendor/duckduckgo.ts
```

A diff is a decision, not an update: `test/web-safety.test.mjs` names what the sanitiser and the
SSRF guard must keep doing, so a change that drops a stage fails here rather than quietly weakening
what the tool returns.

**The three local changes are not upstream's.** A re-diff will show them and they are expected to show:
take upstream's version of everything else, re-apply the `User-Agent` line and the truncation marker, and
the challenge check in `duckduckgo.ts`. Two tests are what stop them being dropped silently, which is the
failure they were written for: `test/web-safety.test.mjs` for the marker, and
`test/web-sources.test.mjs` for the challenge.

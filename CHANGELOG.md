# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), where in `0.x` a minor is what a breaking
change rides on.

## [0.1.0] - 2026-11-15

First release.

### Added

- **`web_search`** asks several independent indexes in parallel and merges the answers with weighted
  reciprocal rank fusion, per-source attribution, URL canonicalisation, content-aware dedupe, a diversity
  quota, an ad filter and ISO-or-nothing dates. Every hit names the indexes that returned it, and the
  footer names what answered, what found nothing, what failed and what was never asked.
- **Routing and query shaping.** A source declares a role (`web`, `reference`, `papers`, `discussion` or
  `code`), and a role is asked only when the question earned it. Each index then gets the query form it
  matches: arXiv `all:"…"`, Algolia three keywords, MediaWiki the noun phrase, Stack Exchange the literal
  error. The footer prints `asked:` whenever an index was given something other than the question.
- **Sources as configuration.** `json`, `rss` and `atom` templates, typed POST bodies, dot paths for
  items, keys sent as a header, per-source `priority` and `weight`, and load-time validation that names
  the entry it refuses. Ships DuckDuckGo, Wikipedia, Hacker News, Stack Exchange, arXiv, Marginalia, Brave and
  Tavily.
- **Profiles.** `$WEB_SEARCH_PROFILE`, then `.pi/pi-multi-search.json` in the project, then
  `~/.pi/agent/pi-multi-search.json`, then the shipped default, merged by source id and then by field. `tools`
  switches let a profile hand out search without the reader.
- **Keys from files, not from `export`.** The process environment, the profile's `envFile`, `./.env` and
  `~/.pi/agent/pi-multi-search.env` are all read. No value is ever logged, only names an enabled source
  declares are reported, and a key file that is too open gets a `chmod 600` warning naming the fix.
- **`web_fetch`** is SSRF-checked: private, loopback and link-local ranges and dangerous ports are
  refused, every redirect is re-validated, the body is capped at 2 MB, and output is cut at 8 000
  characters with a marker saying how many it hid.
- **Everything returned is sanitised.** Unicode and homoglyph folding, zero-width removal, entity
  decoding, base64 redaction, 28 injection patterns, and a random fence delimiter per call.
- **One keyless source in the shipped default:** DuckDuckGo. Every other index is defined, tested and
  switched off with a `$why` saying what turning it on buys. A key set for a source you left off is
  reported in the footer rather than ignored.
- **`scripts/soak.mjs`** drives the shipped tools against real indexes and real pages, and prints what a
  model would read. It is the only check that sees whether an index that was planned reached the answer.
- **61 tests, no network**, covering merging, routing, sources, profiles, keys, safety and the extension
  end to end with `fetch` stubbed.

### Known gaps

- **A client-rendered page comes back thin rather than failed.** `excalidraw.com` returns 79 characters and
  `reddit.com` 49. A reader chain (plain, then jina, then playwright) is the designed answer and is not
  built.
- **A code question without error vocabulary goes to the web engines.** `svelte 5 runes $state not
  updating` returns Reddit threads rather than Stack Overflow, because the `CODE` signal keys on error
  shapes and tool commands rather than framework names.
- **Nothing tests whether an index is reachable today, or whether its ranking is any good.** The footer
  reports what happened on the call you made, and the soak is for when that matters.

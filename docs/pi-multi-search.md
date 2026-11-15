# pi-multi-search: the reference

Everything about this extension and its two tools, `web_search` and `web_fetch`: the contract, how a
question becomes a set of queries, how the results are merged, what each config key does, what is safe
and what is not, and how to add an index.

**Reference, not prompt context.** For whoever maintains or extends the extension. A runtime that
injects a context file (`AGENTS.md` and the like) should not point at anything in `docs/`.

---

## 1. What it is

Two tools, no dependency on a host runtime. Pi discovers the extension from the `pi` manifest in
`package.json`; a host that scopes resource loading can allow the same file by path.

```
src/index.ts        the two tools and the two pi hooks
src/profiles.mjs    which profile, merged and validated
src/route.mjs       which roles a question wants, and the query form each index is asked in   (pure)
src/sources.mjs     the built-ins, the declarative engine, key resolution, the fan-out        (pure + fetch)
src/merge.mjs       canonical URL, dedupe, ads, RRF, quota, rendering                         (pure)
profiles/*.json     the indexes and policy: default.json (ships), cli.json (a terminal session)
vendor/             lifted from pi-safe-search v1.4.0 (one line changed: the UA) — THIRD-PARTY.md
  sanitize.ts         8-stage pipeline + random fence
  fetch.ts            safeFetch: SSRF block, redirect re-validation, caps
  duckduckgo.ts       the DuckDuckGo HTML parser
```

`src/index.ts` is the only file that knows what a tool is; `route.mjs` and `merge.mjs` import nothing
from `pi` and touch no network, which is what makes them testable in milliseconds.

**One engine, many purposes.** A long-running agent, a terminal session and a research-heavy project
differ in *which* indexes answer and how deeply — that is a profile (§5.5), never a copy of the engine.
The merge, the routing rules and the sanitiser are one implementation on purpose: a divergence there is
a bug, not a preference.

---

## 2. The tool contract

### `web_search`

| parameter | type | default | notes |
|---|---|---|---|
| `query` | string | — | required |
| `max_results` | number | 8 | clamped to 1..20; this is the **merged** budget, not per index |
| `sources` | string[] | all enabled | explicit ids; the caller's order is kept, and shaping still applies |

Returns one text block, fenced by `wrapUntrusted` (a random 32-char delimiter per call), plus
`details`:

```js
{ results, answered, empty, failed, roles, plan, skipped }
```

- `results` — merged hits: `{ url, title, snippet, date, sources[], score }`.
- `answered` / `empty` / `failed` — per source id; `failed` entries are `{ id, error }`.
- `roles` — the roles routing chose (`['web','reference']`, or `['explicit']` for a named list).
- `plan` — `[{ id, role, query, why }]`: **what each index was actually asked**.
- `skipped` — `[{ id, why }]` for a configured source that could not run (missing key).

The rendered body looks like:

```
1. Title (2026-03-14) [brave, tavily]
   URL: https://example.com/page
   one-line snippet, at most 240 characters

8 of 23 merged result(s) shown; 5 source(s) asked.
answered: brave, tavily, wikipedia; nothing found: arxiv; failed: stackexchange (HTTP 502)
asked: arxiv all:"prompt injection defences" · hackernews "prompt injection"
not asked: tavily (TAVILY_API_KEY is not set)
```

Every line after the results is a different fact, and none of them is optional: a list that is short
because three indexes were never asked must say so. `asked:` appears only when a source was given
something other than the question, so a shaped query is visible rather than mysterious — and a shaped
query that already carries quotes is printed once, not wrapped in a second pair.

### `web_fetch`

| parameter | type | notes |
|---|---|---|
| `url` | string | http/https only |

Returns the page as text (title, `Source:` line and body for HTML), fenced the same way. A refusal or
failure comes back as `web tool error: <sentence>` with `isError: true` — an error is a sentence the
model reads, never a thrown turn, because a refused fetch must not end a wake.

### The two hooks

- `before_agent_start` — appends the untrusted-data sentence to the system prompt **every turn**. Same
  wording as upstream, deliberately: two copies worded differently are one more thing to compare.
- `tool_result` — a **fence check**, not a second scrub: if a `web_search`/`web_fetch` result arrives
  without our marker it is sanitised and fenced. Upstream re-sanitised everything here, which collapses
  whitespace and would flatten the numbered list into one paragraph.

---

## 3. How a question becomes a set of queries (`route.mjs`)

### 3.1 Roles

| signal (regex) | roles chosen |
|---|---|
| code: `error`, `exception`, `traceback`, `segfault`, `TypeError`, `undefined is not…`, `npm`/`pip`/`cargo`/`git push`…, a word ending `error`/`exception`, `foo()` | `code`, `web` |
| paper: `paper(s)`, `preprint`, `arxiv`, `corpus`, `dataset`, `benchmark`, `state of the art`, `et al`, `survey`, `study`, `theorem` | `papers`, `web` |
| definition: `what/who/which/when/where is/are/was/were`, `define`, `definition`, `meaning of` | `reference`, `web` |
| comparison: `vs`, `versus`, `alternative(s)`, `instead of`, `which is better`, `pros and cons`, `worth it`, `price`, `review(s)` | `web`, `discussion` |
| recency: `latest`, `news`, `recent`, `today`, `this week`, `just released`, `announced`, or any 19xx/20xx year | `web`, `discussion`, `reference` |
| none of the above | `web` |

Rules: **at most three roles**, `web` is always present (one general index keeps a narrow role from
being the only opinion), and one index per role is asked by default — lowest `priority` — so a keyed
index takes over from the keyless one and the keyless one answers when the key is missing.
`defaults.perRole: 2` asks the top two of each role, which is how Brave *and* Tavily both answer a web
question.

**A role is asked when the question earned it.** An unclassifiable question asks the general indexes
and nothing else. It used to also buy a `papers` and a `reference` query, and both measured as noise on
real searches: a shopping question returned condensed-matter papers and an encyclopedia page about a
film, and between them they took slots from the results the question was about. A specialised corpus with
a specialised query shape is worth a request only when there is something for it to match.

### 3.2 Query shaping, per role

`terms()` drops stopwords, document-type words and generic answer-shape nouns before anything is built:

- **stopwords** — `best`, `how`, `what`, `is`, `the`, `vs`, `which`… (a curated list)
- **document words** — `paper`, `papers`, `preprint`, `survey`, `study`, `studies`, `literature`,
  `arxiv`, `et`, `al`, `doi`, `pdf`
- **generic nouns** — `tool`, `tools`, `software`, `platform(s)`, `guide(s)`, `tips`, `tutorial(s)`,
  `examples`, `list(s)`, `roundup`, `overview`

| role | query the index receives | why — measured |
|---|---|---|
| `web` | the question, whitespace collapsed | DuckDuckGo/Brave/Tavily are lexical web indexes and want the sentence |
| `code` | the question verbatim, ≤120 chars | Stack Exchange matches the **symbol**; the sentence around it is what buries a good answer |
| `papers` | `all:"three topic words"` (no year) | arXiv treats bare words as an AND over field soup; its own UI sends a quoted phrase |
| `discussion` | three keywords | Algolia matches conjunctively: `nbHits: 0` for a nine-word query, 5 526 for its head words |
| `reference` | three keywords, year stripped | MediaWiki answered "Tool steel" for `content operations tools`; three words is what measured well |

`shape: "none"` opts a source out entirely. A source may also retry: `retryOnEmpty: true` re-asks with
the question's **core words** (`core()`, four topical tokens) when a shaped query came back empty —
last resort, not the mechanism.

---

## 4. How the answers are merged (`merge.mjs`)

1. **Canonicalise** each URL: http(s) only, fragment dropped, host lower-cased and `www.` stripped,
   root path kept as `/`, tracking parameters removed (`utm_*`, `fbclid`, `gclid`, `dclid`, `msclkid`,
   `mc_cid`, `mc_eid`, `igshid`, `si`, `ref`, `ref_src`, `source`). Surviving parameters keep their
   order, so the same URL always canonicalises to the same string.
2. **Drop non-results**: ads (see below), URLs over **300 chars** (a tracker, not a page), and any row
   with no usable URL.
3. **Dedupe within a source** — first occurrence wins, because a source's own order is its relevance
   order. (Measured: Hacker News returned one page at ranks 3–5 and RRF summed it to the top.)
4. **Score by weighted reciprocal rank fusion**: `score = Σ weight / (60 + rank)`, then
   `×(1 + 0.1 × (sources − 1))` for corroboration. `weight` (0..1, per source) is how much that
   index's ranking is trusted.
5. **Enforce diversity**: the first pass gives **every source that answered one slot**, in ranked
   order; the quota (`ceil(limit / 2)`) then decides the rest, and if the budget is still short the cap
   lifts rather than returning a thin list. The first pass is what makes a routed search work: with
   three sources and a budget of six the quota alone let two of them fill the list and the third — the
   role the question actually earned — contribute nothing.
6. **Render**, sorted by score then URL — sorted *again* after the two picking passes, because picking
   one-per-source first takes the rows out of score order and the list is a ranking.

**Ads are not results.** DuckDuckGo's HTML page puts sponsored links in the same `result__a` anchors as
organic ones, so the filter is by endpoint and parameter: `duckduckgo.com/y.js`, `bing.com/aclick`,
`google.com/aclk`, `googleadservices.com`, `doubleclick.net`, `adservice.google.com`, or any URL
carrying `ad_domain` / `ad_provider`.

**Dates are ISO or nothing.** Brave reports `age` as prose ("July 14, 2026") beside an ISO `page_age`;
only a string starting `YYYY-MM-DD` is kept, which is what stopped results reading `(July 14, 2`.

---

## 5. Sources (`profiles/default.json`)

### 5.1 Built-ins (no `kind`)

| id | what it asks | role |
|---|---|---|
| `duckduckgo` | `html.duckduckgo.com/html/` — keyless, HTML | web |
| `wikipedia` | MediaWiki `list=search` — keyless, JSON | reference |
| `hackernews` | Algolia `/search` — keyless, JSON. Tries a **title-restricted** query first, broadens only when that is empty | discussion |
| `stackexchange` | Stack Exchange 2.3 `search/advanced` (site: stackoverflow) — keyless, JSON | code |

### 5.2 Every key a declarative source may carry

| key | applies to | meaning |
|---|---|---|
| `enabled` | all | `false` keeps the entry as a note without asking it |
| `role` | all | `web` \| `reference` \| `papers` \| `discussion` \| `code` (default `web`) |
| `priority` | all | lower wins within a role (default 100) |
| `weight` | all | 0..1, how much its ranking is trusted (default 1) |
| `limit` | all | results to ask for (default `defaults.limit`) |
| `retryOnEmpty` | all | retry once with the question's core words when empty |
| `shape` | all | `"none"` disables query shaping for this source |
| `kind` | declarative | `json` \| `rss` \| `atom` |
| `url` | declarative | template; `{query}` and `{limit}`; **http(s) only** |
| `method` | json | `POST` to send a body (default GET) |
| `body` | json + POST | object, templated like the URL; `"{limit}"` becomes a **number** |
| `items` | json | dot path to the array of results |
| `title` / `link` / `snippet` / `date` | json | dot paths into a result; `a\|b` means "this, else that" |
| `key` | all | the **name** of an environment variable (never a literal) |
| `keyHeader` | all | header to send the key in (default `Authorization: Bearer <key>`) |

`defaults`: `{ limit: 5, timeoutMs: 2500, perRole: 2 }`.

Validation happens **at load**, by name: an unknown id with no `kind`, a `json` entry with no `items`,
a template that is not http(s), a `{query}` in neither URL nor body on a POST source, a `body` without
`POST`, an unknown `method`, or a `key` that is not an environment-variable name. A bad entry stops the
extension loading (`[agent] extension error: …` in the journal) rather than quietly returning nothing
forever.

### 5.3 Adding an index, start to finish

**(a) A keyed JSON API (Brave's shape)** — no code:

```json
"brave": {
  "enabled": true, "role": "web", "priority": 10, "weight": 1.0,
  "kind": "json",
  "url": "https://api.search.brave.com/res/v1/web/search?q={query}&count={limit}",
  "key": "BRAVE_API_KEY", "keyHeader": "X-Subscription-Token",
  "items": "web.results", "title": "title", "link": "url",
  "snippet": "description", "date": "page_age|age"
}
```

**(b) A POST API (Tavily's shape)** — the query may live in the body:

```json
"tavily": {
  "role": "web", "priority": 20, "weight": 0.9, "kind": "json", "method": "POST",
  "url": "https://api.tavily.com/search",
  "body": { "query": "{query}", "max_results": "{limit}", "search_depth": "basic" },
  "key": "TAVILY_API_KEY",
  "items": "results", "title": "title", "link": "url", "snippet": "content"
}
```

**(c) A feed** — arXiv already ships this way, which is how the declarative path is exercised by a
real source and not only by a fixture:

```json
"arxiv": {
  "role": "papers", "limit": 3, "kind": "atom",
  "url": "https://export.arxiv.org/api/query?search_query={query}&max_results={limit}"
}
```

**(d) Then:** put the key (if any) where **the process that runs the model** reads its environment — a
runtime's `EnvironmentFile`, or your shell for a terminal session — and restart it if it reads the file
at startup. Then search something: `asked:` in the footer shows the index, and `answered:` names it.

### 5.4 Which env variables it reads

| variable | used by |
|---|---|
| `BRAVE_API_KEY` | the `brave` source (header `X-Subscription-Token`) |
| `TAVILY_API_KEY` | the `tavily` source (Bearer) |

**Where a key comes from, in order** (`src/keys.mjs`). **Every file is read, not just the first one
found** — a Brave key in the machine-wide file and a Tavily key in a project's `.env` both work:

1. the **process environment** — a unit's `EnvironmentFile`, a test, a one-off `KEY=… pi`. It wins,
   because an explicit override must beat a file;
2. **`envFile`** from the profile — absolute, or relative to the profile's own directory;
3. **`./.env`** in the working directory — **the file people already keep.** An extension that only read
   `pi-multi-search.env` made every reader learn a second convention to do the same job, which is a setup
   step nobody wants. A project's `.env` is the natural place to put a search provider's key;
4. **`<agentDir>/pi-multi-search.env`** — `~/.pi/agent/pi-multi-search.env` by default, beside `settings.json`.

```bash
# either of these, or both
# ~/.pi/agent/pi-multi-search.env      chmod 600
# <project>/.env
BRAVE_API_KEY=your-brave-key
TAVILY_API_KEY=your-tavily-key
```

`KEY=value` lines, `#` comments, blank lines, a pasted `export ` prefix and surrounding quotes are all
accepted. **Only names are ever logged**, and only names an **enabled source declares** — a `.env` full
of a host application's other secrets must not have its variable names echoed into a tool result a model
reads. `details.keys` reports the paths, the names used, and a warning if a file is group/world readable
(with the `chmod 600` to fix it).

Two silences are closed on purpose:

- **a key in a place nothing reads** is visible in the answer rather than in a mystery — measured
  2026-11-14, when a key pasted into the wrong repo's `.env` was read by nothing and the footer said so;
- **a key for a source that is switched off** is reported, not ignored:
  `not asked: brave (BRAVE_API_KEY is set, but this source is disabled in the profile)`. With one index
  enabled in the shipped default, that is the difference between "I added a key and nothing happened"
  and a sentence telling you the next line to change.

---

## 5.5 Profiles

```js
loadProfile({ env, cwd, agentDir })
// → { path, from, tools, defaults, sources, layers }
```

| where | from | who writes it |
|---|---|---|
| `$WEB_SEARCH_PROFILE` | `WEB_SEARCH_PROFILE` / `WEB_SEARCH_PROFILE (name)` | a unit, a shell, a test |
| `<cwd>/.pi/pi-multi-search.json` | `project (.pi/pi-multi-search.json)` | the project, committed |
| `~/.pi/agent/pi-multi-search.json` | `user (~/.pi/agent/pi-multi-search.json)` | the person |
| `profiles/default.json` | `shipped default` | this package |

**The shipped default enables exactly one source — `duckduckgo`, free and keyless** — because a package
someone just installed must answer without an account or a config file; every other entry is defined
and switched off with a `$why`, and `profiles/cli.json` is the worked example of all of them enabled.

The chosen file is **merged over the default**: `defaults` and `tools` key by key, `sources` **by id
and then by field** — an entry names only what it changes, so `{"sources": {"arxiv": {"weight": 1.0}}}`
moves the weight and keeps the `kind`, `url` and everything else the base declared. Replacing the whole
entry was the first behaviour and it failed in the worst way: the overlay produced a source with no
`kind`, and the refusal read `no built-in by that name, and no kind` — naming a problem the author did
not cause. Validation happens at load and names the offender: an unknown tool, a non-boolean switch, a
`maxResults` outside 1..20, or a source entry that fails its own rules (§5.2).

`tools: { "web_fetch": false }` is how a profile hands out a search-only extension — the tool is never
registered, so the model cannot see it at all. `details.profile` in a search result names the file that
was in force, so "why did this session ask arXiv" is a path, not a guess.

## 6. `web_fetch` and what it refuses

`safeFetch` (lifted, unchanged) refuses before it opens anything:

- schemes other than `http`/`https` (`file:`, `ftp:`…), URLs over 2 048 chars, control characters;
- hostnames resolving into `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
  `169.254.0.0/16`, `192.0.0.0/24`, multicast and reserved ranges, and IPv6 `::1` / `fd…` / `fe80…`;
- ports 21, 22, 23, 25, 53, 110, 143, 389, 445, 3306, 5432, 5900, 6379, 8080, 8443, 9200, 27017;
- content types other than text/HTML/JSON/XML/markdown; bodies over 2 MB (it stops reading) and it
  returns at most 8 000 characters to the model — **and says so** when it cuts
  (`[truncated at 8000 of 41 220 characters — fetch a narrower URL for the rest]`). The cap used to be
  silent, which meant a model read the top of a long page and could not tell: measured, MDN and
  svelte.dev both came back as exactly 8 255 characters;
- redirects are followed **manually**, at most 5, re-validated at every hop — so a redirect cannot
  walk around the private-range block.

HTML is reduced to a title line, `Source: <url>` and text; everything else is sanitised directly.

---

## 7. The sanitiser, and why it is a copy

`vendor/sanitize.ts` runs eight stages: NFKC normalisation → homoglyph folding (Cyrillic/Greek) →
zero-width removal → control-character strip → HTML entity decode **then** tag strip → URL decode →
base64-blob redaction → **30** injection-pattern redactions across six categories (override directives,
role hijacking, system-prompt extraction, mode switching, authority masking, urgency/compulsion). The
result is fenced by `wrapUntrusted()` with a fresh 32-character token per call, so a page cannot guess
the delimiter and close the fence itself.

**It is a copy of `pi-safe-search` v1.4.0 — one line differs, the `User-Agent` — and the copy is deliberate.** Node refuses to
strip TypeScript types under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a test in
this repo cannot import the package's `.ts` files at all — only the running extension can, through
jiti. Lifted copies are covered by `npm test`; a dependency would be covered by nothing. Provenance,
the licence, and the re-diff procedure are in `vendor/THIRD-PARTY.md`.

**The cost of the copy:** upstream fixes are not inherited. Re-diff when bumping anything, and treat a
diff as a decision — `test/web-safety.test.mjs` names what must keep working.

---

## 8. Tests

`npm test` runs everything; 61 checks, milliseconds, no socket and no model.

| file | checks | holds |
|---|---|---|
| `test/search-shape.test.mjs` | 4 | **the seam**: what a routed search *plans* for the shapes real questions have, and that every index it planned reaches the answer — the two defects a real search found lived here and neither half's own tests could see them |
| `test/web-merge.test.mjs` | 14 | canonical URLs, snippet cap, per-source dedupe, RRF order, weights, the quota and the three-source budget, ads, dates, footer grammar |
| `test/web-route.test.mjs` | 6 | classification, role choice (including that a question earns its specialists), per-role shaping, one-per-role by priority, explicit `sources` |
| `test/web-safety.test.mjs` | 6 | a redacted override, homoglyph + zero-width, markup/entities, fence randomness, six SSRF refusals, and that a capped page says it was capped |
| `test/web-sources.test.mjs` | 13 | template expansion, JSON/feed parsers, POST bodies, key resolution, config refusals, the user agent, a bot challenge reported as a failure |
| `test/index.test.mjs` | 4 | the extension end to end with `fetch` stubbed: fencing, `[source]` tags, `asked:`, an injection redacted, no key value anywhere, a disabled tool not registered |
| `test/http.test.mjs` | 4 | a 429 is one bounded retry, a hanging index times out, `retryOnEmpty` narrows and records it, a bad status is a named error |
| `test/keys.test.mjs` | 5 | the key files: parse, mode warning, `./.env` + `pi-multi-search.env` together, precedence, which names came from where, no value ever printed |
| `test/profiles.test.mjs` | 5 | resolution order, merge by id **and by field**, validation at load, every shipped profile |

The live behaviour no test covers: whether an index is *reachable* today, and whether its ranking is
any good. That is what `answered:`/`failed:` in a real footer is for.

**Why `search-shape` exists at all** — the honest post-mortem, because "add a test" is not the lesson.
Routing and merging were each well covered and both real defects lived *between* them. Routing was
tested with `chooseRoles('content operations')` asserting three roles, which **enshrined the fallback**
rather than questioning it: a green test that agrees with the bug is worse than no test, because it is
a written claim that the behaviour is intended. Merging was tested with one and two answering sources
in every fixture (the three-source case appeared once, as one answered / one errored / one found
nothing), so the quota was proved on a two-source machine while `perRole: 2` plus one routed role
always produces three. The test that catches both is the one nobody writes: compose the two halves and
assert a **property** — "an index whose role the question did not earn is not asked", "an index the
planner chose appears in the list" — because a property survives a change of roles and weights while a
snapshot of the plan does not.

---

## 9. Troubleshooting

| symptom | meaning |
|---|---|
| `not asked: brave (BRAVE_API_KEY is not set)` | the process does not have the variable — check where *it* reads the environment (a unit's `EnvironmentFile`, or the shell) and restart it |
| `failed: tavily (HTTP 401)` | the key is present and wrong, or the account is not entitled |
| `failed: brave (HTTP 429)` | rate limit survived the built-in retry (1 s, honouring `retry-after` up to 3 s) — Brave's free plan is one request per second |
| `nothing found: arxiv` | the shaped query matched nothing; `asked:` shows what it looked for |
| `failed: x (page parsed to 0 rows)` **not implemented yet** | a scraper whose markup moved — see §11 |
| `[agent] extension error: … source "x": …` | `profiles/default.json` failed validation; the message names the entry |
| results look irrelevant | the footer's `asked:` line: shaping may be sending too much. Narrow with `sources: ["arxiv"]`, or give the source `shape: "none"` |

To see what a profile resolves to **in the environment a service uses**, without printing a key:

```bash
systemd-run --user --pipe --wait -q \
  -p EnvironmentFile=<the service's env file> \
  -p WorkingDirectory=$(pwd) \
  node --input-type=module -e "
    const { loadProfile } = await import('./src/profiles.mjs');
    const { resolveSources } = await import('./src/sources.mjs');
    const profile = loadProfile({ agentDir: null });
    console.log(profile.from);
    console.log(resolveSources(profile).available.map(s => s.id).join(','));
  "
```

In an ordinary terminal the same two lines work with no `systemd-run` at all.

---

## 10. Limits, stated plainly

- **No answer synthesis.** It returns results, not a summary — a summary is somebody's opinion of the
  sources, and the rule is that figures come from a place you can name.
- **A bot check is a failure, not an empty web.** DuckDuckGo answers a client it has seen too much of
  with HTTP 202 and an anomaly page; a parser that only counted result anchors reported
  `nothing found: duckduckgo`, which reads as "nobody has this" when the truth is "we were refused".
  It raises a named error now, so the footer says `failed:` with a reason worth retrying. Measured
  2026-11-15, on the one source the shipped default enables — which is also the argument for a profile
  with a second index on it.
- **JavaScript pages come back thin, not failed.** `web_fetch` returns 200 and a shell of text for a
  client-rendered page. See §11 for the agreed ladder.
- **Index ranking is what it is.** MediaWiki and Algolia both answered badly for
  `content operations tools` before shaping was tightened; a generic third word still lets noise in,
  which is why `weight` exists and why RRF needs corroboration to rank something first.
- **Quota is real.** `perRole: 2` means a generic question asks four indexes (two web + one or two
  topical). Brave free is 2 000/month, Tavily's `basic` depth is 1 credit per search.
- **No project awareness.** A search is a search; it knows nothing about the code or data you are
  working in.

---

## 11. Deferred designs (agreed, not built)

- **Rendered fetching**, cheapest first: (1) treat an extraction under ~400 chars as a failure and try
  browser-shaped `Accept`/`Accept-Language`/UA headers — `pi-web-access` measured browser-like headers
  taking 18 → 31 readable pages of 68; (2) a **reader chain** in `web_fetch`
  (`["plain", "jina"]`, Jina Reader renders server-side and needs no key, but discloses the URL to a
  third party, so off unless configured); (3) Playwright as one more entry in that chain. The browsers
  are already on this box (`~/.cache/ms-playwright/chromium-1248`, `/usr/bin/chromium`), so the cost is
  the policy, not the launch: `validateUrl` is private inside the lifted `vendor/fetch.ts`, and a
  browser follows redirects itself — SSRF must be exported from that one place, never re-implemented
  beside it.
- **Site-specific scrapers**, because a source is already `{id, role, weight, query shape, fetch+parse}`:
  `kind: "html"` in `profiles/default.json` (template + `item`/`title`/`link`/`snippet` selectors) for the
  ordinary case, `sources/<id>.mjs` for the rest. Three rules are the design — **`expect: { min }`**, so
  a scraper that parses zero rows from a 200 is a named failure and never "nothing found"; a `verify`
  script that runs every source live and prints a row count; and a saved fixture per scraper, because
  nothing else notices. Authoring aid: `tools/inspect.mjs <url>` printing repeated element shapes
  rather than a wall of HTML. Boundaries: a source with an API is not scraped (record `"$why"` when
  there is none, as the disabled `marginalia` entry does), and **the tool cannot install a scraper** —
  authoring is a repo task with a fixture and a test.

---

## 12. Why not just install one (the catalog survey, 2026-11-14)

`pi.dev/packages` was read, plus npm's search API on `keywords:pi-package web-search`, and every
candidate's README. **One package does fusion and the rest are fallback chains:**

| package | reach | shape |
|---|---|---|
| **`pi-search-hub`** v2.8.0 | 405/mo, 52★, 25 open issues, last push 2026-07-24 | 19 backends; `combine=true` queries all enabled backends in parallel with RRF and per-backend attribution; `web_read` with 5 readers |
| `pi-web-access` v0.47.0 | 1.3M/mo, 48 dependents | 30+ providers, self-hosted SearXNG, Crawl4AI, video/PDF, an MCP server — but *falls through* to the next provider rather than merging |
| `pi-web-search` v1.7.0 | 85K/mo | provider-native search (Gemini + URL Context, xAI) — the previous name of **this** package; note `pi-multi-search` itself is free on npm (checked 2026-11-15), which is why the rename was possible |
| `@juicesharp/rpiv-web-tools` v2.15.0 | 12.4K/mo | pluggable providers, one active |
| `@ollama/pi-multi-search` v0.0.5 | 11.7K/mo | Ollama's own search API, tool names that do not collide |
| `pi-lynx` v1.1.5 | 145/mo | seven tools over corpora (GitHub, Wikipedia, Reddit), `lynx`-scraped |
| `pi-multi-search-lite` v0.13.1 | 3.2K/mo | one provider + a fetch chain |
| `@nijaru/pi-search` v0.0.12 | 1.8K/mo | provider-neutral evidence, budgeted `web_research`; "no retry loops or provider fan-out" |
| `pi-safe-search` v1.4.0 | — | the sanitiser and the SSRF reader this extension lifts |

**Why `pi-search-hub` was not installed.** It is the only package that fuses, and it is small and
young: one author, three months since the last push, 25 open issues. It carries `wreq-js` — a Rust HTTP
client whose stated purpose is browser TLS-fingerprint impersonation *to bypass anti-bot detection* —
and a `ddgs` Python package, so DuckDuckGo arrives as a second runtime inside an agent that runs
unattended on a schedule. Its `web_read` fetches through Jina/Firecrawl/Sofya (a third party
receives the URL) and implements no private-range block. So the *idea* was taken — parallel fan-out,
RRF, content-aware dedupe, per-source attribution — and the dependency was not.

Two things worth remembering from the survey: **SearXNG** is the off-the-shelf path to many engines at
once (one endpoint, ~70 engines, no per-source provenance, no custom sources), and `@nijaru`'s
`web_research` — a budgeted sequential search-and-fetch — is the shape a research tool wants rather
than one more `web_search`.

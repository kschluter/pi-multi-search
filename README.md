# pi-multi-search

Two tools for Pi. `web_search` asks several search indexes at once and merges the answers into one ranked
list, with every result naming the indexes that returned it. `web_fetch` reads a page as text, with the
checks a reader needs before that text reaches a model.

It needs no account and no key: DuckDuckGo is the index enabled by default.

## Installation

```bash
pi install npm:pi-multi-search        # for you, in every session
pi install -l npm:pi-multi-search     # this project only, in .pi/settings.json
```

Commit `.pi/settings.json` and everyone working in the repo gets the extension. Pi loads it once project
trust is granted.

To try it without touching settings, `pi -e npm:pi-multi-search` loads it for one run.

`pi list` shows what is installed, `pi remove npm:pi-multi-search` takes it away (add `-l` for a project
install), and `pi update --extensions` follows new releases. Install without `@version` to get those
updates: a pinned spec, such as `npm:pi-multi-search@0.1.0`, stays where you put it.

## Turn on more indexes

Each index is a line in a profile of your own. Never edit the installed package:

```json
{
  "sources": {
    "brave": { "enabled": true },
    "stackexchange": { "enabled": true }
  }
}
```

Save that as `~/.pi/agent/pi-multi-search.json` for every project, or `.pi/pi-multi-search.json` for one project, or
point `$WEB_SEARCH_PROFILE` at it. `{ "enabled": true }` is all it takes, because role, URL, weight and
headers come from the shipped definition: profiles merge by source id and then by field. `"enabled": false`
turns a default off.

| index | what it searches | key |
|---|---|---|
| `duckduckgo` | the general web, on by default | none |
| `wikipedia` | reference and definitions | none |
| `stackexchange` | programming questions and answers | none |
| `arxiv` | papers | none |
| `hackernews` | discussion and recency | none |
| `marginalia` | small independent sites | none, and its shape is not stable |
| `brave` | the general web, 2 000 searches a month free | `BRAVE_API_KEY` |
| `tavily` | the general web, built for AI agents | `TAVILY_API_KEY` |

`profiles/cli.json` in the package is a worked example with every index on.

### Add an index of your own

Any endpoint that returns JSON, or a feed, can be a source. Define it in your profile and it sits beside
the built-in ones:

```json
{
  "sources": {
    "mywiki": {
      "kind": "json",
      "url": "https://wiki.example/api/search?q={query}&limit={limit}",
      "items": "data.results",
      "title": "name",
      "link": "url",
      "snippet": "summary",
      "role": "reference",
      "weight": 1,
      "enabled": true
    }
  }
}
```

`items`, `title`, `link` and `snippet` are dot paths into one result. `role` is one of `web`, `reference`,
`papers`, `discussion` or `code`. `kind` is `json`, `rss` or `atom`. A POST endpoint takes
`"method": "POST"` and a `body` whose values use the same `{query}` and `{limit}` placeholders.

## Keys come from files

A Pi session is not a login shell, so `export` does nothing for it. Keys are read from files, and all four
layers are read, not just the first that exists:

| where | when |
|---|---|
| the process environment | a unit's `EnvironmentFile`, or a single run |
| `./.env` | the project's keys, the file people already keep |
| `~/.pi/agent/pi-multi-search.env` | machine-wide, beside `settings.json` |
| the profile's `"envFile"` | somewhere deliberate |

```bash
# in any of those files
BRAVE_API_KEY=…
TAVILY_API_KEY=…
```

A key is never printed or logged. A key you set for a source you left switched off shows up in the footer
instead of being ignored in silence.

Every key, every source field, the query shaping, and the measurements behind the weights are in
[docs/pi-multi-search.md](docs/pi-multi-search.md).

## What an answer looks like

```
1. TypeError: "x" is not a function [brave, tavily]
   URL: https://developer.mozilla.org/...
   what the page says, in one line, at most 240 characters
2. Why am I getting "TypeError: x.map is not a function" in React? [stackexchange]
   URL: https://stackoverflow.com/questions/...

8 of 13 merged result(s) shown; 3 source(s) asked.
answered: stackexchange, brave, tavily
```

Both web engines returned the MDN page, so it is one row credited to both, and it ranks above either
engine's own second result. The question's shape is what earned it the `code` index. The footer is the
part that makes the answer checkable: it names every index that answered, and any that was asked and came
back empty.

## Why merge instead of fall back

Most search extensions chain providers: one answers, and the next is tried only if it fails. You get
whichever index happened to be first, with no sign that another disagreed.

This one asks the indexes a question deserves, in parallel, each in the query form its own engine expects,
and fuses the rankings with weighted reciprocal rank fusion. A page two indexes agree on outranks a page
one index ranked first, and the output shows its work.

| | |
|---|---|
| [`pi-search-hub`](https://www.npmjs.com/package/pi-search-hub) | The prior art for parallel fan-out, RRF and per-source attribution, and the reason this exists. Re-implemented rather than forked: no Rust fingerprint client, no Python runtime in the agent loop, a private-range guard on the reader, and one keyless index on by default. If its trade-offs suit you better, it is a good package. |
| `pi-web-access` | The widest reach, 30+ providers plus PDF and video. Falls through rather than merging. |
| `pi-safe-search` | Its sanitiser and SSRF-safe reader are vendored here, credited below. |

Merging costs N requests instead of one, and the default is two indexes per role so that a second opinion
is deliberate. The shipped default is one keyless index and costs nothing.

## Safety

- **`web_fetch` refuses to touch the machine it runs on.** Private, loopback and link-local ranges,
  dangerous ports, non-http(s) schemes, bodies over 2 MB, and redirects re-validated hop by hop.
- **Truncation is stated, not silent.** A cut page ends with
  `[truncated at 8000 of 41220 characters — fetch a narrower URL for the rest]`. A model handed a prefix
  with no marker answers confidently from the top of the page.
- **Everything is sanitised before it is returned.** Unicode and homoglyph folding, zero-width removal,
  entity decoding, base64 redaction, 28 injection patterns, and a fresh random fence delimiter per call, so
  a page cannot close the fence itself.

## Credits

This is built on good work, and says whose:

- **[`pi-search-hub`](https://www.npmjs.com/package/pi-search-hub)** for parallel fan-out with RRF and
  per-backend attribution, which is the design taken here. This is a single-process implementation with
  the dependencies dropped (no fingerprint-impersonating HTTP client, no Python, no third-party reader
  seeing every URL), a private-range guard, routing by question shape, per-index query shapes, and a
  zero-config default.
- **[`pi-safe-search`](https://github.com/sebaxzero/pi-safe-search)** for the sanitiser
  (`vendor/sanitize.ts`) and the SSRF-safe reader (`vendor/fetch.ts`), its v1.4.0 under MIT, vendored with
  local changes marked `// local:` and listed in `vendor/THIRD-PARTY.md`. Vendored rather than depended on
  because Node cannot type-strip inside `node_modules`, so a dependency could not be covered by this
  repo's tests.
- **`pi-web-access`**, **`@juicesharp/rpiv-web-tools`** and **`pi-multi-search-lite`** for the
  fallback-chain shape, and for the survey that showed it is the norm.
- **`@nijaru/pi-search`** for a budgeted sequential research loop: a better shape for deep research, and
  deliberately not what this is.
- **Cormack, Clarke and Büttcher**, *Reciprocal Rank Fusion outperforms Condorcet and individual rank
  learning methods* (SIGIR 2009) for weighted reciprocal rank fusion. The weights, the diversity quota and
  the corroboration bonus are ours, each with a measurement behind it in `docs/pi-multi-search.md`.

## Development

```bash
npm test                        # 61 checks, no network, about 2 s
node scripts/soak.mjs           # the paces: real indexes, real pages
node scripts/soak.mjs --reader  # the page reader: static, SPA, bot-walled, refusals
```

The suite stubs `fetch`, so routing, merging, profiles, keys and safety are covered without a socket. It
cannot tell you whether an index is reachable today or whether its ranking is any good. The footer and the
soak are for that.

## License

MIT. See [LICENSE](LICENSE).

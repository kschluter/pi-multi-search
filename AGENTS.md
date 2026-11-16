# AGENTS.md: pi-multi-search

Rules for working in this repository. The package is distributed through npm, so anyone can install it
and read the tarball without seeing this file. Every rule below exists because breaking it ships
something wrong to people who cannot ask us about it.

What it is: a Pi extension with two tools. `web_search` asks several independent indexes at once and
merges the answers with weighted reciprocal rank fusion, tagging each result with the index that returned
it. `web_fetch` reads one page through a vendored sanitiser that blocks private address ranges and strips
prompt injection. A router decides which roles a question needs (web, reference, papers, discussion,
code), and a profile decides which indexes answer and how many results each may return.

What it must never become:

- A model caller. `src/` holds no prompt, no classifier call, no summariser. It is HTTP, regexes and a
  merge. A model call would add latency and an API key to a tool that needs neither.
- A scraper. A source is an API (JSON), a feed (RSS or Atom), or one of the four built-in parsers. A site
  with no API gets a config entry whose `"$why"` says so, not a screen-scrape in code.
- A daemon. No background process, no cache on disk, no scheduler. Everything happens inside one tool
  call.
- A record of the author's machine. See "Nothing about the machine" below.

## The invariants

1. **Host packages are peers, never dependencies.** `typebox`, `@earendil-works/pi-ai`,
   `pi-agent-core`, `pi-coding-agent` and `pi-tui` all come from Pi. Declaring one in `dependencies`
   installs a second copy that bypasses Pi's extension module mapping: duplicate classes, two registries,
   and a warning on load. Declare it in `peerDependencies` with `"*"` and in `devDependencies`, so local
   tests import a real module.
2. **The shipped default enables one source, `duckduckgo`.** Free, no key, no account. Every other source
   is defined, tested, and set to `"enabled": false` with a `"$why"` saying what it is for. A fresh
   install has to answer with no key and no signup, since that is what makes the package usable by
   someone who has never heard of it.
3. **A source names a variable, never a value.** `"key": "BRAVE_API_KEY"` is a variable name. A key value
   never enters a profile, a row, a log, a result, a test fixture or a commit. The footer may say that a
   variable is missing or set. It never prints what the variable holds.
4. **Four key layers, in this order: process environment, the profile's `envFile`, `./.env`,
   `<agentDir>/pi-multi-search.env`.** `<agentDir>` is `$PI_CODING_AGENT_DIR` when set, otherwise
   `~/.pi/agent`. A deployment that redirects that variable reads none of the machine-wide file.
5. **Profiles merge, they never replace.** A profile merges over the shipped default by source id and
   then by field, so `{"wikipedia": {"enabled": true}}` changes one field of one source. An earlier
   version replaced the whole entry and silently dropped every field the profile did not repeat.
6. **Attribution is part of the answer.** Each result lists the indexes that returned it. The footer
   lists what answered, what found nothing, what failed, and what was never asked. A source that is
   enabled but cannot run (no key, or its key set while the profile disables it) appears in the footer,
   never as a silent absence. "I added a key and nothing happened" has to stay impossible.
7. **The sanitiser is a boundary, not a filter to loosen.** `vendor/fetch.ts` strips injection and
   refuses private, loopback and link-local targets. Do not weaken it to make a page parse.
   `test/web-safety.test.mjs` names what must keep happening.
8. **A bad config refuses by name.** An unknown key, a template with no `{query}`, a URL that is not
   http(s), a role that does not exist: each one throws with the entry's name and the reason. Returning
   nothing forever is the failure this rule prevents.
9. **`npm test` never touches the network.** Every source is proved against a fixture or a stub. The soak
   (`node scripts/soak.mjs`) is the manual tool that uses real sockets, keys and quota.
10. **Vendored files carry `// local:` on every local change.** `vendor/` is upstream's code (see
    `vendor/THIRD-PARTY.md`). A re-sync is a diff someone reviews, and those markers are what make it
    reviewable.

## The map

| file | what lives there |
|---|---|
| `src/index.ts` | the two tools, the sanitiser call at the boundary, and the `before_agent_start` note that puts the untrusted-data rule in the system prompt |
| `src/route.mjs` | the roles a question earns (regex signals to role list), and each index's query shape |
| `src/sources.mjs` | the four built-in parsers, JSON and feed parsing from a template, `resolveSources`, the user agent, retry on 429 |
| `src/merge.mjs` | weighted RRF, canonicalisation, dedupe, the diversity quota, the ad filter |
| `src/profiles.mjs` | resolution over four layers, merge over the default, validation |
| `src/keys.mjs` | the four key layers, names only, and the report of which file supplied what |
| `vendor/` | upstream's fetcher and DuckDuckGo parsers, with `// local:` markers |
| `profiles/default.json` | the shipped policy, and the only file most users read |
| `profiles/cli.json` | a worked example of a wide fan-out: two per role, keyed engines on |
| `test/` | 61 checks, no network, about 2 s |
| `scripts/soak.mjs` | manual: drives the shipped tools against real indexes; `--reader`, `--profile`, `--query … --render` |
| `docs/pi-multi-search.md` | the reference: every config key, every source, the measurements behind the weights |

## Changing things

**Add a source.** A JSON or feed endpoint is an entry in `profiles/default.json` (kind, URL template,
`items`/`title`/`link`/`snippet`/`date` dot paths, role, weight) plus a test in
`test/web-sources.test.mjs` using the shape the endpoint really returns. A source that needs code is a
parser in `src/sources.mjs` plus a built-in entry. Either way it ships `enabled: false` with a `$why`,
gets a row in the table in `docs/pi-multi-search.md`, and names its key's variable in that `$why` if it has
one.

**Add a routing signal.** A regex beside the others in `src/route.mjs`, a case in `chooseRoles`, and a
test in `test/web-route.test.mjs` that asserts the roles it produces and that a neighbouring question is
unaffected. Signals are ordered by precedence, so a new one needs an explicit place in the chain.

**Change a weight, priority or limit.** Measure first, then put the measurement in the test name or in
the doc. These numbers are not taste: `stackexchange` and `arxiv` sit at 1.0 because at 0.8 and 0.9 their
rank-1 result lost to a general engine's rank-3. A change with no measurement behind it is a claim, not a
fix.

**Change the default profile.** This is a minor bump. It changes results for everyone who never wrote a
profile, which is nearly everyone.

## Versioning

One question decides every bump: what breaks for someone who changed nothing?

| what changed | version | why |
|---|---|---|
| docs, comments, tests or CI, with no change in behaviour | no bump, no tag, no publish | nothing installed changes, and the fix rides the next real release, because a published version cannot be re-cut |
| a source that returned nothing, a URL that deduped wrong, a routing gap, a crash, a stale constant | patch, `0.1.x` | it makes existing behaviour correct |
| a new source, profile key, query shape or tool parameter | minor, `0.x.0` | new surface |
| any change to results with an unchanged config: routing, weights, merge, dedupe, defaults, sanitising, timeouts | minor, `0.x.0`, and the CHANGELOG says results change | in 0.x the minor is where breaking changes go, and a patch must never change behaviour |
| removing or renaming a profile key, a source id or a tool parameter | minor, `0.x.0`, plus `### Changed` or `### Removed` naming what a user must edit | this is what breaking means |
| `1.0.0` | a maintainer decision, never a quiet commit | it promises the profile format and both tool signatures are stable |

The version number is not a progress bar. A one-line fix is still a patch, and a one-line change that
alters results is still a minor.

## Releasing

The tag and `package.json`'s version are one fact and get created together. `npm install` resolves a git
spec from the remote, so the tag has to be pushed before anyone pins it.

```bash
# 1. Green, and looked at by a human where it matters.
npm test                       # 61 checks, no network
node scripts/soak.mjs          # manual: real indexes, needs keys and quota. Run it when a source or
                               # the routing changed, on whatever connection you have

# 2. Bump and write the entry in the same breath. `npm version` updates package.json and the lock.
npm version patch --no-git-tag-version     # or minor. The table above decides.
#   CHANGELOG.md: a new version heading at the top, dated from `date` and not from memory.

# 3. One commit, then the tag on that commit.
git add -A && git commit -m "…what changed and what it fixes…"
git tag -a vX.Y.Z -m "pi-multi-search X.Y.Z"

# 4. Push the branch, then the tag. Both, in this order.
git push origin HEAD
git push origin vX.Y.Z

# 5. Publish. `npm login` is a human step and is never scripted.
npm publish
```

Three things that have already cost time:

- **A tag is never moved.** npm caches by commit sha, so a re-pointed tag publishes nothing and nobody is
  told. A bad release is a new patch version.
- **If `npm publish` fails, retry the publish and do not re-tag.** The tag is already correct. Auth is the
  usual reason it failed.
- **`git push --tags` is not step 4.** It pushes whatever stale tags happen to exist. Push `vX.Y.Z` by
  name.

## The CHANGELOG

It is written for someone deciding whether to take the new version, not for us. That is the whole test: an
entry that describes how the bug was found, or what the author's machine did, tells an upgrading user
nothing.

- **Written in the same commit as the bump**, as step 2 says. A version's entry is frozen with its tag,
  so a wrong entry is corrected in the next version, not by editing the published one.
- **A bug fixed before the release is not an entry.** No user had it. Pre-release iteration is history
  and does not belong in the file, which is why the first release lists what 0.1.0 is and nothing about
  how it got there.
- **Only the headings that apply**, from Keep a Changelog: `Added`, `Changed`, `Fixed`, `Removed`. A
  rename or removal names what a user must edit, and a change to results with an unchanged config says so
  in the entry itself, not only in the version number.
- **Say what a user notices.** "An index is asked when its role was earned" is an entry. "Refactored
  routing" is not.
- **Known gaps belong in the release they are true of**, since they describe the code the reader just
  installed. Delete a gap in the version that closes it.

## `npm publish`, and the guard in front of it

`prepublishOnly` runs `scripts/prepublish.mjs`, so none of this is a step anyone has to remember. A
publish that would ship something untrue fails before the tarball is built:

| check | why it exists |
|---|---|
| no host package in `dependencies`, and every peer range is `*` | a physical copy bypasses Pi's module mapping |
| the working tree is committed | a publish from a dirty tree ships code no commit describes |
| `HEAD` is tagged `v<version from package.json>` | the tag and the version are one fact, and a version nobody can check out is not a release |
| the suite is green | stubbed `fetch`, about 2 s |
| the tarball holds no `test/`, `scripts/`, `node_modules/` or `AGENTS.md` | `files` is easy to widen by accident |
| no shipped file contains an absolute home path or a key | the tarball is what people download and read |

Run it by hand with `node scripts/prepublish.mjs`. It writes nothing outside a temp directory and never
publishes. `npm publish --dry-run` exercises the same path without publishing, which is the reason the
script clears `npm_config_dry_run` for its own child processes: a dry run passes that variable down, and
its own `npm pack` then builds nothing.

`npm login` is never scripted. It is a human step, and a token in a file is a credential this package does
not need.

```bash
npm test                                  # 61 checks
node scripts/prepublish.mjs               # the six checks above, by hand
npm publish                               # prepublishOnly runs them again, then builds the tarball
```

## Publishing when npm demands a second factor

An account with 2FA cannot `npm publish` from a CLI without either a granular token that **bypasses 2FA** or
a staged approval in the browser. Two things about that cost an hour and are worth knowing before the next
release:

- **A token made with "Read and write (stage only)" does not fail.** `npm publish` prints
  `+ pi-multi-search@0.1.0` and exits 0, the registry answers **202**, and it records version `0.0.0-stage`:
  a stub, 2 files, "Temporary package placeholder for staged publishing". It looks like a successful
  release and nothing is installable. Read the HTTP code in the debug log when a publish seems too easy.
  It is **201** for a real one.
- **A bypass-2FA token cannot unpublish.** The registry answers 403 ("Granular access tokens that bypass
  two-factor authentication may not perform this action"), so a placeholder like that is removed in the
  browser, not from the CLI.

The token line in `~/.npmrc` is `//registry.npmjs.org/:_authToken=npm_…`: two slashes, which scope the
credential to one registry, not a comment. Editing it by hand is how a token ends up pasted twice and
every publish answers 401; `npm config set` writes it correctly.

**From January 2027 npm disables bypass-2FA publishing.** The release path then becomes Trusted Publishing
from CI, or `npm stage publish` plus an approval in the browser. This section is what to rewrite when that
lands, and the tag and commit already pushed do not change.

## How people get it

`pi install npm:pi-multi-search` writes a declaration to their settings, and the tools then exist in every
session. `pi install -l npm:pi-multi-search` writes `.pi/settings.json` in a project, which is a file they
commit. The README covers both.

For this repository both forms mean the same thing: what people get is the tarball, which is `files` and
nothing else. A file outside `files` cannot be read by a user. A file inside it is public the moment it is
published.

## Nothing about the machine

This package is public. The repository and the tarball (which ships `src/`, `vendor/`, `profiles/`,
`docs/`, the README, the CHANGELOG and the LICENSE) must contain no evidence of where it was written:

- no names of private projects, deployments, units, services or repositories, and no paths to them;
- no `/home/...` or `~/...` paths except the ones a user is meant to use, such as
  `~/.pi/agent/pi-multi-search.env`;
- no real key, token, hostname, hostname-shaped fixture, or piece of someone's data in a test;
- no "the owner", "our system" or "the brain". Say the deployment, the agent, or the user.

The author's own handles (`author`, `homepage`, `repository`, `bugs`, and the user-agent URL) are the one
exception, because a package should name its maintainer. A comment that explains a bug by naming the
project it was found in is still a leak. Describe the shape of the bug instead.

## Traps already paid for

- **A routing fallback of `['web','reference','papers']` asked three indexes for every unclassifiable
  question**, and one of them returned condensed-matter papers because `Ca` matched a state abbreviation.
  No signal now means `['web']` only.
- **`what does X mean` was not a definition.** Only `what is X` was, so the encyclopedia was never asked
  for the more common phrasing.
- **The merge quota starved a third source.** A fixed per-source cap gave the first two every slot. The
  first pass now gives each answered source one slot, and the rest is sorted by score.
- **A profile merge replaced whole source entries**, dropping every field the profile did not repeat.
- **Wikipedia returned `?curid=` URLs**, so the same article never deduped across indexes.
- **A truncated page was cut at 8 000 characters with no word about it.** It now says
  `[truncated at 8000 of N …]`.
- **Weights of 0.8 and 0.9 for the specialist indexes lost their rank-1 to a general engine.**
- **`asked:` double-quoted an already-quoted query**, which double-encoded it at the endpoint.
- **The user agent carried a version (`0.3`) that no release ever had, and stayed wrong for three
  releases.** A version in a user agent is one more thing to keep in step with `package.json` for no
  benefit. The agent now names the package and a URL, never a release, and a test refuses a number in it.
- **A key set for a disabled source was silently ignored.** The footer reports it now.
- **A host package in `dependencies` made the local suite resolve `typebox` through a symlink, and made
  the manifest warn on load.**

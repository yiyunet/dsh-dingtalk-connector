# dsh-dingtalk-connector

**Bring DingTalk AI Table data into DeepSeek Harness.**

MIT · independent community plugin · **not affiliated with, sponsored by, or endorsed by DingTalk or DeepSeek**
[Security and boundaries](#security-and-boundaries) · [Update and uninstall](#update-and-uninstall)

[中文](README.md) | English

---

## What this is, and whether it fits you

A DSH plugin that connects **DingTalk AI Tables** (multi-dimensional tables / aitable) to DeepSeek Harness. Once installed you get **10 `dingtalk_aitable_*` tools** and a **"ANB 工具 → 钉钉文档" panel** — discover Bases, read tables, query records by condition, write in batches, export Chinese CSV with a BOM, and schedule exports, all from inside Harness.

**Architecture**: it wraps the official DingTalk `dws` CLI (`dingtalk-workspace-cli`) and runs `dws aitable ...` — it **never talks to REST directly**. This mirrors DingTalk's own OpenClaw connector, which also injects `DWS_CLIENT_ID/SECRET` and calls `dws` (**measured**, 2026-09-14, by reading its repository).

**Design stance**: **read-first + write gates**. Writes and deletes are off by default, and deletes additionally need a per-call confirmation. One extra confirmation is cheaper than an accidental combination of "model hallucination plus excessive permission".

> **This is not a self-contained plugin** — it depends on the external `dws` CLI. **Three layers of dependency (Node / dws / DingTalk-side authorization) — all required.**

## Three things to read first

> These are the three most commonly misunderstood points.

1. **The scheduler runs inside the DSH host process** — it does not run while DSH is closed, and the next trigger is recomputed after a restart. It is **not** a cloud scheduler.
2. **DingTalk has no "list every Base" API** — a scan produces "candidates ∪ manual entries" and **is not exhaustive**; `base search`'s `hasMore: true` is a **false positive** (cursor paging does not work).
3. **Write and delete gates are off by default** — deletes additionally require `confirm=true` every time.

> Every technical claim here carries a source tier: **measured** / **official documentation** / **inferred**, with the date it was obtained.

## What it guarantees, and what it does not

| | Content |
|---|---|
| **Guarantees** | Tools run on the official CLI's command surface (endpoints, auth and paging belong to `dws`); writes and deletes are unavailable by default; CSV carries a BOM and the first 3 bytes are read back as proof; panel availability is self-evident from `rpcEndpoint.registered` in `diagnose` |
| **Does not guarantee** | That a scan finds every Base in your organization (DingTalk has no such API); that the model will not misbehave (gates reduce exposure, they do not remove risk); behavior after DingTalk API changes (it follows the `dws` version) |
| **The official warning still applies** | DingTalk's own connector states that model hallucination, uncontrolled execution and prompt injection are inherent risks, and advises **against deploying directly in production enterprise environments** |

## Requirements (three layers, all required)

| Layer | Requirement |
|---|---|
| ① Local runtime | **Node ≥ 22.19**; DSH `0.1.2-alpha.4` ~ `0.1.5-alpha.1` |
| ② dws CLI | `npm i -g dingtalk-workspace-cli`, **version ≥ 1.0.6** (measured baseline `v1.0.61`) |
| ③ DingTalk side | Authorization ＋ the "AI Table record read/write" permission ＋ **adding the app as a Base collaborator with edit rights ★most often missed** |

### 1 Install dws

```sh
npm i -g dingtalk-workspace-cli
dws --version          # must be >= 1.0.6
npm root -g            # note the prefix; on Windows you need it for dwsEntry
```

> ⚠️ `dws` is **not a pure JS package** — it ships a `postinstall` that **downloads and unpacks a platform-native binary** (~25 MB), covering Windows / macOS / Linux on x64 and arm64. Unpacking needs the system `powershell.exe` on Windows, and `tar` or `unzip` on macOS / Linux. Full matrix in [docs/安装与前置条件.md](docs/安装与前置条件.md).

### 2 Authorize (pick one)

**Option A — device-code login (interactive)**

```sh
dws auth login         # scan with the DingTalk app; tokens refresh automatically (access 2h / refresh 30d)
dws auth status        # confirm login
```

**Option B — reuse app credentials (headless / recommended for servers)**

```sh
# Windows
set DWS_CLIENT_ID=<your Client ID>
set DWS_CLIENT_SECRET=<your Client Secret>
# macOS / Linux
export DWS_CLIENT_ID=<your Client ID>
export DWS_CLIENT_SECRET=<your Client Secret>

dws auth login
```

> Credential precedence: `--token` > `DWS_CLIENT_ID/SECRET` > the OAuth encrypted store. Credentials reach the child process **only through environment variables**, never as command-line arguments (so they never show up in a process list).

### 3 Grant permissions (**easy to miss; missing means 403**)

1. **DingTalk developer console** → the app → permission management → enable **AI Table (multi-dimensional table) record read/write** → **publish**.
2. **Target Base** → top-right "collaborate/share" → add the app as a collaborator with **edit** rights.

> Both are required. When `dws` reports `permission denied` or 403, nine times out of ten this step is incomplete.

## Install

```sh
# From npm
dsh plugin --profile web add dsh-dingtalk-connector

# Or from a local path (during development)
dsh plugin --profile web add "<absolute path to this repository>"

dsh --profile web --dump-config          # expect a dingtalk-connector layer
```

Then restart `dsh web`. A guided CLI is bundled:

```sh
npx dsh-dingtalk-connector install [--profile web]   # install + verify the config layer
npx dsh-dingtalk-connector doctor                    # check dsh / dws / Node / auth state
```

**To remove it**: see [Update and uninstall](#update-and-uninstall).

## Quick start: export one table into a usable CSV

Installing is not the same as working. The endpoint of the four steps below is **a Chinese CSV that opens correctly in Excel**.

1. **What you provide** — a keyword (to discover the Base) or a known `baseId`, plus an absolute output path.
2. **What you do** — run `dingtalk_aitable_diagnose` first; then `dingtalk_aitable_scan(keywords="...", withTables=true)` to obtain `baseId` and `tableId`; then `dingtalk_aitable_export_csv(baseId, tableId, outputPath="<absolute path>.csv")`.
3. **Where the result appears** — the file lands at `outputPath`, headers use the Chinese field names, and the file starts with `\uFEFF`.
4. **How to know it is right** — **open it in Excel and confirm the Chinese is not garbled** (the only visible proof the BOM works); headers match what you see in DingTalk; row count matches. **If anything differs, reconcile first with `dingtalk_aitable_record_query(all=true)` — do not schedule it yet.**

## Day-to-day use

**Main line, end to end.** Scan for the table → export once to verify → create a scheduled job → it overwrites the same file daily.

```
① dingtalk_aitable_scan(keywords="kwA,kwB", withTables=true)
      → candidate Bases + a readability probe for each (readable / failure reason)
      → note the baseId + tableId you care about

② dingtalk_aitable_export_csv(baseId, tableId, outputPath="<absolute path>.csv")
      → export once; verify headers, encoding and row count

③ dingtalk_sync_job(action="create", baseId, tableId,
                    outputPath="<absolute path>.csv",
                    frequency="daily", time="09:00", label="daily sales")
      → exports and overwrites the same file every day at 09:00

④ dingtalk_sync_job(action="list")                    # next trigger and last result
   dingtalk_sync_job(action="run-now", id="<id>")     # run once now
```

**Shortest path from the second time on.** If the table has not changed, do nothing; to confirm the job is alive, call `dingtalk_sync_job(action="list")`.

**⚠️ Three semantics you must know**

1. **The scheduler runs inside the DSH host process**: it does **not** run while DSH is closed (an accepted semantic); the next trigger is recomputed after a restart.
2. **"Enumerate every Base" is impossible on the DingTalk side**: `base list` returns only recently accessed items, and `base search` returns about 4 results per call with **non-working cursor paging**. A scan is therefore "multi-channel candidates ∪ manual entries" and **is not exhaustive** — supply more keywords, or add a `baseId` manually.
3. **CSV must carry a BOM**: the plugin writes `\uFEFF` first, which is the only condition under which Excel decodes UTF-8 Chinese correctly. After writing, it **reads the first 3 bytes back** as proof (editors hide the BOM, and ripgrep strips it).

## Settings panel

**Entry**: **Settings → ANB 工具 → "钉钉文档"** (shell order 16; this tab is order 10 inside the shell).

> The "ANB 工具" shell is **bundled with this package** — not something extra to install. Any ANB-family plugin brings the shell. When several are installed there is **only one shell** (a runtime singleton): whoever starts first registers it, the rest yield, and if the registrant is disabled the next ANB plugin takes over, with tabs listed in order.

| Section | Content |
|---|---|
| **Account binding** | CLI version, organization / user name, access-token expiry, credential source, write-gate state; plus the device-code binding session (QR code / deep link / raw output / organization-blocked notice) |
| **AI Table list** | Keyword → scan (candidate discovery + **readability probe**) → each Base marked readable / not readable → expand to tables → select one → **copy Base ID / Table ID** |
| **Scheduled export** | Selected table + output path + daily/weekly + time → create a job; the table shows next and last result, with **run now / enable / disable / delete** |

Panel self-proof: `dingtalk_aitable_diagnose` returns `rpcEndpoint`; `registered: true` means the RPC endpoint is mounted.

### Configuration (`cordis.patch.yml`)

| Key | Default | Meaning |
|---|---|---|
| `dwsCommand` | `dws` | Command name on PATH |
| `dwsEntry` | none | **Recommended on Windows**: absolute path to dws's JS entry. When set, the plugin spawns node directly and **never goes through a shell** |
| `timeoutMs` | 60000 | Per-command timeout |
| `clientIdEnv` / `clientSecretEnv` | `DWS_CLIENT_ID` / `DWS_CLIENT_SECRET` | Credential environment-variable names |
| `allowWrite` | **false** | Switch for create / update |
| `allowDelete` | **false** | Switch for delete (separate, and still needs `confirm=true` each time) |
| `maxBatch` | 30 | Per-batch limit (the official connector specifies ≤30) |
| `exportRoot` | none | Optional: **restrict** export destinations to one directory |
| `defaultExportDir` | none | Optional: directory auto-filled by the panel after selecting a table |
| `scanConcurrency` | 4 | Concurrency for the readability probe (rate-limit protection) |

**About `dwsEntry` (a Windows security point)**: on Windows a `.cmd` must go through a shell, and the shell interprets metacharacters — record text containing quotes or `&`/`|` could be injected. The plugin **hard-rejects** this (returns `ARG_UNSAFE` with guidance). The full fix is to point `dwsEntry` at dws's JS entry:

```yaml
dwsEntry: '<npm root -g>/dingtalk-workspace-cli/bin/dws.js'
```

## The ten tools

| Tool | Purpose | Gate |
|---|---|---|
| `dingtalk_aitable_diagnose` | **Self-check**: dws version / auth state / registered commands / RPC endpoint | none |
| `dingtalk_aitable_base` | Base files: list / search / get / create / update / delete | delete needs the double lock |
| `dingtalk_aitable_table` | Tables: get (**`tableIds` is required to return fields**) / create / update / delete | delete needs the double lock |
| `dingtalk_aitable_field` | Fields: get / create / update / delete | delete needs the double lock |
| `dingtalk_aitable_record_query` | **Read records** (by id or condition; `all=true` for a full pull) | none |
| `dingtalk_aitable_record_write` | Write records: create / update / delete | write / delete gates |
| `dingtalk_aitable_raw` | Controlled pass-through to any registered subcommand | dangerous commands need the double lock |
| `dingtalk_aitable_scan` | Candidate discovery + **readability probe** | none |
| `dingtalk_aitable_export_csv` | Full CSV export (**with BOM**, Chinese field names as headers, **overwrites same name**) | none (subject to optional `exportRoot`) |
| `dingtalk_sync_job` | Scheduled export jobs: create / list / remove / enable / disable / run-now | none |

**Double lock** = `allowDelete: true` (config layer) + `confirm: true` (per call, meaning consent was obtained).

### Standard call order (per official documentation)

```
1. dws aitable base search --query "kw"              → obtain baseId
2. dws aitable base get --base-id <B>                → obtain tableId
3. dws aitable table get --base-id <B> --table-id <T> → obtain fieldId  ★required before writing
4. dws aitable record query --base-id <B> --table-id <T>
5. dws aitable record create --records '[{"cells":{"fldXXX":"value"}}]'
```

The plugin's equivalent: `base(action=search)` → `base(action=get)` → `table(action=get)` → `record_query` → `record_write`.

If you cannot get a `baseId`: `base list` **returns only recently accessed** Bases — open the table once in the web UI, or use `base search`.

### cells read/write cheat sheet (official)

| Field type | Write | Read back |
|---|---|---|
| text | `"string"` | `"string"` |
| number | `123` | `"123"` |
| singleSelect | `"option name"` or `{"id":"xxx"}` | `{"id":"x","name":"option"}` |
| multipleSelect | `["A","B"]` | `[{"id":"x","name":"A"}]` |
| date | `"2026-03-13"` | ISO string |
| checkbox | `true`/`false` | `true`/`false` |
| user | `[{"userId":"xxx"}]` | `[{"corpId":"x","userId":"x"}]` |
| url | `{"text":"label","link":"https://..."}` | same as write |
| richText | `{"markdown":"**bold**"}` | same as write |

> In `filters`, singleSelect is more reliable with the **option id** (from `field get`); writes may use the option name directly.

### Multiple accounts: bind by device code / remove

| Ability | Command | Note |
|---|---|---|
| List bound accounts | `dws profile list --format json` | one profile = one `corpId + userId`; **several accounts may coexist** |
| Remove a binding | `dws auth logout --profile <corpId:userId>` | the precise selector logs out **only that account** (no selector = all); the panel asks for **double confirmation** |
| Bind by device code | `dws auth login --device --recommend --format json` | the panel's "bind" button; output echoes live and the account list refreshes on success |

#### Two measured facts that prevent misjudgment

**① dws's device flow does not output a QR code.** It only prints `link:`, `authorization code:` and a deep link carrying `user_code`. The **QR code is generated by this plugin**: the host draws the deep link into an SVG data URL with the `qrcode` package and the front end renders an `<img>`. **No third-party QR service is ever called** — the auth link never leaves the machine. If parsing fails, it degrades to "deep link + code only".

**② On a machine already logged into DingTalk, the device flow may complete without scanning.** That is not "automatic approval" — the machine already holds a DingTalk login, so the flow can select that account and organization directly. Consequences: pressing "bind" on such a machine **may finish without showing a code** (using the machine's current account/organization, not letting you choose a new one); and the "probe output for 8 seconds" button **is not free of side effects** — if the organization has enabled CLI access, probing can actually create an account.

#### ⛔ Known blocker: the organization has not enabled CLI personal-data access

A new login stops at Step 4 with `CLI data access is not enabled for this organization`. **The organization's main administrator** must enable that switch in the DingTalk open platform → developer settings, then scan again. **This is an administrative action, not a technical configuration**; until it is resolved, "multiple accounts" effectively means one.

> Note: existing logins **still work** with the switch off (`auth status` valid, data readable). Why new logins are blocked while old sessions work is not yet explained; ask the administrator to check the switch's real state.

## When something goes wrong

| Signal | Meaning | Next step |
|---|---|---|
| `command not found: dws` | CLI not installed | `npm i -g dingtalk-workspace-cli` |
| `请先执行 dws login` | Not authorized | `dws auth login` |
| `AUTH_TOKEN_EXPIRED` / `USER_TOKEN_ILLEGAL` | Token expired | `dws auth login` again |
| `permission denied` / 403 | Insufficient permission | enable the AI Table permission and add the app as a Base collaborator |
| `RECOVERY_EVENT_ID=<id>` | A failure snapshot was persisted | follow the `dws recovery plan/execute/finalize` loop |
| `ARG_UNSAFE` | Arguments contain shell metacharacters | configure `dwsEntry` to run without a shell |
| `PAGING_TRUNCATED` | Page limit reached | continue with the returned cursor, or raise `pageLimit` |
| Panel blank / "empty shell" | RPC envelope shape or endpoint name mismatch | run `npm run verify` (it checks endpoint consistency) |
| Plugin fails to load, log says entry missing | `lib/` was not built | `npm run doctor`, then `npm run build` |

## Security and boundaries

- **Write gates are off by default**; deletes additionally require `confirm=true` every time (double lock).
- **Credentials reach the child process only through environment variables**, never as command-line arguments.
- **Arguments are passed element by element**, never concatenated into a shell string; with `dwsEntry` set there is no shell at all, otherwise strict validation applies.
- **The client never hardcodes export paths**: the default directory is supplied by the host (`defaultExportDir`).
- **Tool visibility**: the host-side bundle mounts on the host plane, so every session under that profile sees these 10 tools.
- The official connector's own warning applies: **model hallucination / uncontrolled execution / prompt injection** are inherent risks, and it advises against direct production deployment. This plugin reduces exposure with **read-first + write gates**.
- This is an **unofficial** community integration, not affiliated with or endorsed by DingTalk or DeepSeek.

## Data, permissions and privacy

- **What it reads** — the Bases, tables, fields and records you are entitled to in DingTalk AI Tables; the local `dws` authorization state and version.
- **What leaves the machine, and where** — only DingTalk's official API via `dws` (credentials managed by `dws`); **the plugin itself sends nothing to any third party** and has no telemetry endpoint.
- **What is written to disk, and where** — exported CSV goes to the `outputPath` you specify (restrictable with `exportRoot`); scheduled job definitions are stored by DSH; the plugin writes nothing else.
- **Who can read or write** — only the operating-system account running DSH; credentials live in `dws`'s encrypted OAuth store or in the environment variables you provide.
- **Key default switches** — `allowWrite: false`, `allowDelete: false`, and `confirm` supplied per call.
- **Where credentials are stored and whether they reach logs** — credentials reach the child process only as environment variables; tool replies never contain them; the panel shows only organization name, user name and expiry.

## Compatibility: required, verified, still unconfirmed

- **Required** — Node ≥ 22.19; `dws` ≥ 1.0.6; DSH `0.1.2-alpha.4` ~ `0.1.5-alpha.1`; the DingTalk permission enabled and the app added as a Base collaborator.
- **Verified** — the ten tools work across that DSH range; CSV carries a BOM with read-back proof; device-code binding, multiple accounts and removal are implemented and measured; the panel's RPC endpoint is self-provable via `diagnose`.
- **Still unconfirmed** — new-login behavior when the organization has not enabled CLI personal-data access (known blocker above); command-surface changes from a `dws` upgrade (the plugin version may be unchanged while behavior breaks — **check `dws --version` first**).

## Development

```sh
npm install          # installs esbuild (build-time) and optional qrcode; builds automatically (prepare)
npm run build        # plugin-src/ → lib/
npm test             # node --test pure-function tests (scheduling / CSV / job store / command registry)
npm run verify       # eight classes of release-contract assertions
npm run doctor       # read-only environment self-check
npm run inspect      # diagnostics: size, line count and marker reality of lib/client.js
npm run check        # build && test && verify   ← what CI runs
```

**Never edit `lib/` directly** — it is a build artifact and will be overwritten. **`plugin-src/` is the only source of truth.**

### `lib/` is not in the repository — rebuild after deleting, resetting or reinstalling

`lib/` and `node_modules/` are both gitignored, yet the manifest's `main` points at `lib/index.mjs`. The consequence: **without `lib/` the plugin cannot load**, and the symptom is only an obscure module-not-found that never says "you have not built yet". Two guards:

| Guard | Behavior |
|---|---|
| `prepare` hook | Builds automatically after `npm install`. **It never fails** (a failed build only prints guidance); when others install it as a dependency it is silently skipped (the published package ships `lib/`). ⚠️ **Why `prepare` and not `postinstall`**: pnpm 10+ blocks dependency install-time scripts by default (supply-chain protection), and `postinstall` would make **installation fail on the consumer side** (`ERR_PNPM_IGNORED_BUILDS`); `prepare` does not run for registry dependencies at all, so it falls outside that block |
| `npm run doctor` | Read-only self-check reporting whether Node / esbuild / host sources / `lib/` artifacts / qrcode are in place |

**Symptom mapping**: DSH will not start and the log says module-not-found or entry-missing → nine times out of ten `lib/` is absent → confirm with `npm run doctor` → `npm run build`.

### Why markers are matched after unescaping

**esbuild escapes non-ASCII characters (such as Chinese) into `\uXXXX` by default.** So "the source contains 钉钉文档" and "the artifact matches `includes('钉钉文档')`" are two different things — matching the raw string would judge a **perfectly correct** artifact as contract drift. `scripts/bundle-markers.mjs` exposes `containsMarker()`: **a hit either raw or after unescaping counts**.

### Release contract assertions (`npm run verify`, eight classes)

1. Required files present. 2. **No dependency section or lock file may reference `@deepseek-ai/dsh-*`** (DSH runtime packages key on module-local Symbols; a second physical copy breaks host lookup). 3. The client artifact registers the correct loader id (**matching the package name**). 4. The client artifact **carries the ANB tool shell** and registers the panel (`SHELL_ID='anb-toolbox'` order 16 / `anb.tool.tab` order 10). 5. The client artifact contains no top-level ESM syntax. 6. **The RPC endpoint name is identical in host source, client source and client artifact**. 7. No personal absolute paths or credential assignments anywhere in the repo. 8. **The `files` allowlist is self-consistent** (every entry exists; files referenced by lifecycle scripts have their directory included; declared entries are included).

> Why #8 matters: with a local `link:` install the `files` field **has no effect at all**, so missing files are invisible on the developer machine — they only explode as an `npm install` failure on the consumer side after publishing.

### Troubleshooting order for build/verify errors

```
npm run inspect      # ① artifact reality: size, line count, BOM, escaping, marker hits
                     # ② if something is genuinely missing, search for it in plugin-src/client/impl.mjs
                     #    · present in source, absent in artifact → stale artifact, rebuild
                     #    · absent in source too              → contract drift, fix the source
```

## Update and uninstall

```sh
# Upgrade the plugin
dsh plugin --profile web add dsh-dingtalk-connector

# Uninstall
dsh plugin --profile web remove dsh-dingtalk-connector

# Upgrade the external dws dependency separately (it is an independent package)
npm i -g dingtalk-workspace-cli@latest
dws --version
```

> **`dws` is an external prerequisite and is not managed by the plugin.** If behavior breaks while the plugin version is unchanged, **check `dws --version` first** — a `dws` upgrade may have changed the command surface.

**Uninstall and leftovers**: uninstalling removes the plugin code; **exported CSV files and scheduled job definitions are not deleted** — clean them up manually. `dws` and its authorization belong to the external tool and are unaffected.

After upgrading, run `dingtalk_aitable_diagnose` once to confirm.

## Documentation index

This README covers **how to use it**; `docs/` covers **why it is built this way and what was verified**.

| Document | Content |
|---|---|
| [docs/安装与前置条件.md](docs/安装与前置条件.md) | ★ **read this first**: the three dependency layers, platform matrix and a verification checklist |
| [docs/发布与版本管理.md](docs/发布与版本管理.md) | Publishing to GitHub, versioning and release, pre-release checklist |
| [docs/README.md](docs/README.md) | Documentation index (find documents by question) |
| [docs/adr/0001-从手搓REST改为包装dws.md](docs/adr/0001-从手搓REST改为包装dws.md) | Architecture decision record: why hand-written REST was abandoned for wrapping `dws` |
| [docs/实测/](docs/实测/) | Records of each real-device verification |
| [CONTEXT.md](./CONTEXT.md) | Glossary and **forbidden phrasings** — precision of wording is a feature here, not a style preference |
| [CHANGELOG.md](./CHANGELOG.md) | Change log |
| [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) | Third-party components and trademark notices |

## Feedback

- **Problems / feature requests**: open an [issue](https://github.com/yiyunet/dsh-dingtalk-connector/issues/new/choose). Include the **DSH version** and the **plugin version** (see the package manifest or `CHANGELOG.md`; this document does not duplicate it).
- **Security matters**: do not open a public issue — this plugin touches DingTalk credentials and organizational data.

> The template asks for version and OS; **remove DingTalk credentials, phone numbers and organization names before pasting logs or screenshots**.

## Contributors

This project follows the [All Contributors](https://allcontributors.org/en/reference/specification/) specification and recognizes code, documentation, tests, issue reports, ideas and other contributions. The list is managed through [`.all-contributorsrc`](./.all-contributorsrc).

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- ALL-CONTRIBUTORS-LIST:END -->

## License and unofficial notice

- **License**: [MIT](./LICENSE) © 2026 yiyunet
- **Unofficial**: this is an **unofficial community integration**, not affiliated with or endorsed by DingTalk or DeepSeek.
- **External dependency**: `dws` (`dingtalk-workspace-cli`) is published by DingTalk under **Apache-2.0**; copyright belongs to its authors. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

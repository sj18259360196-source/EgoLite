# EgoLite

Windows desktop browser with task workspaces, MCP automation, and an integrated
Chat On Steroids (CoS) workspace. The development desktop version is `0.2.13`.

## Development

Requires Windows 10/11 and Node.js 24 or newer. The native companion host also
requires the .NET SDK specified by its project file.

```powershell
npm ci
npm run typecheck
npm run test:quick
npm run start:desktop
```

The browser can run without a prepared CoS component. To use CoS from a source
checkout, first build the pinned upstream revision with the Ego adapter.

```powershell
node --input-type=module -e "import {buildCosCandidate} from './integrations/cos/build-candidate.mjs'; import {readFile} from 'node:fs/promises'; const pin=JSON.parse(await readFile('integrations/cos/upstream.json','utf8')); console.log(await buildCosCandidate(pin.commit));"
```

This downloads upstream source and dependencies and performs adaptation, build,
type checking, and a hosted startup probe. It requires network access. CoS source
and generated component files are not committed here.

## Packaging

`npm run package:win` prepares the Windows runtime and creates the installer.
Prepare CoS as described above first. ScanSci PDF `1.19.0` source is vendored and
Ego adapters remain separate. Prepare its Python environment with `uv`:

```powershell
uv venv integrations/scansci/.venv --python 3.14
uv pip sync integrations/scansci/requirements.lock --python integrations/scansci/.venv/Scripts/python.exe
node tools/prepare-scansci-source.mjs
```

The packaging pipeline copies the real Python interpreter and installs only the
hash-locked dependencies. Set `SCANSCI_PACKAGE_TOR` to a prepared Tor distribution
containing `tor/` and `docs/`. Neither Python binaries nor Tor binaries are
committed to this source repository. Existing user configuration is kept outside
the installed program. See [ScanSci integration](docs/scansci-integration/STATUS.md).

## CoS Integration

CoS is pinned to upstream `2.1.45`, commit
`8ea2c3b16c23267945dd74ea72e6c60c00876cfb`. Ego hosts its original interface and
backend. Browser extension operations are adapted to the dedicated Ego workspace.
The adapter source is under `integrations/cos` and
`apps/desktop-shell/workspace-packs`.

Tabs, navigation, page input, screenshots, frames, groups, and logical window
queries use Ego browser APIs. Explicit stop and manual control remain available.
CoS file, command, and desktop tools retain their original capability settings.

Local packaged validation covered browser interactions, native dialog ownership,
component update/recovery, terminal execution, file exports, and persisted
settings/bookmarks. Full Workers and Goal/Loop runs with a real ChatGPT account
remain unverified.

## Publication Scope

The initial public snapshot was based on local integration commit
`56b2fca4ceb3f952e2cbaca33a56c9b03c3e2ae3`.
Private development history, user profiles, credentials, local agent settings,
private internal work logs, generated packages, and user test output are excluded.
Sanitized ScanSci validation records and isolated-profile screenshots are included
under `docs/scansci-integration/evidence`.
Unmerged changes from the separate development checkout are not included.

See [automation API](docs/automation-api.md) and
[third-party notices](THIRD_PARTY_NOTICES.md).

Windows installers are published on the [Releases page](https://github.com/sj18259360196-source/EgoLite/releases).
Future release naming follows [Release Naming](docs/RELEASING.md).

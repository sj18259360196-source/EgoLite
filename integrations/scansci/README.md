# Ego ScanSci adapter

`upstream.json` pins the unmodified source in `vendor/scansci-pdf`.
`adapt_source.py` creates an Ego overlay in a generated runtime. Do not edit
generated runtime files. Legacy modules supply the retained settings UI and
selected browser branches; upstream download implementations remain in place.

## Prepare

```powershell
uv venv integrations/scansci/.venv --python 3.14
uv pip sync integrations/scansci/requirements.lock --python integrations/scansci/.venv/Scripts/python.exe
node tools/prepare-scansci-source.mjs
$env:PYTHONPATH="$PWD/integrations/scansci/runtime/src"
New-Item -ItemType Directory .tmp/codex/scansci-tests -ErrorAction SilentlyContinue
integrations/scansci/.venv/Scripts/python.exe -m pytest integrations/scansci/test_host.py --basetemp=.tmp/codex/scansci-tests/pytest -p no:cacheprovider -q
```

## Upgrade

Replace vendored upstream files from a verified stable tag and update its commit
and archive hash in `upstream.json`. Compile a new hashed dependency lock from
the upstream pyproject and `requirements.in`. Run source preparation, adapter
tests, upstream tests, desktop tests, packaged settings and Windows suite tests,
and live retrieval before publishing. Adapter anchor changes fail explicitly.

`tools/prepare-scansci-runtime.mjs` bundles the interpreter and installs only
locked dependencies. `tools/verify-desktop-installer.mjs` compares every ScanSci
runtime file in the installer with the tested unpacked program.

Current verification and known browser-event/SSO limits are documented under
`docs/scansci-integration`.

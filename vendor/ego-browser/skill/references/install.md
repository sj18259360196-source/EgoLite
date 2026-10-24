# Install ego lite

Read this file only when ego lite isn't installed yet, or when the user asks to install ego lite. For day-to-day browser work, go back to `SKILL.md`.

The ego-browser skill depends on its installed browser runtime. Confirm launcher availability and backend readiness after installation; onboarding alone does not prove the current connection or control lease is available.

ego lite website: https://lite.ego.app/

## Windows and EGoLite desktop

On Windows, installing or updating EGoLite installs this skill and the `ego-browser-desktop` MCP server for detected local Agents. EGoLite also maintains an `ego-browser.cmd` launcher under the current user's local application data. Keep EGoLite running while the Agent controls the browser.

Open EGoLite Settings -> Local Agents to inspect or repair the connection. Agent chat stays in Codex, Claude, Cursor, or another local Agent; EGoLite only shows Agent status, browser actions, takeover, stop, and return-control controls.

After first installation or repair, an Agent application that was already running may need to reload its MCP configuration once. Future EGoLite updates refresh the managed skill and launcher automatically.

## Install steps (macOS only)

The install script lives at `scripts/install.sh` in this skill and supports macOS only. It will:

- Download the ego lite installer (a DMG) for your CPU architecture (arm64 / x64).
- Install `ego lite.app` to `/Applications` (falling back to `~/Applications` when needed).
- Strip the quarantine attribute to keep Gatekeeper from blocking the first launch.
- After installing, launch the `ego lite` app.

Run the script (use the script's actual path under this skill's directory):

```bash
sh skills/ego-browser/scripts/install.sh
```

After installing, the script opens the ego lite app directly. If ego lite is already installed, the script skips the download and opens the app directly.

After the script opens the ego lite app, the user completes the first-run onboarding in the app:

- Choose to import data from Chrome or another browser as needed.
- Onboarding registers the `ego-browser` command on the PATH (usually under `~/.local/bin`).

Onboarding is a step the user completes in the GUI. After the script opens ego lite, wait for the user to confirm they've finished onboarding before continuing.

## After installing: confirm `ego-browser` is available

Once the user has finished onboarding, confirm the command is ready:

```bash
command -v ego-browser
```

If it reports that the command isn't found, `~/.local/bin` is most likely not on the current PATH. Fix it temporarily and retry:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v ego-browser
```

Once the command exists, verify the runtime with a minimal heredoc:

```bash
ego-browser nodejs <<'EOF'
console.log('ego-browser ready')
EOF
```

Printing `ego-browser ready` confirms JavaScript execution. Use `ego_status` for backend readiness, and select or observe a task before browser operations. For exact tool parameters and desktop limitations read [the generated interface reference](automation-api.md).

## After that, return to the original task

Once the environment is ready, return to the user's original task and continue with the task space flow in `SKILL.md` — start from `taskSpaces.useOrCreate(name)` and proceed as usual.

## Troubleshooting

- **Windows**: use the EgoLite Windows installer and Settings -> Local Agents. Do not run the macOS installation script. PowerShell accepts `@'` / `'@` here-strings piped to `ego-browser nodejs`; it does not accept Bash heredocs.
- **Download failed**: the script retries 3 times automatically; if it still fails, it's usually a network issue — have the user check their network and retry.
- **Gatekeeper still blocks it**: the script already tries to strip quarantine; if the first launch is still blocked, have the user allow ego lite manually under System Settings → Privacy & Security.
- **Command still unavailable after onboarding**: confirm `~/.local/bin` is on the PATH (see above); or have the user reopen ego lite, finish onboarding, and retry.

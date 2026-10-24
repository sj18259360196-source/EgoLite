# Ego Windows Companion extension

This unpacked MV3 extension grants only explicitly selected Edge or Chrome tabs to an
Ego task space. Its stable development extension ID is
`omdijpknicgkhnpadadcggpnbojohpdc`.

## Development install

Run the guided Windows installer first. It registers the Native Host, validates the
extension, copies the unpacked directory to the clipboard, and opens the correct Edge
and Explorer locations:

```powershell
npm run install:companion
```

Edge requires one explicit **Load unpacked** confirmation for a development extension;
normal desktop processes cannot silently grant themselves browser extension access.
After that one-time confirmation, verify the complete Codex Companion path with:

```powershell
npm run doctor:companion
```

Once the doctor reports `backend.ready: true`, exercise the installed current-profile
extension rather than a temporary smoke-test profile:

```powershell
npm run test:companion-profile
```

Set `EGO_COMPANION_SMOKE_URL` to an already authenticated site when validating login
state reuse. The smoke creates a Companion task, opens the URL inside the current
profile, captures a semantic snapshot, and hands the task to the user.

Run the Companion extension in only one browser instance at a time. Edge and Chrome
currently share one authenticated Native Messaging bridge; browser-instance routing is
a later compatibility milestone.

1. Build and register the Native Messaging host:

   ```powershell
   .\apps\native-host\install.ps1 -Browser Edge
   ```

2. Open `edge://extensions`, enable Developer mode, choose **Load unpacked**, and select:

   ```text
   A:\Project\egolite\apps\companion-extension
   ```

3. Start the Broker in Companion mode:

   ```powershell
   $env:EGO_COMPAT_BACKEND = "companion"
   npm run start --workspace @ego-compat/broker
   ```

4. Create a task with `ego-browser`, open the extension popup, select that task, and
   press **授权当前标签**. Tabs are never adopted implicitly.

The extension uses `chrome.debugger`, so Edge shows its standard debugging disclosure.
Opening DevTools can detach the extension; that is treated as loss of Agent control.
The **接管所选任务** action detaches every debugger session in that task before the
Broker transfers ownership. A resumed Agent must obtain explicit consent and attach a
new session.

The Side Panel provides the same explicit tab grant plus task ownership, takeover, and
one-use resume consent. Its public Native Messaging pipe is owned by a .NET relay with
a protected DACL limited to the current user SID and SYSTEM.

Its Chat tab can attach individual pages, whole tab groups, or saved selections. The
extension requests semantic page context from the Broker and sends only the selected
attachments with the user's prompt. Provider configuration and credentials remain in
the Broker's `.env.local`; the extension receives only the final answer and model name.

Use the **问答 / Codex** segmented control to keep ordinary answers and agent work in
one message history. Codex follow-ups reuse the current thread and show a compact list
of commands, changed files, searches, MCP calls, and completed tasks returned by the
Broker.

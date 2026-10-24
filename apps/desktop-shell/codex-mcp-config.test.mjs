import assert from 'node:assert/strict';
import test from 'node:test';
import TOML from '@iarna/toml';
import { configureCodexMcp, codexMcpConfigured } from './codex-mcp-config.mjs';
const launcher = "C:\\工具\\O'Brien\\ego.cmd";
const old = '[mcp_servers.ego-browser-desktop]\ncommand="old"\n';

test('adds the bundled ScanSci server without changing other MCP servers', () => {
  const existing = '[mcp_servers.scansci-pdf]\ncommand="user-managed"\n';
  const browser = configureCodexMcp(existing, launcher);
  const output = configureCodexMcp(browser, 'C:\\EgoLite\\start-scansci-mcp.cmd', 'scansci-pdf-egolite');
  const config = TOML.parse(output);
  assert.equal(config.mcp_servers['scansci-pdf'].command, 'user-managed');
  assert.equal(config.mcp_servers['ego-browser-desktop'].command, launcher);
  assert.equal(config.mcp_servers['scansci-pdf-egolite'].command, 'C:\\EgoLite\\start-scansci-mcp.cmd');
  assert.equal(configureCodexMcp(output, 'C:\\EgoLite\\start-scansci-mcp.cmd', 'scansci-pdf-egolite'), output);
});

for (const [label, input] of Object.entries({ unmarked: old, orphan: '# END EGOLITE MANAGED MCP\n'+old, duplicate: old+old, quoted: old.replace('.ego-browser-desktop', '."ego-browser-desktop"'), moved: '# BEGIN EGOLITE MANAGED MCP\n[other]\nkeep=42\n# END EGOLITE MANAGED MCP\n'+old })) {
  test(`repairs ${label} without dropping unrelated settings`, () => {
    const result = configureCodexMcp(input, launcher);
    const parsed = TOML.parse(result);
    assert.equal(parsed.mcp_servers['ego-browser-desktop'].command, launcher);
    if (label === 'moved') assert.equal(parsed.other.keep, 42);
    assert.equal(configureCodexMcp(result, launcher), result);
    assert.equal(codexMcpConfigured(result, launcher), true);
  });
}
test('preserves comments, multiline prompts, nested arrays and user MCP settings', () => {
  const prefix = '# personal comment\nprompt="""\n[mcp_servers.ego-browser-desktop]\n# BEGIN EGOLITE MANAGED MCP\n"""\nvalues=[\n[1,2],\n[3,4]\n]\n';
  const input=prefix+old+'enabled=false\ntool_timeout_sec=120\n[mcp_servers.ego-browser-desktop.env]\nUSER_OPTION="keep"\n';
  const output=configureCodexMcp(input,launcher);
  assert.ok(output.startsWith(prefix));
  const server=TOML.parse(output).mcp_servers['ego-browser-desktop'];
  assert.equal(server.env.USER_OPTION,'keep');
  assert.equal(server.tool_timeout_sec,120);
  assert.equal(server.enabled,false);
  assert.equal(codexMcpConfigured(output,launcher),false);
});
test('rejects malformed unrelated configuration and detects invalid duplicates', () => {
  assert.throws(()=>configureCodexMcp('model = [broken\n'+old,launcher));
  assert.throws(()=>codexMcpConfigured(old+old,launcher));
});

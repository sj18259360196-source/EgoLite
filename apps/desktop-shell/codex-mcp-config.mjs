import TOML from '@iarna/toml';

const name = 'ego-browser-desktop';
const marker = /^# (?:BEGIN|END) EGOLITE MANAGED MCP\s*$/;

// Recognize table boundaries only outside strings. In particular, a header or
// managed comment inside a multiline prompt is ordinary user data.
function sections(text) {
  const result = [{ path: [], text: '' }];
  let quote = '';
  let depth = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    if (!quote && !depth && marker.test(line.trim())) continue;
    if (!quote && !depth && /^\s*\[/.test(line)) {
      const parsed = TOML.parse(line + '\n');
      const path = [];
      let node = parsed;
      while (node && !Array.isArray(node) && typeof node === 'object' && Object.keys(node).length === 1) {
        const key = Object.keys(node)[0];
        path.push(key);
        node = node[key];
      }
      result.push({ path, text: '' });
    }
    result.at(-1).text += line;
    for (let i = 0; i < line.length; i++) {
      if (!quote) {
        if (line[i] === '#') break;
        if (line[i] === '[' || line[i] === '{') depth++;
        if (line[i] === ']' || line[i] === '}') depth--;
        if (line[i] === '"' || line[i] === "'") {
          quote = line.slice(i, i + 3) === line[i].repeat(3) ? line[i].repeat(3) : line[i];
          i += quote.length - 1;
        }
      } else if (quote[0] === '"' && line[i] === '\\') i++;
      else if (line.startsWith(quote, i)) {
        i += quote.length - 1;
        // TOML permits up to two extra quotes at the end of multiline strings.
        if (quote.length === 3) while (line[i + 1] === quote[0]) i++;
        quote = '';
      }
    }
  }
  return result;
}

export function configureCodexMcp(current, launcher, serverName = name) {
  const name = serverName;
  const parts = sections(current.replace(/^\uFEFF/, ''));
  const own = part => part.path[0] === 'mcp_servers' && part.path[1] === name;
  let settings = {};
  for (const part of parts.filter(own)) {
    const value = TOML.parse(part.text).mcp_servers[name];
    // Preserve user options and child tables when consolidating duplicate entries.
    settings = { ...settings, ...value, ...(settings.env || value.env ? { env: { ...settings.env, ...value.env } } : {}) };
  }
  const retained = parts.filter(part => !own(part)).map(part => part.text).join('');
  const parsed = TOML.parse(retained);
  if (parsed.mcp_servers?.[name]) throw new Error('Ego MCP uses an unsupported inline configuration; no changes were written');
  settings.command = launcher;
  settings.args = [];
  settings.startup_timeout_sec ??= 30;
  // A stdio command must not retain an old HTTP transport URL.
  delete settings.url;
  const block = TOML.stringify({ mcp_servers: { [name]: settings } }).replace(/^\[mcp_servers\]\r?\n/m, '');
  const next = retained.trimEnd() + (retained.trim() ? '\n\n' : '') + '# BEGIN EGOLITE MANAGED MCP\n' + block + '# END EGOLITE MANAGED MCP\n';
  TOML.parse(next);
  return next;
}

export function codexMcpConfigured(text, launcher) {
  const server = TOML.parse(text).mcp_servers?.[name];
  return server?.command === launcher && !server.url && server.enabled !== false;
}

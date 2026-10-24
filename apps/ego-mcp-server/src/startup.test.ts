import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BrokerPipeServer } from '../../broker/src/server.ts';

test('MCP handshakes while offline and first tool survives a slow broker startup', async () => {
  const pipe = `\\\\.\\pipe\\ego-lazy-test-${randomUUID()}`;
  const transport = new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./main.ts',import.meta.url))],env:{...process.env,EGO_COMPAT_PIPE:pipe} as Record<string,string>,stderr:'pipe'});
  const client = new Client({name:'lazy-test',version:'1'});
  const broker = new BrokerPipeServer();
  let started=false;
  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(tool=>tool.name==='ego_status'));
    const pending=client.callTool({name:'ego_status',arguments:{}});
    // Longer than the former 5 second connection budget.
    await new Promise(resolve=>setTimeout(resolve,5500));
    await broker.listen(pipe);started=true;
    const result=await pending;
    assert.notEqual(result.isError,true);
  } finally {await client.close();if(started)await broker.close();}
});

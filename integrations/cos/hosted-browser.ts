import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleEgoBrowserRequest, startBridge, bridgePort } from './bridge.js';

export interface EgoBrowserRequest {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export async function requestEgoBrowser(input: EgoBrowserRequest): Promise<{
  status: number; headers: Record<string, string>; body: string;
}> {
  if (process.env.COS_EGO_HOSTED !== '1' || !process.connected) throw new Error('Ego private transport is unavailable');
  if (!input || typeof input.path !== 'string' || !input.path.startsWith('/') || input.path.startsWith('//')) {
    throw new Error('Invalid CoS browser route');
  }
  if (input.body !== undefined && typeof input.body !== 'string') throw new Error('Invalid CoS browser body');
  await startBridge();
  if (bridgePort() === null) throw new Error('CoS browser service has not recovered');
  const request = new PassThrough();
  Object.assign(request, {
    url: input.path,
    method: input.method || 'GET',
    headers: { ...input.headers },
  });
  let status = 200;
  let headers: Record<string, string> = {};
  let body = '';
  let ended = false;
  const response = {
    headersSent: false,
    writeHead(code: number, values: Record<string, string>): void {
      status = code; headers = values; this.headersSent = true;
    },
    end(value?: string): void { body = value || ''; ended = true; },
  };
  // Preserve upstream authentication, protocol, validation and durable queue behavior.
  // No socket is created and the bearer credential stays inside the trusted package.
  const handled = handleEgoBrowserRequest(
    request as unknown as IncomingMessage,
    response as unknown as ServerResponse,
  );
  request.end(input.body ? Buffer.from(input.body) : undefined);
  await handled;
  if (!ended) throw new Error('CoS browser handler did not finish its response');
  return { status, headers, body };
}

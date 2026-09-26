'use strict';

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

// Follow path redirects explicitly, preserving configured headers and RPC bodies.
// Never forward credentials to another origin or downgrade HTTPS to HTTP.
function createRemoteFetch(fetchImpl = fetch) {
  return async (input, init = {}) => {
    let url = new URL(input);
    const method = (init.method || 'GET').toUpperCase();
    for (let redirects = 0; ; redirects++) {
      const response = await fetchImpl(url, { ...init, method, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('MCP redirect is missing a Location header.');
      if (redirects >= 5) throw new Error('Too many MCP redirects.');
      const next = new URL(location, url);
      if (next.origin !== url.origin || next.username || next.password) {
        throw new Error('MCP redirect changed origin. Configure the final server URL explicitly.');
      }
      // A JSON-RPC POST must not silently become a GET on a 301/302/303.
      if (method !== 'GET' && method !== 'HEAD' && ![307, 308].includes(response.status)) {
        throw new Error(`MCP ${method} redirect requires HTTP 307 or 308 to preserve the request body.`);
      }
      url = next;
    }
  };
}

async function connectRemoteMcp(definition, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const url = new URL(definition.url);
  const remoteFetch = createRemoteFetch(fetchImpl);
  const headers = new Headers(definition.headers || {});
  const controller = new AbortController();
  let client, transport, timer;
  // Abort the network request as well as rejecting connect on timeout.
  const request = (input, init = {}) => remoteFetch(input, {
    ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
  });
  const connect = async kind => {
    controller.signal.throwIfAborted();
    client = new Client({ name: 'llm-desktop-assistant', version: '1.0.0' }, { capabilities: {} });
    const options = { requestInit: { headers }, fetch: request };
    transport = kind === 'sse'
      ? new SSEClientTransport(url, {
        ...options,
        // Only the event stream uses GET. SDK send() still POSTs JSON-RPC to
        // the separate endpoint advertised by the SSE server.
        eventSourceInit: { fetch: (input, init) => request(input, { ...init, method: 'GET', body: undefined }) },
      })
      : new StreamableHTTPClientTransport(url, options);
    await client.connect(transport, { timeout: timeoutMs });
    return client;
  };
  try {
    return await Promise.race([
      (async () => {
        try { return await connect(definition.transport === 'streamable-http' ? 'streamable-http' : 'sse'); }
        catch (error) {
          // Only an SSE endpoint rejection permits protocol detection. Do not
          // retry auth, RPC, timeout, or tool-discovery failures as another protocol.
          if (definition.transport || ![404, 405].includes(error.code) || controller.signal.aborted) throw error;
          await client.close().catch(() => {});
          await transport.close().catch(() => {});
          return connect('streamable-http');
        }
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('MCP connection timed out.');
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    controller.abort(error);
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    if (error.code === 405) {
      throw new Error('SSE GET rejected (HTTP 405). Check the SSE URL or use transport: "streamable-http" for a Streamable HTTP endpoint.', { cause: error });
    }
    throw error;
  } finally { clearTimeout(timer); }
}

module.exports = { connectRemoteMcp, createRemoteFetch };

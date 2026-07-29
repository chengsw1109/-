import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const port = 3201;
const child = spawn(process.execPath, ["dist/__entry.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    __PORT: String(port),
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SECRET_KEY: "integration-test-secret-key",
    MCP_AUTH_TOKEN: "integration-test-mcp-token",
    PTT_MCP_SHARED_SECRET: "integration-test-shared-secret",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

const url = `http://127.0.0.1:${port}/mcp`;
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "integration-test", version: "1.0.0" },
  },
};

async function waitUntilReady() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(initialize),
      });
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("MCP test server did not become ready");
}

try {
  await waitUntilReady();
  const denied = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(initialize),
  });
  assert.equal(denied.status, 401);

  const allowed = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer integration-test-mcp-token",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(initialize),
  });
  assert.notEqual(allowed.status, 401);
  assert.equal(allowed.ok, true);
  console.log("MCP bearer authentication test passed");
} finally {
  child.kill();
}

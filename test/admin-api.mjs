import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 3199;
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    PTT_MCP_SHARED_SECRET: 'integration-test-secret',
    SUPABASE_URL: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

async function waitUntilReady() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('PTT test server did not become ready');
}

try {
  const health = await waitUntilReady();
  assert.equal(health.ok, true);
  assert.equal(health.diagnostics.persistenceConfigured, false);

  const denied = await fetch(`${baseUrl}/api/admin/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId: 'general', message: 'test' }),
  });
  assert.equal(denied.status, 401);

  const allowed = await fetch(`${baseUrl}/api/admin/notify`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer integration-test-secret',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channelId: 'general', message: 'integration test' }),
  });
  assert.equal(allowed.status, 200);
  const result = await allowed.json();
  assert.equal(result.success, true);
  assert.equal(result.channelId, 'general');
  assert.equal(result.recipientCount, 0);
  console.log('admin API integration test passed');
} finally {
  child.kill();
}

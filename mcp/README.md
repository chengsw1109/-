# Browser PTT MCP

Tool-only Skybridge MCP server for querying Browser PTT diagnostics stored in
Supabase and sending an administrator notification through the PTT backend.

## Run locally

The root `.env` is loaded automatically.

```powershell
npm install
npm run dev
```

The MCP endpoint is `http://localhost:3100/mcp`.

Required environment variables are documented in the repository root
`.env.example`.

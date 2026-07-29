import { skybridge } from "skybridge/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [skybridge()],
  server: {
    port: Number(process.env.MCP_PORT) || 3100,
    forwardConsole: {
      unhandledErrors: true,
      logLevels: ["error"],
    },
  },
});

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: { ADMIN_SECRET: "secret", OPENROUTER_API_KEY: "", DRY_RUN: "false", CF_ZONE_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", CF_ZONE_NAME: "example.org", CF_API_TOKEN: "fake-token", SINKHOLE_SCRIPT_NAME: "graveyard-shift" } }
  })]
});

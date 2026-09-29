export interface AppEnv extends Cloudflare.Env {
  ADMIN_SECRET: string;
  OPENROUTER_API_KEY: string;
  CF_ZONE_ID?: string;
  CF_ZONE_NAME?: string;
  CF_API_TOKEN?: string;
  SINKHOLE_SCRIPT_NAME?: string;
}

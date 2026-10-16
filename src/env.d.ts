// Секрети й прив'язки, яких немає в wrangler.jsonc (wrangler types бачить секрети лише з .dev.vars).
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

interface TimerSecrets {
  /** wrangler secret put SESSION_SECRET — щонайменше 32 випадкові символи. */
  SESSION_SECRET: string;
  /** wrangler secret put GITHUB_CLIENT_SECRET */
  GITHUB_CLIENT_SECRET: string;
  /** Додає OAuthProvider для defaultHandler. */
  OAUTH_PROVIDER: OAuthHelpers;
}

declare global {
  interface Env extends TimerSecrets {}
  namespace Cloudflare {
    interface Env extends TimerSecrets {}
  }
}
export {};

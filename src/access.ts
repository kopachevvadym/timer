/**
 * Захист у глибину: Cloudflare Access уже стоїть перед доменом, але Worker
 * додатково перевіряє JWT від Access (заголовок Cf-Access-Jwt-Assertion).
 * Access видає такий JWT і для входу через браузер, і для service token.
 *
 * Якщо ACCESS_TEAM_DOMAIN або ACCESS_AUD порожні — перевірка вимкнена (wrangler dev).
 */
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function accessEnabled(env: Env): boolean {
  return Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
}

export async function verifyAccess(request: Request, env: Env): Promise<boolean> {
  if (!accessEnabled(env)) return true;
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) {
    logReject(request, 'no_assertion');
    return false;
  }
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByIssuer.set(issuer, jwks);
  }
  try {
    await jwtVerify(token, jwks, { issuer, audience: env.ACCESS_AUD });
    return true;
  } catch (e) {
    let claims: Record<string, unknown> = {};
    try {
      const c = decodeJwt(token);
      claims = { iss: c.iss, aud: c.aud, type: c.type, has_email: Boolean(c.email) };
    } catch {
      claims = { undecodable: true };
    }
    logReject(request, (e as { code?: string }).code ?? 'verify_failed', claims);
    return false;
  }
}

// Причина відмови в логах Worker (без самого токена) — щоб розбирати збої OAuth-конекторів.
function logReject(request: Request, reason: string, claims?: Record<string, unknown>) {
  const url = new URL(request.url);
  console.warn(JSON.stringify({ access_reject: reason, method: request.method, path: url.pathname, ...claims }));
}

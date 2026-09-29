import type { AppEnv } from "./env";

const cookieName = "graveyard_session";
const encoder = new TextEncoder();

async function signature(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sessionCookie(secret: string, secure: boolean): Promise<string> {
  const expires = String(Math.floor(Date.now() / 1000) + 12 * 60 * 60);
  return `${cookieName}=${expires}.${await signature(secret, expires)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;
}

export async function isAuthorized(request: Request, env: AppEnv): Promise<{ allowed: boolean; cookie: boolean }> {
  if (!env.ADMIN_SECRET) return { allowed: false, cookie: false };
  if (request.headers.get("x-admin-secret") === env.ADMIN_SECRET) return { allowed: true, cookie: false };
  const token = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!token) return { allowed: false, cookie: false };
  const match = /^(\d{10})\.([a-f0-9]{64})$/.exec(token);
  if (!match || Number(match[1]) < Math.floor(Date.now() / 1000)) return { allowed: false, cookie: false };
  const expected = await signature(env.ADMIN_SECRET, match[1]);
  const a = encoder.encode(match[2]);
  const b = encoder.encode(expected);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return { allowed: difference === 0, cookie: difference === 0 };
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
}

export function loginPage(error = false): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Enter · Graveyard Shift</title><style>body{min-height:100vh;display:grid;place-items:center;margin:0;background:#10131b;color:#f8f2e8;font:16px system-ui}main{width:min(90vw,390px);padding:40px;border:1px solid #524b43;border-radius:16px;background:#1d2029}small{color:#d5ae76;letter-spacing:.2em;text-transform:uppercase}h1{font:40px Georgia,serif;margin:14px 0 28px}label{display:block;margin-bottom:10px}input{box-sizing:border-box;width:100%;padding:14px;background:#11141b;border:1px solid #756b61;border-radius:8px;color:white;font:inherit}button{width:100%;padding:14px;margin-top:18px;background:#d5ae76;border:0;border-radius:8px;color:#15171d;font-weight:700;cursor:pointer}.error{color:#ff9b9b}</style></head><body><main><small>Restricted workspace</small><h1>Graveyard Shift</h1>${error ? '<p class="error">Invalid admin secret.</p>' : ""}<form method="post" action="/login"><label for="secret">Admin secret</label><input id="secret" name="secret" type="password" autocomplete="current-password" required><button type="submit">Enter the graveyard</button></form></main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });
}

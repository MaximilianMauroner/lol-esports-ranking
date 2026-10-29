export const SESSION_COOKIE = "rift_delta_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

function sessionSecret(): string {
  const secret = process.env.PROTOTYPE_SESSION_SECRET;
  if (!secret) throw new Error("PROTOTYPE_SESSION_SECRET is not configured");
  return secret;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))),
  );
}

export async function createSessionToken(now = Date.now()): Promise<string> {
  const expires = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const nonceBytes = new Uint8Array(24);
  crypto.getRandomValues(nonceBytes);
  const payload = `${expires}.${base64Url(nonceBytes)}`;
  return `${payload}.${await hmac(payload)}`;
}

export async function verifySessionToken(
  token: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expiresText, nonce, supplied] = parts;
  const expires = Number(expiresText);
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(now / 1000) || !nonce) return false;
  try {
    const expected = await hmac(`${expiresText}.${nonce}`);
    return constantTimeEqual(fromBase64Url(supplied!), fromBase64Url(expected));
  } catch {
    return false;
  }
}

export async function passwordMatches(candidate: string): Promise<boolean> {
  const expected = process.env.PROTOTYPE_ACCESS_PASSWORD;
  if (!expected || !candidate) return false;
  return constantTimeEqual(new TextEncoder().encode(candidate), new TextEncoder().encode(expected));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

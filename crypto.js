// crypto.js
const te = new TextEncoder();
const td = new TextDecoder();

function b64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}
function unb64(str) {
  return new Uint8Array([...atob(str)].map((c) => c.charCodeAt(0)));
}

export async function deriveKey(passphrase, salt) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    te.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 210000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptString(passphrase, plaintext) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);

  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    te.encode(plaintext),
  );

  return JSON.stringify({
    v: 1,
    salt: b64(salt),
    iv: b64(iv),
    ct: b64(new Uint8Array(ct)),
  });
}

export async function decryptString(passphrase, payloadJson) {
  if (!payloadJson) return ""; // empty journal file

  const payload = JSON.parse(payloadJson);
  if (payload.v !== 1)
    throw new Error("Unknown encryption version: " + payload.v);

  const salt = unb64(payload.salt);
  const iv = unb64(payload.iv);
  const ct = unb64(payload.ct);

  const key = await deriveKey(passphrase, salt);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);

  return td.decode(pt);
}

// FNV-1a de 64 bits para identificadores locales reproducibles. No es una contraseña, una firma
// ni una frontera criptográfica; nunca debe usarse para autenticar o autorizar.
export function stableToken(value) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(String(value))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36).padStart(13, '0');
}

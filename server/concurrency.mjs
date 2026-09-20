// Primitiva compartida para que los adaptadores de disco no lancen una operacion por agente a la vez.
// Conserva el orden de entrada y propaga el primer fallo, igual que Promise.all.

export async function mapLimit(items, rawLimit, fn) {
  const values = Array.from(items);
  if (!values.length) return [];
  const limit = Math.max(1, Math.min(values.length, Math.trunc(Number(rawLimit)) || 1));
  const results = new Array(values.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await fn(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

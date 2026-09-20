import { randomUUID } from 'node:crypto';

export const systemIds = { next: () => randomUUID() };

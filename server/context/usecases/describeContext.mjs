// Lectura para la interfaz: contexto, memoria, cobertura y genealogía de motores.
import { coverage, engineLineage } from '../domain/record.mjs';

export class DescribeContext {
  /** @param {{gateway: import('./contextGateway.mjs').ContextGateway}} deps */
  constructor({ gateway }) { this.gateway = gateway; }

  /**
   * @param {{cwd: string}} input
   * @returns {Promise<{context: object, record: object, coverage: object, lineage: object[], canHandoff: boolean}>}
   */
  async run({ cwd }) {
    if (!cwd) throw Object.assign(new Error('hace falta un directorio'), { status: 400 });
    const { workspace, record } = await this.gateway.resolve(cwd);
    const cov = coverage(record);
    return {
      context: { id: record.contextId, ...workspace },
      record,
      coverage: cov,
      lineage: engineLineage(record),
      // Ya no depende de saber leer el formato del motor de origen: depende de tener memoria.
      canHandoff: cov.handoffReady,
    };
  }
}

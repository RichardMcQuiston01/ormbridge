import type { OrmbridgePlugin } from 'ormbridge';
import { kotlinAdapter } from './kotlinFormat.js';

export { parseKotlin, isSkippedKotlinPath } from './kotlinReader.js';
export { emitKotlin } from './kotlinWriter.js';
export type { KotlinEmitOptions } from './kotlinWriter.js';
export { kotlinAdapter } from './kotlinFormat.js';

const plugin: OrmbridgePlugin = {
  name: 'ormbridge-kotlin',
  formats: [kotlinAdapter],
};

export default plugin;

import type { OrmbridgePlugin } from 'ormbridge';
import { springDataAdapter, springDataKotlinAdapter } from './springFormat.js';

export {
  emitSpringData,
  emitSpringDataKotlin,
  springDataAdapter,
  springDataKotlinAdapter,
} from './springFormat.js';
export type { SpringDataEmitOptions } from './springFormat.js';

const plugin: OrmbridgePlugin = {
  name: 'ormbridge-spring-data',
  formats: [springDataAdapter, springDataKotlinAdapter],
};

export default plugin;

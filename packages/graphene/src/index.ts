import {
  ok,
  type EmitOutput,
  type FormatAdapter,
  type IrSchema,
  type OrmbridgePlugin,
  type Result,
} from 'ormbridge';
import { emitGraphene } from './graphene.js';

export { emitGraphene } from './graphene.js';

export const grapheneAdapter: FormatAdapter = {
  name: 'graphene',
  // No extension is claimed: ".py" belongs to Django, so pass --to graphene.
  extensions: [],
  description: 'Graphene (graphene-django) GraphQL schema',
  emit: (schema: IrSchema): Result<EmitOutput> => ok(emitGraphene(schema)),
};

const plugin: OrmbridgePlugin = {
  name: 'ormbridge-graphene',
  formats: [grapheneAdapter],
};

export default plugin;

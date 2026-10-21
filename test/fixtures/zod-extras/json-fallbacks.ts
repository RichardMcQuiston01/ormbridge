// Properties the shared model has no column type for. Runs unchanged with Zod 3.25 and Zod 4.
import { z } from 'zod';

export const PayloadSchema = z.object({
  id: z.number().int(),
  address: z.object({ street: z.string(), city: z.string() }),
  point: z.tuple([z.number(), z.number()]),
  either: z.union([z.string(), z.number()]),
  shape: z.discriminatedUnion('type', [
    z.object({ type: z.literal('a'), a: z.string() }),
    z.object({ type: z.literal('b'), b: z.number() }),
  ]),
  both: z.intersection(
    z.object({ a: z.string() }),
    z.object({ b: z.string() })
  ),
  dictionary: z.record(z.string(), z.number()),
  nothing: z.null(),
  maybe: z.string().or(z.null()),
  fixed: z.literal('exact'),
  count: z.literal(3),
});

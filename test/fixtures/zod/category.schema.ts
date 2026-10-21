import { z } from 'zod';
import { timeStamped } from './time-stamped';

export const CategorySchema = z.object({
  id: z.number().int(),
  ...timeStamped,
  name: z.string().max(100),
  slug: z.string().max(50),
  parent_id: z.number().int().nullable(),
});
export type Category = z.infer<typeof CategorySchema>;

import { z } from 'zod';

export const TagSchema = z.object({
  id: z.number().int(),
  label: z.string().max(50),
});
export type Tag = z.infer<typeof TagSchema>;

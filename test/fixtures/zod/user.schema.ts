import { z } from 'zod';

export const UserSchema = z.object({
  id: z.number().int(),
});
export type User = z.infer<typeof UserSchema>;

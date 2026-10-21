import { z } from 'zod';

export const ProfileSchema = z.object({
  id: z.number().int(),
  bio: z.string().nullable(),
  avatar: z.string().max(100).nullable(),
  user_id: z.number().int(),
});
export type Profile = z.infer<typeof ProfileSchema>;

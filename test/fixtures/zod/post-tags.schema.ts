import { z } from 'zod';

// The join table is an ordinary schema: Zod has no many-to-many.
export const PostTagsSchema = z.object({
  id: z.number().int(),
  post_id: z.number().int(),
  tag_id: z.number().int(),
});
export type PostTags = z.infer<typeof PostTagsSchema>;

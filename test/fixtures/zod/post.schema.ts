import { z } from 'zod';
import { PostStatusSchema } from './post-status.enum';
import { timeStamped } from './time-stamped';

export const PostSchema = z.object({
  id: z.number().int(),
  ...timeStamped,
  public_id: z.uuid(),
  title: z.string().max(200),
  body: z.string(),
  status: PostStatusSchema.default('draft'),
  rating: z
    .string()
    .regex(/^-?\d{1,2}(\.\d{1,2})?$/)
    .nullable(),
  view_count: z.number().int().default(0),
  is_featured: z.boolean().default(false),
  published_at: z.coerce.date().default(() => new Date()),
  metadata: z.record(z.string(), z.unknown()).default({}),
  author_id: z.number().int(),
  editor_id: z.number().int().nullable(),
  category_id: z.number().int(),
});
export type Post = z.infer<typeof PostSchema>;

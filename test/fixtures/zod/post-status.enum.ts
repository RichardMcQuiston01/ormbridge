import { z } from 'zod';

export const PostStatus = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
} as const;
export const PostStatusSchema = z.enum(PostStatus);
export type PostStatus = z.infer<typeof PostStatusSchema>;

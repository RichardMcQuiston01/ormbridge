// Schemas that hold other schemas. Runs unchanged with Zod 3.25 and Zod 4 (z.lazy closes the cycles).
import { z } from 'zod';

export const AuthorSchema = z.object({
  id: z.number().int(),
  name: z.string().max(60),
});

export const TopicSchema = z.object({
  id: z.number().int(),
  label: z.string().max(30),
});

export const ArticleSchema = z.object({
  id: z.number().int(),
  title: z.string().max(120),
  author: AuthorSchema,
  editor: AuthorSchema.nullable(),
  reviewer: AuthorSchema.optional(),
  topics: z.array(TopicSchema),
});

export type Comment = z.infer<typeof CommentSchema> & { replies?: Comment[] };

export const CommentSchema = z.object({
  id: z.number().int(),
  body: z.string(),
  article: z.lazy(() => ArticleSchema),
});

// Zod Mini (`zod/mini`): the same schemas as the full library, written with functions. Rules go in `.check(...)`,
// wrappers are functions (`z.optional(...)`, `z._default(...)`), and an object is derived with `z.pick`, `z.omit`,
// `z.partial` and `z.extend`. Needs Zod 4.
import * as z from 'zod/mini';

export const Role = z.enum(['admin', 'editor', 'reader']);

export const Writer = z.object({
  id: z.uuid(),
  email: z.email().check(z.maxLength(120)),
  name: z.string().check(z.minLength(1), z.maxLength(80)),
  age: z.optional(z.int().check(z.gte(0), z.lte(150))),
  bio: z.nullable(z.string()),
  nickname: z.nullish(z.string().check(z.maxLength(30))),
  role: z._default(Role, 'reader'),
  active: z._default(z.boolean(), true),
  joinedAt: z.iso.datetime(),
  tags: z.array(z.string().check(z.maxLength(20))),
});

export const Story = z.object({
  id: z.uuid(),
  writer: Writer,
  reviewer: z.optional(Writer),
  title: z.string().check(z.maxLength(200)),
  slug: z.string().check(z.regex(/^[a-z0-9-]+$/)),
  views: z.int(),
  score: z.number(),
  publishedAt: z.optional(z.iso.date()),
  notes: z.optional(z.nullable(z.string())),
});

export const StorySummary = z.pick(Story, { id: true, title: true });
export const StoryBody = z.omit(Story, { id: true, writer: true });
export const StoryDraft = z.partial(
  z.omit(Story, { writer: true, reviewer: true })
);
export const WriterProfile = z.extend(Writer, {
  website: z.nullable(z.url()),
  followers: z._default(z.int(), 0),
});

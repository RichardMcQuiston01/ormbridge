// Zod 3 spelling: string formats are methods of z.string(). Runs unchanged with Zod 3.25 and Zod 4.
import { z } from 'zod';

export enum Plan {
  Free = 'free',
  Pro = 'pro',
}

const ROLES = ['admin', 'member', 'guest'] as const;

export const AccountSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email().max(120),
  handle: z.string().min(3).max(30).trim(),
  age: z.number().int().min(0).optional(),
  score: z.number().nullable(),
  ledger: z.bigint(),
  active: z.boolean().default(true),
  joined: z.date(),
  born: z.string().date().nullish(),
  seen: z.string().datetime().optional(),
  website: z.string().url().nullable(),
  bio: z.string().describe('About the account').optional(),
  tags: z.array(z.string()).default([]),
  scores: z.array(z.number().int()),
  grid: z.array(z.array(z.number())),
  settings: z.record(z.string(), z.any()),
  extra: z.unknown(),
  role: z.enum(ROLES).default('member'),
  kind: z.union([z.literal('person'), z.literal('company')]),
  plan: z.nativeEnum(Plan),
  nickname: z.string().optional().default('anon'),
  locale: z.string().length(5),
  token: z.string().brand<'Token'>(),
  checked: z
    .string()
    .refine((value) => value.length > 1)
    .transform((value) => value.trim()),
  flag: z.coerce.boolean(),
  count: z.coerce.number().int(),
  stamp: z.coerce.date(),
});

export type Account = z.infer<typeof AccountSchema>;

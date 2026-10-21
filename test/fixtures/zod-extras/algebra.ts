// extend, merge, pick, omit, partial and required on named schemas. Runs unchanged with Zod 3.25 and Zod 4.
import { z } from 'zod';

const audit = {
  created_at: z.date(),
  created_by: z.string().max(40),
};

export const BaseSchema = z.object({
  id: z.number().int(),
  name: z.string().max(80),
  note: z.string().optional(),
});

export const ExtendedSchema = BaseSchema.extend({
  active: z.boolean().default(true),
  note: z.string().max(200).nullable(),
});

export const PickedSchema = ExtendedSchema.pick({ id: true, name: true });

export const OmittedSchema = ExtendedSchema.omit({ note: true });

export const PartialSchema = BaseSchema.partial();

export const SomePartialSchema = BaseSchema.partial({ name: true });

export const RequiredSchema = BaseSchema.required();

export const MergedSchema = BaseSchema.merge(
  z.object({ extra: z.number().int() })
);

export const SpreadSchema = z.object({
  ...BaseSchema.shape,
  ...audit,
  title: z.string(),
});

export const StrictSchema = BaseSchema.extend({ flag: z.boolean() }).strict();

// Zod 4 spelling: string formats are top-level functions and z.iso holds the date formats. Needs Zod 4.
import { z } from 'zod';

export const Colour = {
  Red: 'red',
  Green: 'green',
} as const;

export const ColourSchema = z.enum(Colour);

export const DeviceSchema = z.object({
  id: z.int(),
  serial: z.uuid(),
  owner: z.email(),
  home: z.url().nullable(),
  slug: z.nanoid(),
  addr: z.ipv4(),
  addr6: z.ipv6().optional(),
  signature: z.base64(),
  firmware: z.int32(),
  weight: z.float64(),
  huge: z.int64(),
  seen: z.iso.datetime(),
  built: z.iso.date().nullable(),
  uptime: z.iso.duration(),
  boot: z.iso.time(),
  colour: ColourSchema,
  trim: ColourSchema.nullable(),
  data: z.json(),
  note: z.string().max(40).nullish(),
  flags: z.array(ColourSchema),
  stringy: z.stringbool(),
});

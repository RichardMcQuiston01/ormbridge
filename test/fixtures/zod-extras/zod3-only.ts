// Zod 3 only: string.ip() and string.cuid() were removed or changed in Zod 4. Run with Zod 3.25.
import { z } from 'zod';

export const HostSchema = z.object({
  id: z.string().cuid(),
  address: z.string().ip(),
  mac: z.string().length(17),
  notes: z.string().nonempty().optional(),
});

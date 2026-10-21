import { z } from 'zod';

// Not a model: a plain object of properties that other schemas spread into their own.
export const timeStamped = {
  created_at: z.coerce.date().default(() => new Date()),
  updated_at: z.coerce.date(),
};

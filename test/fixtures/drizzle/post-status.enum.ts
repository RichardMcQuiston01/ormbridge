import { pgEnum } from 'drizzle-orm/pg-core';

export const postStatus = pgEnum('post_status', ['draft', 'published']);

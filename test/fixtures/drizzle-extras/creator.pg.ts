import * as pg from 'drizzle-orm/pg-core';
import { pgTableCreator, text as txt } from 'drizzle-orm/pg-core';

// Every table made with createTable gets the "acme_" prefix.
export const createTable = pgTableCreator((name) => `acme_${name}`);

const audit = {
  actor: txt('actor').notNull(),
  at: pg.timestamp('at').defaultNow(),
};

export const widgets = createTable('widgets', {
  id: pg.uuid('id').primaryKey().defaultRandom(),
  name: txt('name').notNull(),
  ...audit,
});

export const gadgets = pg.pgTable('gadgets', {
  id: pg.bigserial('id', { mode: 'number' }).primaryKey(),
  widgetId: pg.uuid('widget_id').references(() => widgets.id),
  extra: pg.macaddr('extra'),
  size: pg.bigint('size', { mode: 'number' }).default(10),
  ...audit,
});

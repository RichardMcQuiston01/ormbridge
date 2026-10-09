import { relations, sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgSchema,
  pgView,
  point,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  vector,
} from 'drizzle-orm/pg-core';

// Everything in this file lives in the PostgreSQL schema "shop".
export const shop = pgSchema('shop');

export const role = shop.enum('customer_role', [
  'customer',
  'staff',
  'super-admin',
]);

export const customers = shop.table(
  'customers',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    email: varchar('email', { length: 255 })
      .notNull()
      .unique('customers_email_key'),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    fullName: text('full_name').generatedAlwaysAs(
      sql`first_name || ' ' || last_name`
    ),
    role: role('role').notNull().default('customer'),
    balance: numeric('balance', { precision: 12, scale: 2 })
      .notNull()
      .default('0.00'),
    labels: text('labels').array(),
    grid: integer('grid').array().array(),
    location: point('location'),
    embedding: vector('embedding', { dimensions: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    createdIdx: index('customers_created_idx').on(table.createdAt.desc()),
    labelsIdx: index('customers_labels_idx').using('gin', table.labels),
    nameIdx: index('customers_name_idx').on(
      table.lastName,
      table.firstName.desc()
    ),
    activeEmail: uniqueIndex('customers_active_email')
      .on(table.email)
      .where(sql`deleted_at is null`),
    lowerEmail: index('customers_lower_email').on(sql`lower(${table.email})`),
  })
);

export const products = shop.table('products', {
  sku: varchar('sku', { length: 32 }).primaryKey(),
  title: text('title').notNull(),
  price: numeric('price', { precision: 10, scale: 2 }).notNull(),
});

export const orders = shop.table(
  'orders',
  {
    id: serial('id').primaryKey(),
    customerId: integer('customer_id')
      .notNull()
      .references(() => customers.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    // Points at a column that is not the primary key.
    customerEmail: varchar('customer_email', { length: 255 }).references(
      () => customers.email,
      { onDelete: 'set null' }
    ),
    placedAt: timestamp('placed_at').$defaultFn(() => new Date()),
    reference: text('reference').$defaultFn(() => crypto.randomUUID()),
    note: text('note').$defaultFn(() => 'none'),
    total: numeric('total', { precision: 10, scale: 2 }).notNull(),
  },
  (table) => [
    check('orders_total_positive', sql`${table.total} > 0`),
    index('orders_customer_idx').on(table.customerId),
  ]
);

export const orderLines = shop.table(
  'order_lines',
  {
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    sku: varchar('sku', { length: 32 })
      .notNull()
      .references(() => products.sku),
    quantity: integer('quantity').notNull().default(1),
  },
  (table) => [
    primaryKey({
      name: 'order_lines_pk',
      columns: [table.orderId, table.lineNo],
    }),
  ]
);

export const bins = shop.table(
  'bins',
  {
    aisle: integer('aisle').notNull(),
    shelf: integer('shelf').notNull(),
    label: text('label'),
  },
  (table) => [primaryKey({ columns: [table.aisle, table.shelf] })]
);

export const shipments = shop.table(
  'shipments',
  {
    id: serial('id').primaryKey(),
    aisle: integer('aisle'),
    shelf: integer('shelf'),
    shippedAt: timestamp('shipped_at'),
  },
  (table) => [
    foreignKey({
      name: 'shipments_bin_fk',
      columns: [table.aisle, table.shelf],
      foreignColumns: [bins.aisle, bins.shelf],
    })
      .onDelete('cascade')
      .onUpdate('restrict'),
  ]
);

export const activeCustomers = pgView('active_customers').as((qb) =>
  qb.select().from(customers)
);

export const customersRelations = relations(customers, ({ many }) => ({
  orders: many(orders),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, {
    fields: [orders.customerId],
    references: [customers.id],
  }),
  lines: many(orderLines),
}));

export const orderLinesRelations = relations(orderLines, ({ one }) => ({
  order: one(orders, {
    fields: [orderLines.orderId],
    references: [orders.id],
  }),
  product: one(products, {
    fields: [orderLines.sku],
    references: [products.sku],
  }),
}));

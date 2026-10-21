import { Customer } from './customer.js';
import { Order } from './order.js';
import { OrderItem } from './orderItem.js';
import { Product } from './product.js';
import { Label } from './label.js';
import { Comment } from './comment.js';

export { Customer, Order, OrderItem, Product, Label, Comment };

/**
 * Every model of the schema. Sequelize 7 takes them in its constructor, together with the dialect, which
 * is a class from its own package (npm install @sequelize/core @sequelize/postgres):
 *
 *   import { Sequelize } from '@sequelize/core';
 *   import { PostgresDialect } from '@sequelize/postgres';
 *   import { models } from './models/index.js';
 *
 *   const sequelize = new Sequelize({ dialect: PostgresDialect, url: process.env.DATABASE_URL, models });
 */
export const models = [Customer, Order, OrderItem, Product, Label, Comment];

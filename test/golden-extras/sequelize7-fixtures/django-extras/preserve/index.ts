import { Item } from './item.js';
import { Counter } from './counter.js';
import { Shipment } from './shipment.js';
import { Account } from './account.js';
import { Assignment } from './assignment.js';
import { ContentType } from './contentType.js';

export { Item, Counter, Shipment, Account, Assignment, ContentType };

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
export const models = [Item, Counter, Shipment, Account, Assignment, ContentType];

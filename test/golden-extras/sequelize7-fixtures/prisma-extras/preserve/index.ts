import { Order } from './order.js';
import { OrderLine } from './orderLine.js';
import { Account } from './account.js';
import { Tenant } from './tenant.js';
import { Profile } from './profile.js';
import { Document } from './document.js';
import { Scratch } from './scratch.js';
import { DocumentSummary } from './documentSummary.js';

export { Order, OrderLine, Account, Tenant, Profile, Document, Scratch, DocumentSummary };

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
export const models = [Order, OrderLine, Account, Tenant, Profile, Document, Scratch, DocumentSummary];

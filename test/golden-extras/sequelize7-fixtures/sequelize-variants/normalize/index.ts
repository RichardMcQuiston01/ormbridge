import { Account } from './account.js';
import { Person } from './person.js';
import { AuditEntry } from './auditEntry.js';
import { Group } from './group.js';
import { Membership } from './membership.js';
import { Order } from './order.js';
import { Setting } from './setting.js';
import { Event } from './event.js';
import { Ticket } from './ticket.js';
import { Country } from './country.js';
import { City } from './city.js';

export { Account, Person, AuditEntry, Group, Membership, Order, Setting, Event, Ticket, Country, City };

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
export const models = [Account, Person, AuditEntry, Group, Membership, Order, Setting, Event, Ticket, Country, City];

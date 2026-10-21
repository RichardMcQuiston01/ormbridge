import { Account } from './account.js';
import { Session } from './session.js';
import { Group } from './group.js';
import { Membership } from './membership.js';
import { Profile } from './profile.js';
import { LegacyOrder } from './legacyOrder.js';

export { Account, Session, Group, Membership, Profile, LegacyOrder };

/**
 * Every model of the schema. Sequelize 7 takes them in its constructor, together with the dialect, which
 * is a class from its own package (npm install @sequelize/core @sequelize/sqlite3):
 *
 *   import { Sequelize } from '@sequelize/core';
 *   import { SqliteDialect } from '@sequelize/sqlite3';
 *   import { models } from './models/index.js';
 *
 *   const sequelize = new Sequelize({ dialect: SqliteDialect, storage: 'database.sqlite', models });
 */
export const models = [Account, Session, Group, Membership, Profile, LegacyOrder];

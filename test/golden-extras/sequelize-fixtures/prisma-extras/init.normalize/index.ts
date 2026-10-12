import type { Sequelize } from 'sequelize';
import { Order } from './order.js';
import { OrderLine } from './orderLine.js';
import { Account } from './account.js';
import { Tenant } from './tenant.js';
import { Profile } from './profile.js';
import { Document } from './document.js';
import { Scratch } from './scratch.js';
import { DocumentSummary } from './documentSummary.js';

export { Order, OrderLine, Account, Tenant, Profile, Document, Scratch, DocumentSummary };

/** Initializes every model on a Sequelize instance, then sets up the associations. */
export function initModels(sequelize: Sequelize) {
  Order.initModel(sequelize);
  OrderLine.initModel(sequelize);
  Account.initModel(sequelize);
  Tenant.initModel(sequelize);
  Profile.initModel(sequelize);
  Document.initModel(sequelize);
  Scratch.initModel(sequelize);
  DocumentSummary.initModel(sequelize);

  Account.belongsTo(Tenant, {
    as: 'tenant',
    foreignKey: 'tenantId',
    onDelete: 'NO ACTION',
  });

  Profile.belongsTo(Account, {
    as: 'account',
    foreignKey: 'accountId',
    onDelete: 'RESTRICT',
  });
  Account.hasOne(Profile, {
    as: 'profile',
    foreignKey: 'accountId',
    onDelete: 'RESTRICT',
  });

  return { Order, OrderLine, Account, Tenant, Profile, Document, Scratch, DocumentSummary };
}

export type Models = ReturnType<typeof initModels>;

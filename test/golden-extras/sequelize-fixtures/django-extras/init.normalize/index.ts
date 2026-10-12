import type { Sequelize } from 'sequelize';
import { Item } from './item.js';
import { Counter } from './counter.js';
import { Shipment } from './shipment.js';
import { Account } from './account.js';
import { Assignment } from './assignment.js';
import { ContentType } from './contentType.js';

export { Item, Counter, Shipment, Account, Assignment, ContentType };

/** Initializes every model on a Sequelize instance, then sets up the associations. */
export function initModels(sequelize: Sequelize) {
  Item.initModel(sequelize);
  Counter.initModel(sequelize);
  Shipment.initModel(sequelize);
  Account.initModel(sequelize);
  Assignment.initModel(sequelize);
  ContentType.initModel(sequelize);

  Shipment.belongsTo(Item, {
    as: 'item',
    foreignKey: 'itemId',
    onDelete: 'CASCADE',
  });
  Item.hasMany(Shipment, {
    as: 'shipments',
    foreignKey: 'itemId',
    onDelete: 'CASCADE',
  });

  Shipment.belongsTo(Item, {
    as: 'other',
    foreignKey: 'otherId',
    onDelete: 'CASCADE',
  });
  Item.hasMany(Shipment, {
    as: 'otherShipments',
    foreignKey: 'otherId',
    onDelete: 'CASCADE',
  });

  Shipment.belongsTo(ContentType, {
    as: 'contentType',
    foreignKey: 'contentTypeId',
    onDelete: 'CASCADE',
  });

  Shipment.belongsTo(Account, {
    as: 'createdBy',
    foreignKey: 'createdById',
    onDelete: 'CASCADE',
  });

  Assignment.belongsTo(Item, {
    as: 'item',
    foreignKey: 'itemId',
    onDelete: 'CASCADE',
  });

  Assignment.belongsTo(Account, {
    as: 'account',
    foreignKey: 'accountId',
    onDelete: 'CASCADE',
  });

  return { Item, Counter, Shipment, Account, Assignment, ContentType };
}

export type Models = ReturnType<typeof initModels>;

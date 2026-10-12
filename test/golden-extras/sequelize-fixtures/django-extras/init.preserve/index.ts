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
    foreignKey: 'item_id',
    onDelete: 'CASCADE',
  });
  Item.hasMany(Shipment, {
    as: 'shipments',
    foreignKey: 'item_id',
    onDelete: 'CASCADE',
  });

  Shipment.belongsTo(Item, {
    as: 'other',
    foreignKey: 'other_id',
    onDelete: 'CASCADE',
  });
  Item.hasMany(Shipment, {
    as: 'other_shipments',
    foreignKey: 'other_id',
    onDelete: 'CASCADE',
  });

  Shipment.belongsTo(ContentType, {
    as: 'content_type',
    foreignKey: 'content_type_id',
    onDelete: 'CASCADE',
  });

  Shipment.belongsTo(Account, {
    as: 'created_by',
    foreignKey: 'created_by_id',
    onDelete: 'CASCADE',
  });

  Assignment.belongsTo(Item, {
    as: 'item',
    foreignKey: 'item_id',
    onDelete: 'CASCADE',
  });

  Assignment.belongsTo(Account, {
    as: 'account',
    foreignKey: 'account_id',
    onDelete: 'CASCADE',
  });

  return { Item, Counter, Shipment, Account, Assignment, ContentType };
}

export type Models = ReturnType<typeof initModels>;

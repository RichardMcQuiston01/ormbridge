import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Account } from './account.js';

export class Order extends Model<
  InferAttributes<Order>,
  InferCreationAttributes<Order>
> {
  declare id: CreationOptional<number>;
  declare total: string;
  declare auditorId: CreationOptional<number | null>;
  declare AccountId: CreationOptional<number | null>;
  declare buyerId: CreationOptional<number | null>;
  declare referrerEmail: CreationOptional<string | null>;

  declare account?: NonAttribute<Account>;
  declare buyer?: NonAttribute<Account>;
  declare referrer?: NonAttribute<Account>;

  static initModel(sequelize: Sequelize): typeof Order {
    Order.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        total: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
        auditorId: DataTypes.INTEGER,
        AccountId: DataTypes.INTEGER,
        buyerId: DataTypes.INTEGER,
        referrerEmail: DataTypes.STRING(120),
      },
      { sequelize, modelName: 'Order', tableName: 'Orders', timestamps: false }
    );
    return Order;
  }
}

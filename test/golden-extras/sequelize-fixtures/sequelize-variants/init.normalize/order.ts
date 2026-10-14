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
  declare id: CreationOptional<string>;
  declare total: string;
  declare auditorId: CreationOptional<number | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare accountId: CreationOptional<string | null>;
  declare buyerId: CreationOptional<string | null>;
  declare referrerEmail: CreationOptional<string | null>;

  declare account?: NonAttribute<Account>;
  declare buyer?: NonAttribute<Account>;
  declare referrer?: NonAttribute<Account>;

  static initModel(sequelize: Sequelize): typeof Order {
    Order.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        total: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
        auditorId: DataTypes.INTEGER,
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        accountId: DataTypes.UUID,
        buyerId: DataTypes.UUID,
        referrerEmail: DataTypes.STRING(120),
      },
      {
        sequelize,
        modelName: 'Order',
        tableName: 'order',
        timestamps: true,
        underscored: true,
      }
    );
    return Order;
  }
}

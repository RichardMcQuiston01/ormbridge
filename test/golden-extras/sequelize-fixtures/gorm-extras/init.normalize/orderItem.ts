import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Order } from './order.js';
import type { Product } from './product.js';

export class OrderItem extends Model<
  InferAttributes<OrderItem>,
  InferCreationAttributes<OrderItem>
> {
  declare lineNo: number;
  declare quantity: CreationOptional<number>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare productSku: string;
  declare orderId: string;

  declare product?: NonAttribute<Product>;
  declare order?: NonAttribute<Order>;

  static initModel(sequelize: Sequelize): typeof OrderItem {
    OrderItem.init(
      {
        lineNo: { type: DataTypes.INTEGER, primaryKey: true },
        quantity: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 1,
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        productSku: { type: DataTypes.STRING(40), allowNull: false },
        orderId: { type: DataTypes.UUID, primaryKey: true },
      },
      {
        sequelize,
        modelName: 'OrderItem',
        tableName: 'order_item',
        timestamps: true,
        underscored: true,
      }
    );
    return OrderItem;
  }
}

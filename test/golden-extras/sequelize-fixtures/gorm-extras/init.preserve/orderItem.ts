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
  declare product_sku: string;
  declare order_id: string;

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
        product_sku: { type: DataTypes.STRING(40), allowNull: false },
        order_id: { type: DataTypes.UUID, primaryKey: true },
      },
      {
        sequelize,
        modelName: 'OrderItem',
        tableName: 'order_items',
        timestamps: false,
        underscored: true,
      }
    );
    return OrderItem;
  }
}

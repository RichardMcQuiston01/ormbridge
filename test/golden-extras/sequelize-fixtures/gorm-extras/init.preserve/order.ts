import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Customer } from './customer.js';
import type { Label } from './label.js';
import type { OrderItem } from './orderItem.js';

export class Order extends Model<
  InferAttributes<Order>,
  InferCreationAttributes<Order>
> {
  declare id: CreationOptional<string>;
  declare placedAt: CreationOptional<Date>;
  declare modifiedAt: string;
  declare total: string;
  declare note: string;
  declare customer_id: string;

  declare customer?: NonAttribute<Customer>;
  declare labels?: NonAttribute<Label[]>;
  declare items?: NonAttribute<OrderItem[]>;

  static initModel(sequelize: Sequelize): typeof Order {
    Order.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        placedAt: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: DataTypes.NOW,
        },
        modifiedAt: { type: DataTypes.BIGINT, allowNull: false },
        total: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
        note: { type: DataTypes.STRING(500), allowNull: false },
        customer_id: { type: DataTypes.BIGINT, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Order',
        tableName: 'shop_orders',
        timestamps: false,
        underscored: true,
        indexes: [
          {
            name: 'idx_order_customer_placed',
            fields: ['customer_id', { name: 'placed_at', order: 'DESC' }],
          },
        ],
      }
    );
    return Order;
  }
}

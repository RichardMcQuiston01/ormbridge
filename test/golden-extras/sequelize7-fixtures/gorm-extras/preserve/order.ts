import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from '@sequelize/core';
import {
  Attribute,
  BelongsTo,
  BelongsToMany,
  Default,
  NotNull,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import { Customer } from './customer.js';
import { Label } from './label.js';
import type { OrderItem } from './orderItem.js';

@Table({
  tableName: 'shop_orders',
  timestamps: false,
  underscored: true,
  indexes: [
    {
      name: 'idx_order_customer_placed',
      fields: ['customer_id', { name: 'placed_at', order: 'DESC' }],
    },
  ],
})
export class Order extends Model<
  InferAttributes<Order>,
  InferCreationAttributes<Order>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.DATE)
  @NotNull
  @Default(DataTypes.NOW)
  declare placedAt: CreationOptional<Date>;

  @Attribute(DataTypes.BIGINT)
  @NotNull
  declare modifiedAt: string;

  @Attribute(DataTypes.DECIMAL(12, 2))
  @NotNull
  declare total: string;

  @Attribute(DataTypes.STRING(500))
  @NotNull
  declare note: string;

  @Attribute(DataTypes.BIGINT)
  @NotNull
  declare customer_id: string;

  @BelongsTo(() => Customer, {
    foreignKey: { name: 'customer_id', onDelete: 'RESTRICT' },
    inverse: { type: 'hasMany', as: 'orders' },
  })
  declare customer?: NonAttribute<Customer>;

  @BelongsToMany(() => Label, {
    through: { model: 'shop_orders_labels', timestamps: false },
    foreignKey: 'order_id',
    otherKey: 'label_id',
  })
  declare labels?: NonAttribute<Label[]>;

  declare items?: NonAttribute<OrderItem[]>;
}

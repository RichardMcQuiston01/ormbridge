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
  Default,
  NotNull,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import { Order } from './order.js';
import { Product } from './product.js';

@Table({ tableName: 'order_items', timestamps: false, underscored: true })
export class OrderItem extends Model<
  InferAttributes<OrderItem>,
  InferCreationAttributes<OrderItem>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  declare lineNo: number;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  @Default(1)
  declare quantity: CreationOptional<number>;

  @Attribute(DataTypes.STRING(40))
  @NotNull
  declare product_sku: string;

  @Attribute(DataTypes.UUID)
  @PrimaryKey
  declare order_id: string;

  @BelongsTo(() => Product, {
    foreignKey: { name: 'product_sku', onDelete: 'NO ACTION' },
  })
  declare product?: NonAttribute<Product>;

  @BelongsTo(() => Order, {
    foreignKey: { name: 'order_id', onDelete: 'NO ACTION' },
    inverse: { type: 'hasMany', as: 'items' },
  })
  declare order?: NonAttribute<Order>;
}

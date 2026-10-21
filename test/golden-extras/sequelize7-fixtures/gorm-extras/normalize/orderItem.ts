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
  CreatedAt,
  Default,
  NotNull,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { Order } from './order.js';
import { Product } from './product.js';

@Table({ tableName: 'order_item', timestamps: true, underscored: true })
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

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.STRING(40))
  @NotNull
  declare productSku: string;

  @Attribute(DataTypes.UUID)
  @PrimaryKey
  declare orderId: string;

  @BelongsTo(() => Product, {
    foreignKey: { name: 'productSku', onDelete: 'NO ACTION' },
  })
  declare product?: NonAttribute<Product>;

  @BelongsTo(() => Order, {
    foreignKey: { name: 'orderId', onDelete: 'NO ACTION' },
    inverse: { type: 'hasMany', as: 'items' },
  })
  declare order?: NonAttribute<Order>;
}

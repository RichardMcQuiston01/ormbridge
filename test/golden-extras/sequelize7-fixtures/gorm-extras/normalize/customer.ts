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
  ColumnName,
  CreatedAt,
  Default,
  NotNull,
  PrimaryKey,
  Table,
  Unique,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import type { Order } from './order.js';

@Table({
  tableName: 'customer',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['deleted_at'] },
  ],
})
export class Customer extends Model<
  InferAttributes<Customer>,
  InferCreationAttributes<Customer>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.DATE)
  declare deletedAt: CreationOptional<Date | null>;

  @Attribute(DataTypes.STRING(255))
  @NotNull
  @Unique
  declare email: string;

  @Attribute(DataTypes.STRING(100))
  declare name: CreationOptional<string | null>;

  @Attribute(DataTypes.ENUM('customer', 'staff', 'admin'))
  @NotNull
  @Default('customer')
  declare role: CreationOptional<'customer' | 'staff' | 'admin'>;

  @Attribute(DataTypes.STRING(120))
  @NotNull
  declare billingStreet: string;

  @Attribute(DataTypes.STRING(60))
  @NotNull
  declare billingCity: string;

  @Attribute(DataTypes.STRING(12))
  @ColumnName('billing_zip')
  declare billingPostal: CreationOptional<string | null>;

  @Attribute(DataTypes.STRING(120))
  @NotNull
  declare shippingStreet: string;

  @Attribute(DataTypes.STRING(60))
  @NotNull
  declare shippingCity: string;

  @Attribute(DataTypes.STRING(12))
  @ColumnName('shipping_zip')
  declare shippingPostal: CreationOptional<string | null>;

  @Attribute(DataTypes.DECIMAL(12, 2))
  @NotNull
  @Default(0)
  declare balance: CreationOptional<string>;

  @Attribute(DataTypes.BIGINT)
  @NotNull
  declare rank: string;

  @Attribute(DataTypes.BLOB)
  @NotNull
  declare avatar: Buffer;

  @Attribute(DataTypes.JSONB)
  @NotNull
  declare settings: unknown;

  declare orders?: NonAttribute<Order[]>;
}

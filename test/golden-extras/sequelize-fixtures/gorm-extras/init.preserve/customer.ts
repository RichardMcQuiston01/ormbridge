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

export class Customer extends Model<
  InferAttributes<Customer>,
  InferCreationAttributes<Customer>
> {
  declare id: CreationOptional<string>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date | null>;
  declare email: string;
  declare name: CreationOptional<string | null>;
  declare role: CreationOptional<'customer' | 'staff' | 'admin'>;
  declare billingStreet: string;
  declare billingCity: string;
  declare billingPostal: CreationOptional<string | null>;
  declare shippingStreet: string;
  declare shippingCity: string;
  declare shippingPostal: CreationOptional<string | null>;
  declare balance: CreationOptional<string>;
  declare rank: string;
  declare avatar: Buffer;
  declare settings: unknown;

  declare orders?: NonAttribute<Order[]>;

  static initModel(sequelize: Sequelize): typeof Customer {
    Customer.init(
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: DataTypes.DATE,
        email: { type: DataTypes.STRING(255), allowNull: false, unique: true },
        name: DataTypes.STRING(100),
        role: {
          type: DataTypes.ENUM('customer', 'staff', 'admin'),
          allowNull: false,
          defaultValue: 'customer',
        },
        billingStreet: { type: DataTypes.STRING(120), allowNull: false },
        billingCity: { type: DataTypes.STRING(60), allowNull: false },
        billingPostal: { type: DataTypes.STRING(12), field: 'billing_zip' },
        shippingStreet: { type: DataTypes.STRING(120), allowNull: false },
        shippingCity: { type: DataTypes.STRING(60), allowNull: false },
        shippingPostal: { type: DataTypes.STRING(12), field: 'shipping_zip' },
        balance: {
          type: DataTypes.DECIMAL(12, 2),
          allowNull: false,
          defaultValue: 0,
        },
        rank: { type: DataTypes.BIGINT, allowNull: false },
        avatar: { type: DataTypes.BLOB, allowNull: false },
        settings: { type: DataTypes.JSONB, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Customer',
        tableName: 'customers',
        timestamps: true,
        underscored: true,
        indexes: [
          { fields: ['deleted_at'] },
        ],
      }
    );
    return Customer;
  }
}

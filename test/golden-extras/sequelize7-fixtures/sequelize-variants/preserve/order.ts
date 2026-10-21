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
  AutoIncrement,
  BelongsTo,
  NotNull,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import { Account } from './account.js';

@Table({ tableName: 'Orders', timestamps: false })
export class Order extends Model<
  InferAttributes<Order>,
  InferCreationAttributes<Order>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.DECIMAL(10, 2))
  @NotNull
  declare total: string;

  @Attribute(DataTypes.INTEGER)
  declare auditorId: CreationOptional<number | null>;

  @Attribute(DataTypes.INTEGER)
  declare AccountId: CreationOptional<number | null>;

  @Attribute(DataTypes.INTEGER)
  declare buyerId: CreationOptional<number | null>;

  @Attribute(DataTypes.STRING(120))
  declare referrerEmail: CreationOptional<string | null>;

  @BelongsTo(() => Account, {
    foreignKey: { name: 'AccountId', onDelete: 'SET NULL' },
    inverse: { type: 'hasMany', as: 'orders' },
  })
  declare account?: NonAttribute<Account>;

  @BelongsTo(() => Account, {
    foreignKey: { name: 'buyerId', onDelete: 'SET NULL' },
  })
  declare buyer?: NonAttribute<Account>;

  @BelongsTo(() => Account, {
    foreignKey: { name: 'referrerEmail', onDelete: 'RESTRICT' },
    targetKey: 'email',
  })
  declare referrer?: NonAttribute<Account>;
}

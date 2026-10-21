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
import { Account } from './account.js';

@Table({ tableName: 'order', timestamps: true, underscored: true })
export class Order extends Model<
  InferAttributes<Order>,
  InferCreationAttributes<Order>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.DECIMAL(10, 2))
  @NotNull
  declare total: string;

  @Attribute(DataTypes.INTEGER)
  declare auditorId: CreationOptional<number | null>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.UUID)
  declare accountId: CreationOptional<string | null>;

  @Attribute(DataTypes.UUID)
  declare buyerId: CreationOptional<string | null>;

  @Attribute(DataTypes.STRING(120))
  declare referrerEmail: CreationOptional<string | null>;

  @BelongsTo(() => Account, {
    foreignKey: { name: 'accountId', onDelete: 'SET NULL' },
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

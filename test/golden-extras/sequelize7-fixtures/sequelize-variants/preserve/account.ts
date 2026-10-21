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

@Table({ tableName: 'Accounts', timestamps: true })
export class Account extends Model<
  InferAttributes<Account>,
  InferCreationAttributes<Account>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(120))
  @NotNull
  @Unique('account_email_unique')
  declare email: string;

  @Attribute(DataTypes.DECIMAL(10, 2))
  @NotNull
  @Default(0)
  declare balance: CreationOptional<string>;

  @Attribute(DataTypes.JSONB)
  @Default({})
  declare settings: CreationOptional<unknown | null>;

  @Attribute(DataTypes.STRING(255))
  declare nickname: CreationOptional<string | null>;

  @Attribute(DataTypes.STRING(8))
  @ColumnName('legacy_code')
  declare legacyCode: CreationOptional<string | null>;

  @Attribute(DataTypes.DATE)
  @Default(DataTypes.NOW)
  declare lastSeen: CreationOptional<Date | null>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  declare orders?: NonAttribute<Order[]>;
}

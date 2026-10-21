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
  ColumnName,
  NotNull,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import { Account } from './account.js';

@Table({ tableName: 'LEGACY_ORDER', timestamps: false })
export class LegacyOrder extends Model<
  InferAttributes<LegacyOrder>,
  InferCreationAttributes<LegacyOrder>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @ColumnName('OrderNo')
  declare order_no: number;

  @Attribute(DataTypes.TEXT)
  @NotNull
  @ColumnName('kind')
  declare type: string;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  @ColumnName('http_code')
  declare HTTPCode: number;

  @Attribute(DataTypes.TEXT)
  @ColumnName('first name')
  declare first_name: CreationOptional<string | null>;

  @Attribute(DataTypes.INTEGER)
  declare acct: CreationOptional<number | null>;

  @BelongsTo(() => Account, {
    foreignKey: { name: 'acct', onDelete: 'NO ACTION' },
  })
  declare owner?: NonAttribute<Account>;
}

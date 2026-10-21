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
  CreatedAt,
  NotNull,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { Account } from './account.js';

@Table({ tableName: 'legacy_order', timestamps: true, underscored: true })
export class LegacyOrder extends Model<
  InferAttributes<LegacyOrder>,
  InferCreationAttributes<LegacyOrder>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  declare orderNo: number;

  @Attribute(DataTypes.TEXT)
  @NotNull
  @ColumnName('kind')
  declare type: string;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare httpCode: number;

  @Attribute(DataTypes.TEXT)
  declare firstName: CreationOptional<string | null>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.UUID)
  declare acct: CreationOptional<string | null>;

  @BelongsTo(() => Account, {
    foreignKey: { name: 'acct', onDelete: 'NO ACTION' },
  })
  declare owner?: NonAttribute<Account>;
}

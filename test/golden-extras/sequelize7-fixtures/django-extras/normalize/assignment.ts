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
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { Account } from './account.js';
import { Item } from './item.js';

@Table({ tableName: 'assignment', timestamps: true, underscored: true })
export class Assignment extends Model<
  InferAttributes<Assignment>,
  InferCreationAttributes<Assignment>
> {
  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.UUID)
  @PrimaryKey
  declare itemId: string;

  @Attribute(DataTypes.UUID)
  @PrimaryKey
  declare accountId: string;

  @BelongsTo(() => Item, {
    foreignKey: { name: 'itemId', onDelete: 'CASCADE' },
  })
  declare item?: NonAttribute<Item>;

  @BelongsTo(() => Account, {
    foreignKey: { name: 'accountId', onDelete: 'CASCADE' },
  })
  declare account?: NonAttribute<Account>;
}

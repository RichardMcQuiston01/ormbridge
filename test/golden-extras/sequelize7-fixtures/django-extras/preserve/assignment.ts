import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from '@sequelize/core';
import {
  Attribute,
  BelongsTo,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import { Account } from './account.js';
import { Item } from './item.js';

@Table({ tableName: 'blog_assignment', timestamps: false })
export class Assignment extends Model<
  InferAttributes<Assignment>,
  InferCreationAttributes<Assignment>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  declare item_id: number;

  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  declare account_id: number;

  @BelongsTo(() => Item, {
    foreignKey: { name: 'item_id', onDelete: 'CASCADE' },
  })
  declare item?: NonAttribute<Item>;

  @BelongsTo(() => Account, {
    foreignKey: { name: 'account_id', onDelete: 'CASCADE' },
  })
  declare account?: NonAttribute<Account>;
}

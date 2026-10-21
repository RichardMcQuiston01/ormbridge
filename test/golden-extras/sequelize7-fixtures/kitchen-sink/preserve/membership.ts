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
  NotNull,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import { Account } from './account.js';
import { Group } from './group.js';

@Table({ tableName: 'memberships', timestamps: false })
export class Membership extends Model<
  InferAttributes<Membership>,
  InferCreationAttributes<Membership>
> {
  @Attribute(DataTypes.ENUM('owner', 'member'))
  @NotNull
  declare role: 'owner' | 'member';

  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  declare account_id: number;

  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  declare group_id: number;

  @BelongsTo(() => Account, {
    foreignKey: { name: 'account_id', onDelete: 'CASCADE' },
  })
  declare account?: NonAttribute<Account>;

  @BelongsTo(() => Group, {
    foreignKey: { name: 'group_id', onDelete: 'RESTRICT' },
  })
  declare group?: NonAttribute<Group>;
}

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
  Default,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import { Account } from './account.js';
import { Group } from './group.js';

@Table({ tableName: 'Memberships', timestamps: false })
export class Membership extends Model<
  InferAttributes<Membership>,
  InferCreationAttributes<Membership>
> {
  @Attribute(DataTypes.STRING(20))
  @Default('member')
  declare role: CreationOptional<string | null>;

  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  declare AccountId: number;

  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  declare GroupId: number;

  @BelongsTo(() => Account, {
    foreignKey: { name: 'AccountId', onDelete: 'CASCADE' },
  })
  declare account?: NonAttribute<Account>;

  @BelongsTo(() => Group, {
    foreignKey: { name: 'GroupId', onDelete: 'CASCADE' },
  })
  declare group?: NonAttribute<Group>;
}

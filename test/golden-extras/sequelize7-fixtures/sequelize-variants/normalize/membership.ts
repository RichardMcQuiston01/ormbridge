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
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { Account } from './account.js';
import { Group } from './group.js';

@Table({ tableName: 'membership', timestamps: true, underscored: true })
export class Membership extends Model<
  InferAttributes<Membership>,
  InferCreationAttributes<Membership>
> {
  @Attribute(DataTypes.STRING(20))
  @Default('member')
  declare role: CreationOptional<string | null>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.UUID)
  @PrimaryKey
  declare accountId: string;

  @Attribute(DataTypes.UUID)
  @PrimaryKey
  declare groupId: string;

  @BelongsTo(() => Account, {
    foreignKey: { name: 'accountId', onDelete: 'CASCADE' },
  })
  declare account?: NonAttribute<Account>;

  @BelongsTo(() => Group, {
    foreignKey: { name: 'groupId', onDelete: 'CASCADE' },
  })
  declare group?: NonAttribute<Group>;
}

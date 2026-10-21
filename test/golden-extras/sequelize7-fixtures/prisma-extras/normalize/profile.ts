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
  NotNull,
  PrimaryKey,
  Table,
  Unique,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { Account } from './account.js';

@Table({
  tableName: 'profile',
  schema: 'public',
  timestamps: true,
  underscored: true,
})
export class Profile extends Model<
  InferAttributes<Profile>,
  InferCreationAttributes<Profile>
> {
  @Attribute(DataTypes.STRING)
  @PrimaryKey
  declare region: string;

  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  declare number: number;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.UUID)
  @NotNull
  @Unique
  declare accountId: string;

  @BelongsTo(() => Account, {
    foreignKey: { name: 'accountId', onDelete: 'RESTRICT' },
    inverse: { type: 'hasOne', as: 'profile' },
  })
  declare account?: NonAttribute<Account>;
}

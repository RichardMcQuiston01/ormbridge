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
  Unique,
} from '@sequelize/core/decorators-legacy';
import { Account } from './account.js';

@Table({ tableName: 'Profile', schema: 'public', timestamps: false })
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

  @Attribute(DataTypes.INTEGER)
  @NotNull
  @Unique
  declare accountId: number;

  @BelongsTo(() => Account, {
    foreignKey: { name: 'accountId', onDelete: 'RESTRICT' },
    inverse: { type: 'hasOne', as: 'profile' },
  })
  declare account?: NonAttribute<Account>;
}

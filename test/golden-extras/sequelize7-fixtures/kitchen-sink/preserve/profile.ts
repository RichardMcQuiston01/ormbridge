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
  BelongsTo,
  NotNull,
  PrimaryKey,
  Table,
  Unique,
} from '@sequelize/core/decorators-legacy';
import { Account } from './account.js';

@Table({ tableName: 'profiles', timestamps: false })
export class Profile extends Model<
  InferAttributes<Profile>,
  InferCreationAttributes<Profile>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.TEXT)
  declare bio: CreationOptional<string | null>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  @Unique
  declare owner_account_id: number;

  @BelongsTo(() => Account, {
    foreignKey: { name: 'owner_account_id', onDelete: 'CASCADE' },
    inverse: { type: 'hasOne', as: 'profile' },
  })
  declare owner?: NonAttribute<Account>;
}

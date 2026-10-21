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
  NotNull,
  PrimaryKey,
  Table,
  Unique,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { Account } from './account.js';

@Table({ tableName: 'profile', timestamps: true, underscored: true })
export class Profile extends Model<
  InferAttributes<Profile>,
  InferCreationAttributes<Profile>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.TEXT)
  declare bio: CreationOptional<string | null>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.UUID)
  @NotNull
  @Unique
  declare ownerAccountId: string;

  @BelongsTo(() => Account, {
    foreignKey: { name: 'ownerAccountId', onDelete: 'CASCADE' },
    inverse: { type: 'hasOne', as: 'profile' },
  })
  declare owner?: NonAttribute<Account>;
}

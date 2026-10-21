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
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { Account } from './account.js';

@Table({
  tableName: 'session',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['account_id', 'opened_at'] },
  ],
})
export class Session extends Model<
  InferAttributes<Session>,
  InferCreationAttributes<Session>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.UUID)
  @Default(DataTypes.UUIDV4)
  declare token: CreationOptional<string | null>;

  @Attribute(DataTypes.DATE)
  declare deletedAt: CreationOptional<Date | null>;

  @Attribute(DataTypes.DATE)
  @NotNull
  @Default(DataTypes.NOW)
  declare openedAt: CreationOptional<Date>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.UUID)
  declare accountId: CreationOptional<string | null>;

  @BelongsTo(() => Account, {
    foreignKey: { name: 'accountId', onDelete: 'SET NULL' },
    inverse: { type: 'hasMany', as: 'sessions' },
  })
  declare account?: NonAttribute<Account>;
}

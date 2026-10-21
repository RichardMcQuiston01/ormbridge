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
  NotNull,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import { Account } from './account.js';

@Table({
  tableName: 'sessions',
  timestamps: false,
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
  declare deleted_at: CreationOptional<Date | null>;

  @Attribute(DataTypes.DATE)
  @NotNull
  @Default(DataTypes.NOW)
  declare opened_at: CreationOptional<Date>;

  @Attribute(DataTypes.INTEGER)
  declare account_id: CreationOptional<number | null>;

  @BelongsTo(() => Account, {
    foreignKey: { name: 'account_id', onDelete: 'SET NULL' },
    inverse: { type: 'hasMany', as: 'sessions' },
  })
  declare account?: NonAttribute<Account>;
}

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
import type { Profile } from './profile.js';
import { Tenant } from './tenant.js';

@Table({
  tableName: 'account',
  schema: 'public',
  timestamps: true,
  underscored: true,
})
export class Account extends Model<
  InferAttributes<Account>,
  InferCreationAttributes<Account>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.STRING)
  @NotNull
  @Unique('uq_account_email')
  declare email: string;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.UUID)
  @NotNull
  declare tenantId: string;

  @BelongsTo(() => Tenant, {
    foreignKey: { name: 'tenantId', onDelete: 'NO ACTION' },
  })
  declare tenant?: NonAttribute<Tenant>;

  declare profile?: NonAttribute<Profile>;
}

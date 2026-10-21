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
import type { Profile } from './profile.js';
import { Tenant } from './tenant.js';

@Table({ tableName: 'Account', schema: 'public', timestamps: false })
export class Account extends Model<
  InferAttributes<Account>,
  InferCreationAttributes<Account>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING)
  @NotNull
  @Unique('uq_account_email')
  declare email: string;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare tenantId: number;

  @BelongsTo(() => Tenant, {
    foreignKey: { name: 'tenantId', onDelete: 'NO ACTION' },
  })
  declare tenant?: NonAttribute<Tenant>;

  declare profile?: NonAttribute<Profile>;
}

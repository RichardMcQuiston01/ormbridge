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
  CreatedAt,
  Default,
  NotNull,
  PrimaryKey,
  Table,
  Unique,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import type { Profile } from './profile.js';
import type { Session } from './session.js';

@Table({
  tableName: 'accounts',
  timestamps: true,
  indexes: [
    { fields: ['deleted_at'] },
    { fields: ['email', 'status'] },
  ],
})
export class Account extends Model<
  InferAttributes<Account>,
  InferCreationAttributes<Account>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @CreatedAt
  declare readonly created_at: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updated_at: CreationOptional<Date>;

  @Attribute(DataTypes.DATE)
  declare deleted_at: CreationOptional<Date | null>;

  @Attribute(DataTypes.STRING(255))
  @NotNull
  @Unique
  declare email: string;

  @Attribute(DataTypes.DOUBLE)
  @NotNull
  declare balance: number;

  @Attribute(DataTypes.DOUBLE)
  declare score: CreationOptional<number | null>;

  @Attribute(DataTypes.BLOB)
  declare avatar: CreationOptional<Buffer | null>;

  @Attribute(DataTypes.JSON)
  declare payload: CreationOptional<unknown | null>;

  @Attribute(DataTypes.JSON)
  @NotNull
  declare labels: string[];

  @Attribute(DataTypes.INTEGER)
  declare ttl: CreationOptional<number | null>;

  @Attribute(DataTypes.STRING(45))
  declare ip: CreationOptional<string | null>;

  @Attribute(DataTypes.TEXT)
  declare homepage_url: CreationOptional<string | null>;

  @Attribute(DataTypes.DATEONLY)
  declare born: CreationOptional<string | null>;

  @Attribute(DataTypes.TIME)
  declare alarm: CreationOptional<string | null>;

  @Attribute(DataTypes.ENUM('draft', 'live'))
  @NotNull
  @Default('draft')
  declare status: CreationOptional<'draft' | 'live'>;

  @Attribute(DataTypes.TEXT)
  @NotNull
  @Default("it's; fine")
  declare note: CreationOptional<string>;

  declare sessions?: NonAttribute<Session[]>;
  declare profile?: NonAttribute<Profile>;
}

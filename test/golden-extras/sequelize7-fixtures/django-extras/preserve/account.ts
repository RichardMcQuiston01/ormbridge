import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from '@sequelize/core';
import {
  Attribute,
  AutoIncrement,
  NotNull,
  PrimaryKey,
  Table,
  Unique,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'blog_account', timestamps: false })
export class Account extends Model<
  InferAttributes<Account>,
  InferCreationAttributes<Account>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(254))
  @NotNull
  @Unique
  declare email: string;
}

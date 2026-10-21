import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from '@sequelize/core';
import {
  Attribute,
  CreatedAt,
  Default,
  NotNull,
  PrimaryKey,
  Table,
  Unique,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'account', timestamps: true, underscored: true })
export class Account extends Model<
  InferAttributes<Account>,
  InferCreationAttributes<Account>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.STRING(254))
  @NotNull
  @Unique
  declare email: string;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;
}

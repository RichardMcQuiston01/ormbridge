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
  NotNull,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';

@Table({
  tableName: 'order',
  schema: 'public',
  timestamps: true,
  underscored: true,
})
export class Order extends Model<
  InferAttributes<Order>,
  InferCreationAttributes<Order>
> {
  @Attribute(DataTypes.STRING)
  @PrimaryKey
  declare region: string;

  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  declare number: number;

  @Attribute(DataTypes.DECIMAL)
  @NotNull
  declare total: string;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;
}

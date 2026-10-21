import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
} from '@sequelize/core';
import {
  Attribute,
  NotNull,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'Order', schema: 'public', timestamps: false })
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
}

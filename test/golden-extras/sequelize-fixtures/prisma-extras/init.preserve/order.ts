import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Order extends Model<
  InferAttributes<Order>,
  InferCreationAttributes<Order>
> {
  declare region: string;
  declare number: number;
  declare total: string;

  static initModel(sequelize: Sequelize): typeof Order {
    Order.init(
      {
        region: { type: DataTypes.STRING, primaryKey: true },
        number: { type: DataTypes.INTEGER, primaryKey: true },
        total: { type: DataTypes.DECIMAL, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Order',
        tableName: 'Order',
        schema: 'public',
        timestamps: false,
      }
    );
    return Order;
  }
}

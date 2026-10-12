import {
  DataTypes,
  Model,
  type CreationOptional,
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
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): typeof Order {
    Order.init(
      {
        region: { type: DataTypes.STRING, primaryKey: true },
        number: { type: DataTypes.INTEGER, primaryKey: true },
        total: { type: DataTypes.DECIMAL, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Order',
        tableName: 'order',
        schema: 'public',
        timestamps: true,
        underscored: true,
      }
    );
    return Order;
  }
}

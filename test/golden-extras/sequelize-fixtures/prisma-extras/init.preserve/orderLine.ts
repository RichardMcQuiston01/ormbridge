import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class OrderLine extends Model<
  InferAttributes<OrderLine>,
  InferCreationAttributes<OrderLine>
> {
  declare id: CreationOptional<number>;
  declare orderRegion: string;
  declare orderNumber: number;
  declare sku: string;

  static initModel(sequelize: Sequelize): typeof OrderLine {
    OrderLine.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        orderRegion: { type: DataTypes.STRING, allowNull: false },
        orderNumber: { type: DataTypes.INTEGER, allowNull: false },
        sku: { type: DataTypes.STRING(32), allowNull: false },
      },
      {
        sequelize,
        modelName: 'OrderLine',
        tableName: 'OrderLine',
        schema: 'public',
        timestamps: false,
        indexes: [
          { fields: ['orderRegion', 'orderNumber'] },
        ],
      }
    );
    return OrderLine;
  }
}

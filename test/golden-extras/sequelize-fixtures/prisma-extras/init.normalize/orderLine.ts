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
  declare id: CreationOptional<string>;
  declare orderRegion: string;
  declare orderNumber: number;
  declare sku: string;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): typeof OrderLine {
    OrderLine.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        orderRegion: { type: DataTypes.STRING, allowNull: false },
        orderNumber: { type: DataTypes.INTEGER, allowNull: false },
        sku: { type: DataTypes.STRING(32), allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'OrderLine',
        tableName: 'order_line',
        schema: 'public',
        timestamps: true,
        underscored: true,
        indexes: [
          { fields: ['order_region', 'order_number'] },
        ],
      }
    );
    return OrderLine;
  }
}

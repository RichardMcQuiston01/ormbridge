import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Counter extends Model<
  InferAttributes<Counter>,
  InferCreationAttributes<Counter>
> {
  declare smallId: CreationOptional<string>;
  declare label: string;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): typeof Counter {
    Counter.init(
      {
        smallId: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        label: { type: DataTypes.STRING(20), allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Counter',
        tableName: 'counter',
        timestamps: true,
        underscored: true,
      }
    );
    return Counter;
  }
}

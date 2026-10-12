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
  declare small_id: CreationOptional<number>;
  declare label: string;

  static initModel(sequelize: Sequelize): typeof Counter {
    Counter.init(
      {
        small_id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true,
        },
        label: { type: DataTypes.STRING(20), allowNull: false },
      },
      {
        sequelize,
        modelName: 'Counter',
        tableName: 'blog_counter',
        timestamps: false,
      }
    );
    return Counter;
  }
}

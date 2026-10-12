import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Scratch extends Model<
  InferAttributes<Scratch>,
  InferCreationAttributes<Scratch>
> {
  declare id: number;

  static initModel(sequelize: Sequelize): typeof Scratch {
    Scratch.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true },
      },
      {
        sequelize,
        modelName: 'Scratch',
        tableName: 'Scratch',
        schema: 'audit',
        timestamps: false,
      }
    );
    return Scratch;
  }
}

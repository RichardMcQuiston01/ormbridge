import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Scratch extends Model<
  InferAttributes<Scratch>,
  InferCreationAttributes<Scratch>
> {
  declare id: number;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): typeof Scratch {
    Scratch.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Scratch',
        tableName: 'scratch',
        schema: 'audit',
        timestamps: true,
        underscored: true,
      }
    );
    return Scratch;
  }
}

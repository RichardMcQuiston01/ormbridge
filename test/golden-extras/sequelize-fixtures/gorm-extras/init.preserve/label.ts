import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Label extends Model<
  InferAttributes<Label>,
  InferCreationAttributes<Label>
> {
  declare id: CreationOptional<string>;
  declare name: string;

  static initModel(sequelize: Sequelize): typeof Label {
    Label.init(
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        name: { type: DataTypes.STRING(40), allowNull: false, unique: true },
      },
      { sequelize, modelName: 'Label', tableName: 'labels', timestamps: false }
    );
    return Label;
  }
}

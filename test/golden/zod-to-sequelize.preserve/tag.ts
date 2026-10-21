import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Tag extends Model<
  InferAttributes<Tag>,
  InferCreationAttributes<Tag>
> {
  declare id: number;
  declare label: string;

  static initModel(sequelize: Sequelize): typeof Tag {
    Tag.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true },
        label: { type: DataTypes.STRING(50), allowNull: false },
      },
      { sequelize, modelName: 'Tag', tableName: 'Tag', timestamps: false }
    );
    return Tag;
  }
}

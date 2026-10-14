import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Tag extends Model<
  InferAttributes<Tag>,
  InferCreationAttributes<Tag>
> {
  declare id: CreationOptional<number>;
  declare label: CreationOptional<string | null>;

  static initModel(sequelize: Sequelize): typeof Tag {
    Tag.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        label: DataTypes.STRING(40),
      },
      { sequelize, modelName: 'Tag', tableName: 'tags', timestamps: false }
    );
    return Tag;
  }
}

import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class PostTags extends Model<
  InferAttributes<PostTags>,
  InferCreationAttributes<PostTags>
> {
  declare id: number;
  declare post_id: number;
  declare tag_id: number;

  static initModel(sequelize: Sequelize): typeof PostTags {
    PostTags.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true },
        post_id: { type: DataTypes.INTEGER, allowNull: false },
        tag_id: { type: DataTypes.INTEGER, allowNull: false },
      },
      {
        sequelize,
        modelName: 'PostTags',
        tableName: 'PostTags',
        timestamps: false,
      }
    );
    return PostTags;
  }
}

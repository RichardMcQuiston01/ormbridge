import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class PostTags extends Model<
  InferAttributes<PostTags>,
  InferCreationAttributes<PostTags>
> {
  declare id: number;
  declare postId: number;
  declare tagId: number;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): typeof PostTags {
    PostTags.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true },
        postId: { type: DataTypes.INTEGER, allowNull: false },
        tagId: { type: DataTypes.INTEGER, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'PostTags',
        tableName: 'post_tag',
        timestamps: true,
        underscored: true,
      }
    );
    return PostTags;
  }
}

import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { PostTags } from './postTags.js';

export class Tag extends Model<
  InferAttributes<Tag>,
  InferCreationAttributes<Tag>
> {
  declare id: CreationOptional<number>;
  declare label: string;

  declare posts?: NonAttribute<PostTags[]>;

  static initModel(sequelize: Sequelize): typeof Tag {
    Tag.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        label: { type: DataTypes.STRING(50), allowNull: false },
      },
      { sequelize, modelName: 'Tag', tableName: 'blog_tag', timestamps: false }
    );
    return Tag;
  }
}

import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { BlogPost } from './blogPost.js';
import type { BlogProfile } from './blogProfile.js';

export class BlogUser extends Model<
  InferAttributes<BlogUser>,
  InferCreationAttributes<BlogUser>
> {
  declare id: CreationOptional<string>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  declare authorBlogPosts?: NonAttribute<BlogPost[]>;
  declare editorBlogPosts?: NonAttribute<BlogPost[]>;
  declare blogProfile?: NonAttribute<BlogProfile>;

  static initModel(sequelize: Sequelize): typeof BlogUser {
    BlogUser.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'BlogUser',
        tableName: 'blog_user',
        timestamps: true,
        underscored: true,
      }
    );
    return BlogUser;
  }
}

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
  declare id: CreationOptional<number>;

  declare author_blog_posts?: NonAttribute<BlogPost[]>;
  declare editor_blog_posts?: NonAttribute<BlogPost[]>;
  declare blog_profile?: NonAttribute<BlogProfile>;

  static initModel(sequelize: Sequelize): typeof BlogUser {
    BlogUser.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      },
      {
        sequelize,
        modelName: 'BlogUser',
        tableName: 'blog_user',
        timestamps: false,
      }
    );
    return BlogUser;
  }
}

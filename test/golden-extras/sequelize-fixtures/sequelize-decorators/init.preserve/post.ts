import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Author } from './author.js';
import type { Category } from './category.js';

export class Post extends Model<
  InferAttributes<Post>,
  InferCreationAttributes<Post>
> {
  declare id: CreationOptional<number>;
  declare title: string;
  declare slug: string;
  declare status: CreationOptional<string | null>;
  declare publishedAt: CreationOptional<Date | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare authorId: number;
  declare categoryId: CreationOptional<number | null>;

  declare author?: NonAttribute<Author>;
  declare category?: NonAttribute<Category>;

  static initModel(sequelize: Sequelize): typeof Post {
    Post.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        title: { type: DataTypes.STRING(200), allowNull: false },
        slug: { type: DataTypes.STRING(120), allowNull: false },
        status: { type: DataTypes.STRING(20), defaultValue: 'draft' },
        publishedAt: DataTypes.DATE,
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        authorId: { type: DataTypes.INTEGER, allowNull: false },
        categoryId: DataTypes.INTEGER,
      },
      {
        sequelize,
        modelName: 'Post',
        tableName: 'posts',
        timestamps: true,
        indexes: [
          { fields: ['title'] },
          { name: 'posts_author_slug', unique: true, fields: ['slug', 'authorId'] },
          { name: 'posts_status_idx', fields: ['status', 'publishedAt'] },
        ],
      }
    );
    return Post;
  }
}

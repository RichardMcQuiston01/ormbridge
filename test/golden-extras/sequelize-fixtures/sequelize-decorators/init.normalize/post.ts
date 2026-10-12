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
  declare id: CreationOptional<string>;
  declare title: string;
  declare slug: string;
  declare status: CreationOptional<string | null>;
  declare publishedAt: CreationOptional<Date | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare authorId: string;
  declare categoryId: CreationOptional<string | null>;

  declare author?: NonAttribute<Author>;
  declare category?: NonAttribute<Category>;

  static initModel(sequelize: Sequelize): typeof Post {
    Post.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        title: { type: DataTypes.STRING(200), allowNull: false },
        slug: { type: DataTypes.STRING(120), allowNull: false },
        status: { type: DataTypes.STRING(20), defaultValue: 'draft' },
        publishedAt: DataTypes.DATE,
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        authorId: { type: DataTypes.UUID, allowNull: false },
        categoryId: DataTypes.UUID,
      },
      {
        sequelize,
        modelName: 'Post',
        tableName: 'post',
        timestamps: true,
        underscored: true,
        indexes: [
          { fields: ['title'] },
          { name: 'posts_author_slug', unique: true, fields: ['slug', 'author_id'] },
          { name: 'posts_status_idx', fields: ['status', 'published_at'] },
        ],
      }
    );
    return Post;
  }
}

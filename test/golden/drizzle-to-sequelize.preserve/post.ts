import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Category } from './category.js';
import type { PostTag } from './postTag.js';
import type { User } from './user.js';

export class Post extends Model<
  InferAttributes<Post>,
  InferCreationAttributes<Post>
> {
  declare id: CreationOptional<number>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare publicId: CreationOptional<string>;
  declare title: string;
  declare body: string;
  declare status: CreationOptional<'draft' | 'published'>;
  declare rating: CreationOptional<string | null>;
  declare viewCount: CreationOptional<number>;
  declare isFeatured: CreationOptional<boolean>;
  declare publishedAt: CreationOptional<Date>;
  declare metadata: CreationOptional<unknown>;
  declare author_id: number;
  declare editor_id: CreationOptional<number | null>;
  declare category_id: number;

  declare author?: NonAttribute<User>;
  declare editor?: NonAttribute<User>;
  declare category?: NonAttribute<Category>;
  declare tags?: NonAttribute<PostTag[]>;

  static initModel(sequelize: Sequelize): typeof Post {
    Post.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        publicId: {
          type: DataTypes.UUID,
          allowNull: false,
          unique: true,
          defaultValue: DataTypes.UUIDV4,
        },
        title: { type: DataTypes.STRING(200), allowNull: false },
        body: { type: DataTypes.TEXT, allowNull: false },
        status: {
          type: DataTypes.ENUM('draft', 'published'),
          allowNull: false,
          defaultValue: 'draft',
        },
        rating: DataTypes.DECIMAL(4, 2),
        viewCount: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        isFeatured: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        publishedAt: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: DataTypes.NOW,
        },
        metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        author_id: { type: DataTypes.INTEGER, allowNull: false },
        editor_id: DataTypes.INTEGER,
        category_id: { type: DataTypes.INTEGER, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Post',
        tableName: 'blog_post',
        timestamps: true,
        underscored: true,
        indexes: [
          { unique: true, fields: ['author_id', 'title'] },
          { name: 'post_pub_status_idx', fields: ['published_at', 'status'] },
          { fields: ['title'] },
        ],
      }
    );
    return Post;
  }
}

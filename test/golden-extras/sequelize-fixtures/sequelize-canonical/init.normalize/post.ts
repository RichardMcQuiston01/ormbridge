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
import type { Tag } from './tag.js';
import type { User } from './user.js';

export class Post extends Model<
  InferAttributes<Post>,
  InferCreationAttributes<Post>
> {
  declare id: CreationOptional<string>;
  declare publicId: CreationOptional<string>;
  declare title: string;
  declare body: string;
  declare status: CreationOptional<'draft' | 'published'>;
  declare rating: CreationOptional<string | null>;
  declare viewCount: CreationOptional<number>;
  declare isFeatured: CreationOptional<boolean>;
  declare publishedAt: CreationOptional<Date>;
  declare metadata: CreationOptional<unknown>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare authorId: string;
  declare editorId: CreationOptional<string | null>;
  declare categoryId: string;

  declare author?: NonAttribute<User>;
  declare editor?: NonAttribute<User>;
  declare category?: NonAttribute<Category>;
  declare tags?: NonAttribute<Tag[]>;

  static initModel(sequelize: Sequelize): typeof Post {
    Post.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
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
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        authorId: { type: DataTypes.UUID, allowNull: false },
        editorId: DataTypes.UUID,
        categoryId: { type: DataTypes.UUID, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Post',
        tableName: 'post',
        timestamps: true,
        underscored: true,
        indexes: [
          { fields: ['title'] },
          { unique: true, fields: ['author_id', 'title'] },
          { name: 'post_pub_status_idx', fields: ['published_at', 'status'] },
        ],
      }
    );
    return Post;
  }
}

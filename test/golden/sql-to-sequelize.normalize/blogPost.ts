import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { BlogCategory } from './blogCategory.js';
import type { BlogTag } from './blogTag.js';
import type { BlogUser } from './blogUser.js';

export class BlogPost extends Model<
  InferAttributes<BlogPost>,
  InferCreationAttributes<BlogPost>
> {
  declare id: CreationOptional<string>;
  declare readonly createdAt: CreationOptional<Date>;
  declare updatedAt: Date;
  declare publicId: CreationOptional<string>;
  declare title: string;
  declare body: string;
  declare status: CreationOptional<'draft' | 'published'>;
  declare rating: CreationOptional<string | null>;
  declare viewCount: CreationOptional<number>;
  declare isFeatured: CreationOptional<boolean>;
  declare publishedAt: CreationOptional<Date>;
  declare metadata: CreationOptional<unknown>;
  declare authorId: string;
  declare editorId: CreationOptional<string | null>;
  declare categoryId: string;

  declare author?: NonAttribute<BlogUser>;
  declare editor?: NonAttribute<BlogUser>;
  declare category?: NonAttribute<BlogCategory>;
  declare tags?: NonAttribute<BlogTag[]>;

  static initModel(sequelize: Sequelize): typeof BlogPost {
    BlogPost.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
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
        authorId: { type: DataTypes.UUID, allowNull: false },
        editorId: DataTypes.UUID,
        categoryId: { type: DataTypes.UUID, allowNull: false },
      },
      {
        sequelize,
        modelName: 'BlogPost',
        tableName: 'blog_post',
        timestamps: true,
        updatedAt: false,
        underscored: true,
        indexes: [
          {
            name: 'blog_post_author_id_title_key',
            unique: true,
            fields: ['author_id', 'title'],
          },
          { name: 'blog_post_title_idx', fields: ['title'] },
          { name: 'post_pub_status_idx', fields: ['published_at', 'status'] },
        ],
      }
    );
    return BlogPost;
  }
}

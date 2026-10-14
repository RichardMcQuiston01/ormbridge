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
  declare id: CreationOptional<number>;
  declare readonly created_at: CreationOptional<Date>;
  declare updated_at: Date;
  declare public_id: CreationOptional<string>;
  declare title: string;
  declare body: string;
  declare status: CreationOptional<'draft' | 'published'>;
  declare rating: CreationOptional<string | null>;
  declare view_count: CreationOptional<number>;
  declare is_featured: CreationOptional<boolean>;
  declare published_at: CreationOptional<Date>;
  declare metadata: CreationOptional<unknown>;
  declare author_id: number;
  declare editor_id: CreationOptional<number | null>;
  declare category_id: number;

  declare author?: NonAttribute<BlogUser>;
  declare editor?: NonAttribute<BlogUser>;
  declare category?: NonAttribute<BlogCategory>;
  declare tags?: NonAttribute<BlogTag[]>;

  static initModel(sequelize: Sequelize): typeof BlogPost {
    BlogPost.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        created_at: { type: DataTypes.DATE, allowNull: false },
        updated_at: { type: DataTypes.DATE, allowNull: false },
        public_id: {
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
        view_count: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        is_featured: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        published_at: {
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
        modelName: 'BlogPost',
        tableName: 'blog_post',
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: false,
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

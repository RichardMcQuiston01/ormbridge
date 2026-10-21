import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Post extends Model<
  InferAttributes<Post>,
  InferCreationAttributes<Post>
> {
  declare id: number;
  declare readonly created_at: CreationOptional<Date>;
  declare updated_at: Date;
  declare public_id: string;
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

  static initModel(sequelize: Sequelize): typeof Post {
    Post.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true },
        created_at: { type: DataTypes.DATE, allowNull: false },
        updated_at: { type: DataTypes.DATE, allowNull: false },
        public_id: { type: DataTypes.UUID, allowNull: false },
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
        modelName: 'Post',
        tableName: 'Post',
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: false,
      }
    );
    return Post;
  }
}

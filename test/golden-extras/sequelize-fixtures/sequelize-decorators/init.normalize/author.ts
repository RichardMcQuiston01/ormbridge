import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Post } from './post.js';
import type { Profile } from './profile.js';

export class Author extends Model<
  InferAttributes<Author>,
  InferCreationAttributes<Author>
> {
  declare id: CreationOptional<string>;
  declare email: string;
  declare bio: CreationOptional<string | null>;
  declare state: CreationOptional<'active' | 'banned' | null>;
  declare nickname: CreationOptional<string | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date | null>;

  declare profile?: NonAttribute<Profile>;
  declare posts?: NonAttribute<Post[]>;

  static initModel(sequelize: Sequelize): typeof Author {
    Author.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        email: { type: DataTypes.STRING(80), allowNull: false, unique: true },
        bio: DataTypes.TEXT,
        state: {
          type: DataTypes.ENUM('active', 'banned'),
          defaultValue: 'active',
        },
        nickname: DataTypes.STRING(255),
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        deletedAt: DataTypes.DATE,
      },
      {
        sequelize,
        modelName: 'Author',
        tableName: 'author',
        timestamps: true,
        underscored: true,
      }
    );
    return Author;
  }
}

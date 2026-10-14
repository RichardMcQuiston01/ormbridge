import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { BlogUser } from './blogUser.js';

export class BlogProfile extends Model<
  InferAttributes<BlogProfile>,
  InferCreationAttributes<BlogProfile>
> {
  declare id: CreationOptional<string>;
  declare bio: CreationOptional<string | null>;
  declare avatar: CreationOptional<string | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
  declare userId: string;

  declare user?: NonAttribute<BlogUser>;

  static initModel(sequelize: Sequelize): typeof BlogProfile {
    BlogProfile.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        bio: DataTypes.TEXT,
        avatar: DataTypes.STRING(100),
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
        userId: { type: DataTypes.UUID, allowNull: false, unique: true },
      },
      {
        sequelize,
        modelName: 'BlogProfile',
        tableName: 'blog_profile',
        timestamps: true,
        underscored: true,
      }
    );
    return BlogProfile;
  }
}

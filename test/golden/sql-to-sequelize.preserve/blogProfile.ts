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
  declare id: CreationOptional<number>;
  declare bio: CreationOptional<string | null>;
  declare avatar: CreationOptional<string | null>;
  declare user_id: number;

  declare user?: NonAttribute<BlogUser>;

  static initModel(sequelize: Sequelize): typeof BlogProfile {
    BlogProfile.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        bio: DataTypes.TEXT,
        avatar: DataTypes.STRING(100),
        user_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
      },
      {
        sequelize,
        modelName: 'BlogProfile',
        tableName: 'blog_profile',
        timestamps: false,
      }
    );
    return BlogProfile;
  }
}

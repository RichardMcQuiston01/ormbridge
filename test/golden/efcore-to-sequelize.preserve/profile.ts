import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { User } from './user.js';

export class Profile extends Model<
  InferAttributes<Profile>,
  InferCreationAttributes<Profile>
> {
  declare id: CreationOptional<number>;
  declare bio: CreationOptional<string | null>;
  declare avatar: CreationOptional<string | null>;
  declare user_id: number;

  declare user?: NonAttribute<User>;

  static initModel(sequelize: Sequelize): typeof Profile {
    Profile.init(
      {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          field: 'Id',
        },
        bio: { type: DataTypes.TEXT, field: 'Bio' },
        avatar: { type: DataTypes.STRING(100), field: 'Avatar' },
        user_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
      },
      {
        sequelize,
        modelName: 'Profile',
        tableName: 'blog_profile',
        timestamps: false,
      }
    );
    return Profile;
  }
}

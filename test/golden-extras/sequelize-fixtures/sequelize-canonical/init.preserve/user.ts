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

export class User extends Model<
  InferAttributes<User>,
  InferCreationAttributes<User>
> {
  declare id: CreationOptional<number>;

  declare posts?: NonAttribute<Post[]>;
  declare editedPosts?: NonAttribute<Post[]>;
  declare profile?: NonAttribute<Profile>;

  static initModel(sequelize: Sequelize): typeof User {
    User.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      },
      {
        sequelize,
        modelName: 'User',
        tableName: 'auth_user',
        timestamps: false,
      }
    );
    return User;
  }
}

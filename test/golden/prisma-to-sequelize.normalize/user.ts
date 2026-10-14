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
  declare id: CreationOptional<string>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  declare posts?: NonAttribute<Post[]>;
  declare editedPosts?: NonAttribute<Post[]>;
  declare profile?: NonAttribute<Profile>;

  static initModel(sequelize: Sequelize): typeof User {
    User.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'User',
        tableName: 'user',
        timestamps: true,
        underscored: true,
      }
    );
    return User;
  }
}

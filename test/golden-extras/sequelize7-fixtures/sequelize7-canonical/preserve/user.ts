import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from '@sequelize/core';
import {
  Attribute,
  AutoIncrement,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import type { Post } from './post.js';
import type { Profile } from './profile.js';

@Table({ tableName: 'auth_user', timestamps: false })
export class User extends Model<
  InferAttributes<User>,
  InferCreationAttributes<User>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  declare posts?: NonAttribute<Post[]>;
  declare editedPosts?: NonAttribute<Post[]>;
  declare profile?: NonAttribute<Profile>;
}

import { DataTypes, Model } from '@sequelize/core';
import type {
  CreationOptional,
  InferAttributes,
  InferCreationAttributes,
  NonAttribute,
} from '@sequelize/core';
import {
  Attribute,
  AutoIncrement,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import { Post } from './post.js';
import { Profile } from './profile.js';

@Table({ tableName: 'auth_user', timestamps: false })
export class User extends Model<
  InferAttributes<User>,
  InferCreationAttributes<User>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  // The other sides of Post.author, Post.editor and Profile.user (their `inverse` option defines these).
  declare posts?: NonAttribute<Post[]>;
  declare editedPosts?: NonAttribute<Post[]>;
  declare profile?: NonAttribute<Profile>;
}

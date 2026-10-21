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
  CreatedAt,
  Default,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import type { Post } from './post.js';
import type { Profile } from './profile.js';

@Table({ tableName: 'user', timestamps: true, underscored: true })
export class User extends Model<
  InferAttributes<User>,
  InferCreationAttributes<User>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  declare posts?: NonAttribute<Post[]>;
  declare editedPosts?: NonAttribute<Post[]>;
  declare profile?: NonAttribute<Profile>;
}

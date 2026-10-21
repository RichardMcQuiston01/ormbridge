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
  NotNull,
  PrimaryKey,
  Table,
  Unique,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import type { Post } from './post.js';
import type { Profile } from './profile.js';

@Table({ tableName: 'author', timestamps: true, underscored: true })
export class Author extends Model<
  InferAttributes<Author>,
  InferCreationAttributes<Author>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.STRING(80))
  @NotNull
  @Unique
  declare email: string;

  @Attribute(DataTypes.TEXT)
  declare bio: CreationOptional<string | null>;

  @Attribute(DataTypes.ENUM('active', 'banned'))
  @NotNull
  @Default('active')
  declare state: CreationOptional<'active' | 'banned'>;

  @Attribute(DataTypes.UUID)
  @NotNull
  @Unique
  @Default(DataTypes.UUIDV4)
  declare publicId: CreationOptional<string>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.DATE)
  declare deletedAt: CreationOptional<Date | null>;

  declare profile?: NonAttribute<Profile>;
  declare posts?: NonAttribute<Post[]>;
}

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
  BelongsTo,
  NotNull,
  PrimaryKey,
  Table,
  Unique,
} from '@sequelize/core/decorators-legacy';
import { User } from './user.js';

@Table({ tableName: 'blog_profile', timestamps: false })
export class Profile extends Model<
  InferAttributes<Profile>,
  InferCreationAttributes<Profile>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.TEXT)
  declare bio: CreationOptional<string | null>;

  @Attribute(DataTypes.STRING(100))
  declare avatar: CreationOptional<string | null>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  @Unique
  declare user_id: number;

  @BelongsTo(() => User, {
    foreignKey: { name: 'user_id', onDelete: 'CASCADE' },
    inverse: { type: 'hasOne', as: 'profile' },
  })
  declare user?: NonAttribute<User>;
}

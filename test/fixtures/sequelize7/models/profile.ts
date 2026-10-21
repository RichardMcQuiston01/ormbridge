import { DataTypes, Model } from '@sequelize/core';
import type {
  InferAttributes,
  InferCreationAttributes,
  NonAttribute,
} from '@sequelize/core';
import {
  Attribute,
  BelongsTo,
  ColumnName,
  NotNull,
  Table,
  Unique,
} from '@sequelize/core/decorators-legacy';
import { User } from './user.js';

@Table({ tableName: 'blog_profile', timestamps: false })
export class Profile extends Model<
  InferAttributes<Profile>,
  InferCreationAttributes<Profile>
> {
  @Attribute(DataTypes.TEXT)
  declare bio: string | null;

  @Attribute(DataTypes.STRING(100))
  declare avatar: string | null;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  @Unique
  @ColumnName('user_id')
  declare userId: number;

  @BelongsTo(() => User, {
    foreignKey: { name: 'userId', onDelete: 'CASCADE' },
    inverse: { type: 'hasOne', as: 'profile' },
  })
  declare user?: NonAttribute<User>;
}

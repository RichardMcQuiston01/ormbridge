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
  BelongsTo,
  CreatedAt,
  Default,
  NotNull,
  PrimaryKey,
  Table,
  Unique,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import { User } from './user.js';

@Table({ tableName: 'profile', timestamps: true, underscored: true })
export class Profile extends Model<
  InferAttributes<Profile>,
  InferCreationAttributes<Profile>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.TEXT)
  declare bio: CreationOptional<string | null>;

  @Attribute(DataTypes.STRING(100))
  declare avatar: CreationOptional<string | null>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.UUID)
  @NotNull
  @Unique
  declare userId: string;

  @BelongsTo(() => User, {
    foreignKey: { name: 'userId', onDelete: 'CASCADE' },
    inverse: { type: 'hasOne', as: 'profile' },
  })
  declare user?: NonAttribute<User>;
}

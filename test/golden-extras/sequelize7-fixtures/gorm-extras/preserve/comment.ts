import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from '@sequelize/core';
import {
  Attribute,
  AutoIncrement,
  NotNull,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'comments', timestamps: false, underscored: true })
export class Comment extends Model<
  InferAttributes<Comment>,
  InferCreationAttributes<Comment>
> {
  @Attribute(DataTypes.BIGINT)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.TEXT)
  @NotNull
  declare body: string;

  @Attribute(DataTypes.BIGINT)
  @NotNull
  declare ownerId: string;

  @Attribute(DataTypes.STRING(30))
  @NotNull
  declare ownerType: string;
}

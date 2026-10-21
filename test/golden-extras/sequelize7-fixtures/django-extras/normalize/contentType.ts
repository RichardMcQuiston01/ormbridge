import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from '@sequelize/core';
import {
  Attribute,
  CreatedAt,
  Default,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'content_type', timestamps: true, underscored: true })
export class ContentType extends Model<
  InferAttributes<ContentType>,
  InferCreationAttributes<ContentType>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;
}

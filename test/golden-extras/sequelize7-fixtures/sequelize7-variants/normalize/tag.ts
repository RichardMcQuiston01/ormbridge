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
  NotNull,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'tag', timestamps: true, underscored: true })
export class Tag extends Model<
  InferAttributes<Tag>,
  InferCreationAttributes<Tag>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.STRING(40))
  @NotNull
  declare label: string;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;
}

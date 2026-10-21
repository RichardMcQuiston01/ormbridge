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
  Unique,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'labels', timestamps: false })
export class Label extends Model<
  InferAttributes<Label>,
  InferCreationAttributes<Label>
> {
  @Attribute(DataTypes.BIGINT)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.STRING(40))
  @NotNull
  @Unique
  declare name: string;
}

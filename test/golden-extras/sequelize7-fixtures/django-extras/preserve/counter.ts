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

@Table({ tableName: 'blog_counter', timestamps: false })
export class Counter extends Model<
  InferAttributes<Counter>,
  InferCreationAttributes<Counter>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare small_id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(20))
  @NotNull
  declare label: string;
}

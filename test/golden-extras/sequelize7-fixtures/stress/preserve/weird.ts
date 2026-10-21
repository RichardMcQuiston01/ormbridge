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
  ColumnName,
  Default,
  NotNull,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';
import { Other } from './other.js';

@Table({ tableName: 'weird', timestamps: false })
export class Weird extends Model<
  InferAttributes<Weird>,
  InferCreationAttributes<Weird>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.TEXT)
  @NotNull
  @Default('x;y')
  @ColumnName('a;b')
  declare a_b: CreationOptional<string>;

  @Attribute(DataTypes.TEXT)
  @NotNull
  @Default('say "hi"')
  declare quote: CreationOptional<string>;

  @Attribute(DataTypes.TEXT)
  @NotNull
  @Default('a`b')
  declare tick: CreationOptional<string>;

  @Attribute(DataTypes.INTEGER)
  declare self_id: CreationOptional<number | null>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare other_id: number;

  @BelongsTo(() => Weird, {
    foreignKey: { name: 'self_id', onDelete: 'SET NULL' },
  })
  declare self?: NonAttribute<Weird>;

  @BelongsTo(() => Other, {
    foreignKey: { name: 'other_id', onDelete: 'CASCADE' },
    inverse: { type: 'hasMany', as: 'weirds' },
  })
  declare other?: NonAttribute<Other>;
}

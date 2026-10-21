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
  HasMany,
  NotNull,
  PrimaryKey,
  Table,
  Unique,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'series', timestamps: false })
export class Series extends Model<
  InferAttributes<Series>,
  InferCreationAttributes<Series>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(20))
  @NotNull
  @Unique('series_handle_uq')
  declare handle: string;

  @Attribute(DataTypes.INTEGER)
  declare parent_id: CreationOptional<number | null>;

  @HasMany(() => Series, {
    foreignKey: { name: 'parent_id', onDelete: 'SET NULL' },
    inverse: 'parent',
  })
  declare children?: NonAttribute<Series[]>;

  declare parent?: NonAttribute<Series>;
}

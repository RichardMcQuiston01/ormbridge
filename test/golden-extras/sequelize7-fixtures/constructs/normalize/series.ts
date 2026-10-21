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
  CreatedAt,
  Default,
  HasMany,
  NotNull,
  PrimaryKey,
  Table,
  Unique,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'series', timestamps: true, underscored: true })
export class Series extends Model<
  InferAttributes<Series>,
  InferCreationAttributes<Series>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.STRING(20))
  @NotNull
  @Unique('series_handle_uq')
  declare handle: string;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.UUID)
  declare parentId: CreationOptional<string | null>;

  @HasMany(() => Series, {
    foreignKey: { name: 'parentId', onDelete: 'SET NULL' },
    inverse: 'parent',
  })
  declare children?: NonAttribute<Series[]>;

  declare parent?: NonAttribute<Series>;
}

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
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'categories', timestamps: false })
export class Category extends Model<
  InferAttributes<Category>,
  InferCreationAttributes<Category>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(60))
  @NotNull
  declare name: string;

  @Attribute(DataTypes.INTEGER)
  declare parentId: CreationOptional<number | null>;

  @HasMany(() => Category, {
    foreignKey: { name: 'parentId', onDelete: 'SET NULL' },
    inverse: 'parent',
  })
  declare children?: NonAttribute<Category[]>;

  declare parent?: NonAttribute<Category>;
}

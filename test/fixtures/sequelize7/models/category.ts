import { DataTypes, Model } from '@sequelize/core';
import type {
  CreationOptional,
  InferAttributes,
  InferCreationAttributes,
  NonAttribute,
} from '@sequelize/core';
import {
  Attribute,
  HasMany,
  NotNull,
  Table,
  Unique,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'blog_category', underscored: true })
export class Category extends Model<
  InferAttributes<Category>,
  InferCreationAttributes<Category>
> {
  @Attribute(DataTypes.STRING(100))
  @NotNull
  @Unique
  declare name: string;

  @Attribute(DataTypes.STRING(50))
  @NotNull
  declare slug: string;

  @Attribute(DataTypes.INTEGER)
  declare parentId: CreationOptional<number | null>;

  // A self reference has to be declared from the HasMany side: Sequelize 7 cannot create the HasMany of a
  // self-referencing BelongsTo from its `inverse` option.
  @HasMany(() => Category, {
    foreignKey: { name: 'parentId', onDelete: 'SET NULL' },
    inverse: 'parent',
  })
  declare children?: NonAttribute<Category[]>;

  declare parent?: NonAttribute<Category>;
}

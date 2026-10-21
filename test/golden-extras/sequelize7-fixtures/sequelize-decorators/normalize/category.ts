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
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';
import type { Post } from './post.js';

@Table({ tableName: 'category', timestamps: true, underscored: true })
export class Category extends Model<
  InferAttributes<Category>,
  InferCreationAttributes<Category>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.STRING(60))
  declare name: CreationOptional<string | null>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.UUID)
  declare parentId: CreationOptional<string | null>;

  declare posts?: NonAttribute<Post[]>;

  @HasMany(() => Category, {
    foreignKey: { name: 'parentId', onDelete: 'SET NULL' },
    inverse: 'parent',
  })
  declare children?: NonAttribute<Category[]>;

  declare parent?: NonAttribute<Category>;
}
